import Fastify from 'fastify';
import pg from 'pg';
import fastifyCompress from '@fastify/compress';

const { Pool } = pg;

// Session storage to maintain context between requests (mimicking Neon's architecture)
const sessionStorage = new Map();

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
    timestamp: true,
    serializers: {
      req: (req) => {
        return {
          method: req.method,
          url: req.url,
          path: req.routerPath,
          parameters: req.params,
        };
      }
    }
  },
  trustProxy: true,
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
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-ID, Neon-Connection-String, Neon-Raw-Text-Output, Neon-Array-Mode, Neon-Batch-Isolation-Level, Neon-Batch-Read-Only, Neon-Batch-Deferrable');
  
  if (request.method === 'OPTIONS') {
    reply.code(204).send();
  }
});

// Root route to provide info about the service
app.get('/', async () => {
  return {
    name: 'PostgreSQL HTTP Proxy',
    version: '1.1.0',
    endpoints: [
      { path: '/query', method: 'POST', description: 'Execute SQL queries' },
      { path: '/transaction', method: 'POST', description: 'Execute transactions' },
      { path: '/health', method: 'GET', description: 'Health check endpoint' }
    ],
    documentation: 'https://github.com/samuellembke/drizzle-edge-pg-proxy-client'
  };
});

// Consistent with connection pooling approaches used by Neon and other database proxies
function getClientIdentifier(request) {
  // Primary connection identifier - authorization token as stable identifier
  const authHeader = request.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  
  // Primary identifier - use X-Session-ID header if provided
  // This matches Neon's implementation which uses a UUID session ID
  const sessionId = request.headers['x-session-id'];
  if (sessionId) {
    return `session:${sessionId}`;
  }
  
  // Auth token is the most reliable identifier for requests from the same client
  if (token) {
    return `auth:${token}`;
  }
  
  // Fallback to connection-based identification when no auth token
  const clientIp = request.ip || request.headers['x-forwarded-for'] || 'unknown-ip';
  const userAgent = request.headers['user-agent'] || '';
  
  return `conn:${clientIp}:${userAgent.substring(0, 30)}`;
}

// Helper to create or get a session for this client
function getOrCreateSession(request) {
  const clientId = getClientIdentifier(request);
  if (!sessionStorage.has(clientId)) {
    sessionStorage.set(clientId, {
      lastActivity: Date.now(),
      returningValues: new Map(), // Store values from RETURNING clauses
      latestTableData: new Map()  // Store latest table data by table name
    });
  } else {
    // Update last activity
    const session = sessionStorage.get(clientId);
    session.lastActivity = Date.now();
  }
  
  return sessionStorage.get(clientId);
}

// Clean up old sessions periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  const expiryTime = 30 * 60 * 1000; // 30 minutes
  
  for (const [clientId, session] of sessionStorage.entries()) {
    if (now - session.lastActivity > expiryTime) {
      sessionStorage.delete(clientId);
      app.log.info({ clientId }, 'Session expired and removed');
    }
  }
}, 5 * 60 * 1000);

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
    return { 
      status: 'ok',
      database: 'disconnected',
      message: 'Application is running but database connection failed'
    };
  }
});

// Helper function to format PostgreSQL errors like Neon does
function formatPostgresError(error) {
  if (!error) return { error: 'Unknown database error' };
  
  // Extract all PostgreSQL specific error fields
  const errorResponse = {
    message: error.message,
    severity: error.severity,
    code: error.code,
    detail: error.detail,
    hint: error.hint,
    position: error.position,
    internalPosition: error.internalPosition,
    internalQuery: error.internalQuery,
    where: error.where,
    schema: error.schema,
    table: error.table,
    column: error.column,
    dataType: error.dataType,
    constraint: error.constraint,
    file: error.file,
    line: error.line,
    routine: error.routine
  };
  
  // Remove undefined fields to make the response cleaner
  for (const key in errorResponse) {
    if (errorResponse[key] === undefined) {
      delete errorResponse[key];
    }
  }
  
  return errorResponse;
}

// Format query results to match Neon's response format
function formatQueryResult(result, rawTextOutput = false) {
  if (!result) return null;
  
  const fields = result.fields.map(field => ({
    name: field.name,
    dataTypeID: field.dataTypeID,
    tableID: field.tableID,
    columnID: field.columnID,
    dataTypeSize: field.dataTypeSize,
    dataTypeModifier: field.dataTypeModifier,
    format: field.format
  }));
  
  // Extract command type
  let command = 'SELECT';
  if (result.command) {
    command = result.command;
  }
  
  return {
    command,
    rowCount: result.rowCount,
    fields,
    rows: result.rows,
    rowAsArray: false // Default to object mode
  };
}

// Query endpoint
app.post('/query', async (request, reply) => {
  // Get client session for context persistence (matching Neon's architecture)
  const session = getOrCreateSession(request);
  
  let { sql, params = [], method = 'all' } = request.body;
  const rawTextOutput = request.headers['neon-raw-text-output'] === 'true';
  const arrayMode = request.headers['neon-array-mode'] === 'true';

  if (!sql) {
    return reply.code(400).send({ error: 'SQL query is required' });
  }

  // Check if the method is valid
  if (method !== 'all' && method !== 'single') {
    return reply.code(400).send({ error: 'Invalid method. Use "all" or "single".' });
  }

  try {
    // Execute the query
    const result = await pool.query(sql, params);
    
    // Log session info for debugging
    app.log.debug({
      sessionId: request.headers['x-session-id'],
      clientId: getClientIdentifier(request)
    }, 'Query with session information');
    
    // Return the appropriate result based on the method and format
    if (rawTextOutput) {
      // Return formatted result like Neon does
      const formattedResult = formatQueryResult(result, rawTextOutput);
      formattedResult.rowAsArray = arrayMode; // Set the array mode based on header
      return formattedResult;
    } else {
      // Return simpler format for compatibility with existing clients
      if (method === 'single') {
        return result.rows[0] || null;
      }
      return result.rows;
    }
  } catch (error) {
    // Enhanced error logging with detailed information
    app.log.error({ 
      error, 
      sql, 
      params,
      sessionId: request.headers['x-session-id']
    }, 'Database query error');
    
    // Format PostgreSQL error like Neon does
    return reply.code(400).send(formatPostgresError(error));
  }
});

// Transaction endpoint
app.post('/transaction', async (request, reply) => {
  // Get client session for context persistence
  const session = getOrCreateSession(request);
  
  const { queries } = request.body;
  const rawTextOutput = request.headers['neon-raw-text-output'] === 'true';
  const arrayMode = request.headers['neon-array-mode'] === 'true';
  
  // Get transaction isolation level from headers
  const isolationLevel = request.headers['neon-batch-isolation-level'];
  const readOnly = request.headers['neon-batch-read-only'] === 'true';
  const deferrable = request.headers['neon-batch-deferrable'] === 'true';

  if (!queries || !Array.isArray(queries)) {
    return reply.code(400).send({ error: 'An array of queries is required' });
  }
  
  // Enhanced transaction logging
  app.log.info({ 
    queryCount: queries.length,
    isolationLevel,
    readOnly,
    deferrable,
    sessionId: request.headers['x-session-id']
  }, 'Starting transaction');

  // Get a client from the pool
  const client = await pool.connect();

  try {
    // Start a transaction with proper isolation level if specified
    let beginQuery = 'BEGIN';
    
    if (isolationLevel) {
      beginQuery += ` ISOLATION LEVEL ${isolationLevel.replace(/([A-Z])/g, ' $1').trim().toUpperCase()}`;
    }
    
    if (readOnly) {
      beginQuery += ' READ ONLY';
    } else {
      beginQuery += ' READ WRITE';
    }
    
    if (deferrable && readOnly && isolationLevel === 'Serializable') {
      beginQuery += ' DEFERRABLE';
    } else if (isolationLevel === 'Serializable') {
      beginQuery += ' NOT DEFERRABLE';
    }
    
    app.log.info({ beginQuery }, 'Starting transaction with isolation level');
    await client.query(beginQuery);

    // Execute all queries in the transaction
    const results = [];
    
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      const { sql, params = [], method = 'all' } = query;
      
      try {
        const result = await client.query(sql, params);
        
        // Format and add result to results array
        const formattedResult = formatQueryResult(result, rawTextOutput);
        formattedResult.rowAsArray = arrayMode;
        results.push(method === 'single' && !rawTextOutput ? result.rows[0] || null : formattedResult);
      } catch (error) {
        // Rollback on any error
        await client.query('ROLLBACK');
        client.release();
        
        // Log error with session info
        app.log.error({
          error,
          query: sql,
          params,
          sessionId: request.headers['x-session-id']
        }, 'Transaction query error');
        
        return reply.code(400).send(formatPostgresError(error));
      }
    }
    
    // Commit transaction
    await client.query('COMMIT');
    
    return results;
  } catch (error) {
    // Ensure transaction is rolled back on any error
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      app.log.error({ rollbackError }, 'Error during transaction rollback');
    }
    
    return reply.code(400).send(formatPostgresError(error));
  } finally {
    // Always release the client back to the pool
    client.release();
  }
});

// Start the server
const start = async () => {
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Server listening on ${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
