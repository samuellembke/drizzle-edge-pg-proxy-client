import Fastify from 'fastify';
import pg from 'pg';
import fastifyCompress from '@fastify/compress';

const { Pool } = pg;

// Configuration
const config = {
  port: process.env.PORT || 8080,
  host: '0.0.0.0',
  database: {
    url: process.env.DATABASE_URL,
    pool: {
      min: parseInt(process.env.DB_POOL_MIN || '5', 10),
      max: parseInt(process.env.DB_POOL_MAX || '20', 10),
      idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '10000', 10),
    },
  },
  auth: {
    token: process.env.AUTH_TOKEN,
  },
  enableCompression: process.env.ENABLE_COMPRESSION === 'true',
};

// Logger configuration
const logLevel = process.env.LOG_LEVEL || 'info';

// Create the app
const app = Fastify({
  logger: {
    level: logLevel,
    // Add timestamp to logs
    timestamp: true,
    // Optional: Customize log serialization for better readability of SQL queries
    serializers: {
      req: (req) => {
        return {
          method: req.method,
          url: req.url,
          path: req.routerPath,
          parameters: req.params,
          // Don't log headers or full body for security/privacy
        };
      }
    }
  },
  trustProxy: true,
  // Increase the JSON body size limit if needed
  bodyLimit: 1048576, // 1MB
});

// Enable compression for responses
if (config.enableCompression) {
  await app.register(fastifyCompress);
}

// Check for database connection string
if (!config.database.url) {
  app.log.error('DATABASE_URL environment variable is not set. Please provide a PostgreSQL connection string.');
  process.exit(1);
}

// Create PostgreSQL connection pool
const pool = new Pool({
  connectionString: config.database.url,
  min: config.database.pool.min,
  max: config.database.pool.max,
  idleTimeoutMillis: config.database.pool.idleTimeoutMillis,
});

// Handle pool errors
pool.on('error', (err) => {
  app.log.error('Unexpected error on idle client', err);
  app.log.error('Please check your DATABASE_URL environment variable.');
  // Don't exit the process to allow for recovery
});

// Authentication hook
app.addHook('preHandler', async (request, reply) => {
  // Skip authentication for health check, root path, and OPTIONS requests
  if (request.url === '/health' || request.url === '/' || request.method === 'OPTIONS') {
    return;
  }

  // Skip auth if no token is configured
  if (!config.auth.token) {
    return;
  }

  const authHeader = request.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (config.auth.token !== token) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
});

// CORS middleware
app.addHook('onRequest', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (request.method === 'OPTIONS') {
    reply.code(204).send();
  }
});

// Root route to provide info about the service
app.get('/', async () => {
  return {
    name: 'PostgreSQL HTTP Proxy',
    version: '1.0.0',
    endpoints: [
      { path: '/query', method: 'POST', description: 'Execute SQL queries' },
      { path: '/transaction', method: 'POST', description: 'Execute transactions' },
      { path: '/health', method: 'GET', description: 'Health check endpoint' }
    ],
    documentation: 'https://github.com/samuellembke/drizzle-edge-pg-proxy-client'
  };
});

// Health check route
app.get('/health', async () => {
  // Check if the database connection is healthy
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      return { 
        status: 'ok',
        database: 'connected'
      };
    } finally {
      client.release();
    }
  } catch (error) {
    app.log.warn('Database connection failed in health check:', error.message);
    // Return a 200 status but indicate the database is not connected
    // This allows the container to stay running even if the database is temporarily down
    return { 
      status: 'ok',
      database: 'disconnected',
      message: 'Application is running but database connection failed'
    };
  }
});

// Query endpoint
app.post('/query', async (request, reply) => {
  const { sql, params = [], method = 'all' } = request.body;

  if (!sql) {
    return reply.code(400).send({ error: 'SQL query is required' });
  }

  // Check if the method is valid
  if (method !== 'all' && method !== 'single') {
    return reply.code(400).send({ error: 'Invalid method. Use "all" or "single".' });
  }
  
  // Log query for debugging (helpful for Auth.js issues)
  request.log.debug({ sql, params }, 'Executing query');
  
  // Special handling for Auth.js operations - auto-fix RETURNING clauses
  const isInsert = sql.trim().toUpperCase().startsWith('INSERT');
  const hasReturning = sql.toUpperCase().includes('RETURNING');
  let modifiedSql = sql;
  
  // Auto-add RETURNING clause for Auth.js operations if client hasn't already added it
  if (isInsert && !hasReturning && 
     (sql.includes('user') || sql.includes('account') || sql.includes('session'))) {
    request.log.info('Auth.js operation detected without RETURNING clause - auto-adding RETURNING *');
    modifiedSql = `${sql.trim()} RETURNING *`;
  }

  try {
    // Use the modified SQL with RETURNING * if applicable
    const result = await pool.query(modifiedSql, params);
    
    // Log results for debugging
    request.log.debug({ 
      rowCount: result.rowCount,
      returnedFirstRow: result.rows[0] ? true : false,
      operation: isInsert ? 'INSERT' : 'query'
    }, 'Query completed');

    // Return the appropriate result based on the method
    if (method === 'single') {
      return result.rows[0] || null;
    }
    return result.rows;
  } catch (error) {
    request.log.error({ error, sql: modifiedSql }, 'Database query error');
    return reply.code(500).send({ error: error.message });
  }
});

// Transaction endpoint
app.post('/transaction', async (request, reply) => {
  const { queries } = request.body;

  if (!queries || !Array.isArray(queries)) {
    return reply.code(400).send({ error: 'An array of queries is required' });
  }
  
  // Log transaction details for debugging
  request.log.debug({ queryCount: queries.length }, 'Starting transaction');

  // Get a client from the pool
  const client = await pool.connect();

  try {
    // Start a transaction
    await client.query('BEGIN');

    // Execute all queries
    const results = [];
    
    // Track information about user creation for Auth.js debugging
    let createdUserIds = [];
    let authJsOperationDetected = false;
    
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      const { sql, params = [], method = 'all' } = query;
      
      // Log each query in the transaction
      request.log.debug({ index: i, sql, params }, 'Transaction query');
      
      // Special handling for Auth.js operations
      const isInsert = sql.trim().toUpperCase().startsWith('INSERT');
      const isUserInsert = isInsert && sql.includes('user');
      const isAccountInsert = isInsert && sql.includes('account');
      const hasReturning = sql.toUpperCase().includes('RETURNING');
      
      // Auto-add RETURNING for Auth.js operations
      let modifiedSql = sql;
      
      // Auth.js typically creates a user first, then links accounts
      if (isUserInsert) {
        request.log.info('User creation detected in transaction');
        authJsOperationDetected = true;
        
        // Add RETURNING if needed for user creation
        if (!hasReturning) {
          request.log.info('Auto-adding RETURNING to user creation query');
          modifiedSql = `${sql.trim()} RETURNING *`;
        }
      }
      
      if (isAccountInsert) {
        request.log.info('Account creation detected in transaction');
        
        // Add RETURNING if needed for account creation
        if (!hasReturning) {
          request.log.info('Auto-adding RETURNING to account creation query');
          modifiedSql = `${sql.trim()} RETURNING *`;
        }
        
        if (createdUserIds.length > 0) {
          request.log.debug({ userIds: createdUserIds }, 'User IDs available for linking');
        } else {
          request.log.warn('Account creation without prior user creation detected');
        }
      }
      
      // Execute the query with the potentially modified SQL
      const result = await client.query(modifiedSql, params);
      
      // Handle different result methods
      if (method === 'single') {
        results.push(result.rows[0] || null);
      } else {
        results.push(result.rows);
      }
      
      // Store user IDs from RETURNING clauses for Auth.js debugging
      // This includes both original RETURNING clauses and our auto-added ones
      if (isUserInsert && result.rows.length > 0) {
        const userIds = result.rows.map(row => row.id).filter(Boolean);
        createdUserIds = [...createdUserIds, ...userIds];
        request.log.debug({ newUserIds: userIds }, 'User IDs from RETURNING clause');
      }
    }

    // Commit the transaction
    await client.query('COMMIT');
    
    // Log summary for debugging
    if (authJsOperationDetected) {
      request.log.info({ 
        success: true, 
        queries: queries.length,
        userIds: createdUserIds
      }, 'Auth.js transaction completed');
    }

    return results;
  } catch (error) {
    // Rollback in case of error
    await client.query('ROLLBACK');
    request.log.error({ error }, 'Transaction error');
    return reply.code(500).send({ error: error.message });
  } finally {
    // Release the client back to the pool
    client.release();
  }
});

// Start the server
const start = async () => {
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Server listening on ${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

// Handle graceful shutdown
const shutdown = async () => {
  app.log.info('Shutting down server...');
  await app.close();
  await pool.end();
  app.log.info('Server successfully shut down');
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the server
start();