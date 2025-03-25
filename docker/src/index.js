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

// Query endpoint with enhanced Auth.js support
app.post('/query', async (request, reply) => {
  const { sql, params = [], method = 'all', context = {} } = request.body;

  if (!sql) {
    return reply.code(400).send({ error: 'SQL query is required' });
  }

  // Check if the method is valid
  if (method !== 'all' && method !== 'single') {
    return reply.code(400).send({ error: 'Invalid method. Use "all" or "single".' });
  }
  
  // Log query for debugging
  request.log.debug({ sql, params, context }, 'Executing query');
  
  // Enhanced detection for Auth.js operations
  const isInsert = sql.trim().toUpperCase().startsWith('INSERT');
  const hasReturning = sql.toUpperCase().includes('RETURNING');
  const isAuthJsOperation = context.isAuthJs || false;
  
  // More specific detection for Auth.js tables
  const isAccountInsert = isInsert && (sql.includes('_account') || sql.includes('account'));
  const isUserInsert = isInsert && (sql.includes('_user') || sql.includes('user'));
  const isSessionQuery = sql.includes('_session') || sql.includes('session');
  
  let modifiedSql = sql;
  let fixedParams = [...params];
  
  // Enhanced handling for Auth.js account inserts with DEFAULT for user_id
  if (isAccountInsert && sql.toLowerCase().includes('user_id') && sql.toLowerCase().includes('default')) {
    request.log.warn('Auth.js account insert with DEFAULT for user_id detected');
    
    try {
      // Look up the most recently inserted user ID to link with this account
      // This assumes Auth.js is creating users first, then accounts (which is typically the case)
      const userLookup = await pool.query(
        "SELECT id FROM users ORDER BY created_at DESC LIMIT 1"
      );
      
      if (userLookup.rows.length > 0) {
        const userId = userLookup.rows[0].id;
        request.log.info(`Found recent user ID: ${userId}, attempting to fix account query`);
        
        // Try to fix the query by replacing DEFAULT with the actual user ID
        const defaultRegex = /\(\s*default\s*,/i;
        if (defaultRegex.test(modifiedSql)) {
          modifiedSql = modifiedSql.replace(defaultRegex, `($1,`);
          
          // Add the user ID as the first parameter and shift all others
          fixedParams = [userId, ...params];
          
          request.log.info({ 
            originalSql: sql,
            modifiedSql,
            userId
          }, 'Modified account query with actual user ID');
        } else {
          request.log.warn('Could not safely replace DEFAULT in query - using original query');
        }
      } else {
        request.log.warn('No recent user found for account linking - this will likely cause a constraint violation');
      }
    } catch (lookupError) {
      request.log.error({ error: lookupError }, 'Error looking up user ID for account linking');
    }
  }
  
  // Auto-add RETURNING clause for Auth.js operations if not already present
  if (isInsert && !hasReturning && (isAuthJsOperation || isAccountInsert || isUserInsert || isSessionQuery)) {
    request.log.info('Auth.js operation detected without RETURNING clause - auto-adding RETURNING *');
    modifiedSql = `${modifiedSql.trim()} RETURNING *`;
  }

  try {
    // Execute the modified query with potentially fixed parameters
    const result = await pool.query(modifiedSql, fixedParams);
    
    // Log results for debugging
    request.log.info({ 
      rowCount: result.rowCount,
      hasRows: result.rows.length > 0,
      operation: isInsert ? 'INSERT' : 'QUERY',
      isAuthJs: isAuthJsOperation || isAccountInsert || isUserInsert || isSessionQuery,
    }, 'Query completed successfully');

    // Return the appropriate result based on the method
    if (method === 'single') {
      return result.rows[0] || null;
    }
    return result.rows;
  } catch (error) {
    request.log.error({ 
      error, 
      sql: modifiedSql,
      params: fixedParams,
      isAuthJs: isAuthJsOperation || isAccountInsert || isUserInsert || isSessionQuery,
    }, 'Database query error');
    
    // For Auth.js errors, provide more context
    if (isAuthJsOperation || isAccountInsert || isUserInsert || isSessionQuery) {
      if (error.message.includes('violates not-null constraint') && error.message.includes('user_id')) {
        return reply.code(500).send({ 
          error: error.message,
          details: {
            type: 'auth_js_error',
            message: 'Auth.js account insert failed - missing user ID. Make sure users are created before accounts.',
            recommendation: 'Check Auth.js adapter implementation or sequence of operations.'
          } 
        });
      }
    }
    
    return reply.code(500).send({ error: error.message });
  }
});

// Transaction endpoint with enhanced Auth.js support
app.post('/transaction', async (request, reply) => {
  const { queries, context = {} } = request.body;

  if (!queries || !Array.isArray(queries)) {
    return reply.code(400).send({ error: 'An array of queries is required' });
  }
  
  // Detect Auth.js operations in the transaction
  const isAuthJsTransaction = context.isAuthJs || 
    queries.some(q => 
      q.sql.includes('_user') || 
      q.sql.includes('_account') || 
      q.sql.includes('_session')
    );
  
  // Log transaction details for debugging
  request.log.info({ 
    queryCount: queries.length, 
    isAuthJs: isAuthJsTransaction 
  }, 'Starting transaction');

  // Get a client from the pool
  const client = await pool.connect();

  try {
    // Start a transaction
    await client.query('BEGIN');

    // Execute all queries
    const results = [];
    
    // Track information about user creation for Auth.js debugging and fixing
    let createdUserIds = [];
    let authJsUserInsertDetected = false;
    let pendingAccountInserts = [];
    
    // First pass - identify the sequence and collect user IDs
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      const { sql } = query;
      
      const isInsert = sql.trim().toUpperCase().startsWith('INSERT');
      const isUserInsert = isInsert && (sql.includes('_user') || sql.includes(' user'));
      const isAccountInsert = isInsert && (sql.includes('_account') || sql.includes(' account'));
      
      if (isUserInsert) {
        authJsUserInsertDetected = true;
      }
      
      if (isAccountInsert && sql.toLowerCase().includes('user_id') && sql.toLowerCase().includes('default')) {
        pendingAccountInserts.push(i);
      }
    }
    
    // Process each query in the transaction
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      const { sql, params = [], method = 'all' } = query;
      
      // Log each query in the transaction
      request.log.debug({ index: i, sql, params }, 'Transaction query');
      
      // Detect operation type
      const isInsert = sql.trim().toUpperCase().startsWith('INSERT');
      const isUserInsert = isInsert && (sql.includes('_user') || sql.includes(' user'));
      const isAccountInsert = isInsert && (sql.includes('_account') || sql.includes(' account'));
      const hasReturning = sql.toUpperCase().includes('RETURNING');
      
      // Prepare modified SQL and parameters
      let modifiedSql = sql;
      let modifiedParams = [...params];
      
      // Auto-add RETURNING for Auth.js operations if needed
      if (isInsert && !hasReturning && (isUserInsert || isAccountInsert || sql.includes('session'))) {
        request.log.info(`Auto-adding RETURNING to query ${i}`);
        modifiedSql = `${sql.trim()} RETURNING *`;
      }
      
      // Fix account inserts with DEFAULT for user_id when we have user IDs
      if (isAccountInsert && sql.toLowerCase().includes('user_id') && sql.toLowerCase().includes('default')) {
        if (createdUserIds.length > 0) {
          const userId = createdUserIds[0]; // Use the most recent user ID
          request.log.info(`Found user ID ${userId} from previous operation for query ${i}`);
          
          // Try different strategies to replace DEFAULT with the user ID parameter
          const defaultRegex = /\(\s*default\s*,/i;
          if (defaultRegex.test(modifiedSql)) {
            // Use parameterized replacement for better security
            modifiedSql = modifiedSql.replace(defaultRegex, `($1,`);
            modifiedParams = [userId, ...params];
            
            request.log.info({ 
              originalSql: sql,
              modifiedSql,
              userId
            }, `Modified account query ${i} with actual user ID`);
          } else {
            // If we can't safely replace with regex, try an alternative approach
            // This is a fallback and may not work for all SQL variants
            request.log.warn(`Could not safely replace DEFAULT in query ${i} - attempting alternative approach`);
            
            // Extract the column names and values structure
            const columnsMatch = sql.match(/insert\s+into\s+\S+\s*\((.*?)\)\s*values/i);
            if (columnsMatch && columnsMatch[1]) {
              const columns = columnsMatch[1].split(',').map(col => col.trim());
              
              // Find the index of user_id column
              const userIdColIndex = columns.findIndex(col => 
                col.toLowerCase() === 'user_id' || 
                col.toLowerCase().includes('"user_id"')
              );
              
              if (userIdColIndex >= 0) {
                request.log.info(`Found user_id at column index ${userIdColIndex}`);
                
                // Create a new query with explicit user ID instead of DEFAULT
                modifiedParams = [...params];
                modifiedParams.splice(userIdColIndex, 0, userId);
                
                // Generate new parameterized SQL with the user ID
                let valuesPart = '(';
                for (let j = 0; j < columns.length; j++) {
                  if (j === userIdColIndex) {
                    valuesPart += `$${j+1}`;
                  } else {
                    // Keep existing parameter reference or DEFAULT
                    const paramMatch = sql.match(new RegExp(`\\$${j+1}`, 'g'));
                    if (paramMatch) {
                      valuesPart += `$${j+1}`;
                    } else {
                      valuesPart += 'DEFAULT';
                    }
                  }
                  
                  if (j < columns.length - 1) {
                    valuesPart += ', ';
                  }
                }
                valuesPart += ')';
                
                modifiedSql = `INSERT INTO ${sql.match(/insert\s+into\s+(\S+)/i)[1]} (${columns.join(', ')}) VALUES ${valuesPart}`;
                if (hasReturning) {
                  modifiedSql += ` ${sql.match(/returning\s+(.*)/i)[0]}`;
                } else {
                  modifiedSql += ' RETURNING *';
                }
                
                request.log.info({
                  originalSql: sql,
                  modifiedSql,
                  userId
                }, `Reconstructed account query ${i} with user ID parameter`);
              }
            }
          }
        } else {
          request.log.warn(`No user IDs available for account query ${i} - this will likely fail`);
        }
      }
      
      // Execute the query with modified SQL and parameters
      request.log.debug({
        index: i,
        sql: modifiedSql,
        params: modifiedParams
      }, 'Executing modified query');
      
      try {
        const result = await client.query(modifiedSql, modifiedParams);
        
        // Store results according to the specified method
        if (method === 'single') {
          results.push(result.rows[0] || null);
        } else {
          results.push(result.rows);
        }
        
        // If this is a user insert, extract and store the user IDs for later account linking
        if (isUserInsert && result.rows.length > 0) {
          const newUserIds = result.rows.map(row => row.id).filter(Boolean);
          if (newUserIds.length > 0) {
            createdUserIds = [...newUserIds, ...createdUserIds]; // Add to the start for newest first
            request.log.info({ userIds: newUserIds }, `Captured user IDs from query ${i}`);
          }
        }
      } catch (queryError) {
        // If this is an account insert that failed due to user_id constraint
        if (isAccountInsert && 
            queryError.message.includes('violates not-null constraint') && 
            queryError.message.includes('user_id')) {
          
          request.log.error({
            error: queryError,
            sql: modifiedSql
          }, `Account insert failed at query ${i} - attempting to recover`);
          
          // Try again with a direct lookup for the most recent user
          try {
            const userLookup = await client.query(
              "SELECT id FROM users ORDER BY created_at DESC LIMIT 1"
            );
            
            if (userLookup.rows.length > 0) {
              const userId = userLookup.rows[0].id;
              request.log.info(`Found user ID ${userId} from database lookup`);
              
              // Replace DEFAULT with $1 and add the user ID as the first parameter
              modifiedSql = modifiedSql.replace(/\(\s*default\s*,/i, `($1,`);
              modifiedParams = [userId, ...params];
              
              // Try again with the fixed query
              const recoveredResult = await client.query(modifiedSql, modifiedParams);
              
              if (method === 'single') {
                results.push(recoveredResult.rows[0] || null);
              } else {
                results.push(recoveredResult.rows);
              }
              
              request.log.info(`Successfully recovered from user_id constraint error in query ${i}`);
            } else {
              // If we can't find a user, we have to fail
              throw queryError;
            }
          } catch (recoveryError) {
            request.log.error({ error: recoveryError }, `Failed to recover from user_id error in query ${i}`);
            throw recoveryError;
          }
        } else {
          // For other errors, we propagate them
          throw queryError;
        }
      }
    }

    // Commit the transaction
    await client.query('COMMIT');
    
    // Log transaction summary
    request.log.info({ 
      success: true, 
      queries: queries.length,
      userIds: createdUserIds,
      isAuthJs: isAuthJsTransaction || authJsUserInsertDetected
    }, 'Transaction completed successfully');

    return results;
  } catch (error) {
    // Rollback in case of error
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      request.log.error({ error: rollbackError }, 'Error during transaction rollback');
    }
    
    request.log.error({ error }, 'Transaction failed');
    
    // Enhanced error reporting for Auth.js
    if (isAuthJsTransaction && error.message.includes('violates not-null constraint') && error.message.includes('user_id')) {
      return reply.code(500).send({ 
        error: error.message,
        details: {
          type: 'auth_js_error',
          message: 'Auth.js account insert failed - missing user ID. Make sure users are created before accounts.',
          recommendation: 'Check Auth.js adapter implementation or table schema.'
        } 
      });
    }
    
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