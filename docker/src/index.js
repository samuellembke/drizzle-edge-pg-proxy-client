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
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Neon-Connection-String, Neon-Raw-Text-Output, Neon-Array-Mode, Neon-Batch-Isolation-Level, Neon-Batch-Read-Only, Neon-Batch-Deferrable');
  
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
  const { sql, params = [], method = 'all' } = request.body;
  const rawTextOutput = request.headers['neon-raw-text-output'] === 'true';
  const arrayMode = request.headers['neon-array-mode'] === 'true';

  if (!sql) {
    return reply.code(400).send({ error: 'SQL query is required' });
  }

  // Check if the method is valid
  if (method !== 'all' && method !== 'single') {
    return reply.code(400).send({ error: 'Invalid method. Use "all" or "single".' });
  }
  
  // Enhanced detailed logging for query understanding
  if (sql.includes('default')) {
    app.log.info({ 
      sql, 
      params,
      hasDefault: true,
      lowercaseSql: sql.toLowerCase(), 
      sqlType: sql.trim().split(' ')[0].toUpperCase(),
      headers: request.headers
    }, 'Executing query with DEFAULT keyword');
    
    // Check table structure for columns with default values
    try {
      // Get the table name from the SQL
      const tableNameMatch = sql.match(/into\s+"([^"]+)"/i);
      if (tableNameMatch && tableNameMatch[1]) {
        const tableName = tableNameMatch[1];
        // Query column defaults
        const tableInfoQuery = `
          SELECT column_name, column_default, is_nullable 
          FROM information_schema.columns 
          WHERE table_name = $1
          ORDER BY ordinal_position
        `;
        const columnInfo = await pool.query(tableInfoQuery, [tableName]);
        app.log.info({ 
          tableName, 
          columns: columnInfo.rows 
        }, 'Table structure info');
      }
    } catch (infoError) {
      app.log.warn({ error: infoError }, 'Error fetching table structure');
    }
  }

  try {
    // Execute the query
    const result = await pool.query(sql, params);
    
    // Log results for debugging
    request.log.debug({ 
      rowCount: result.rowCount,
      hasRows: result.rows.length > 0,
    }, 'Query completed successfully');

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
      errorCode: error.code,
      errorTable: error.table,
      errorConstraint: error.constraint,
      errorDetail: error.detail,
      errorRoutine: error.routine,
      errorHint: error.hint
    }, 'Database query error');
    
    // Format PostgreSQL error like Neon does
    return reply.code(400).send(formatPostgresError(error));
  }
});

// Transaction endpoint
app.post('/transaction', async (request, reply) => {
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
    headers: request.headers,
    queriesWithDefault: queries.filter(q => q.sql?.includes('default')).length
  }, 'Starting transaction');

  // Log queries containing DEFAULT for deeper analysis
  queries.forEach((query, index) => {
    if (query.sql?.includes('default')) {
      app.log.info({
        index,
        sql: query.sql,
        params: query.params,
        method: query.method
      }, 'Transaction query with DEFAULT keyword');
    }
  });

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

    // Execute all queries
    const results = [];
    
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      const { sql, params = [], method = 'all' } = query;
      
      // Check for DEFAULT keywords and log relevant table structure
      if (sql?.includes('default')) {
        // Extract table name from INSERT statements
        const tableNameMatch = sql.match(/into\s+"([^"]+)"/i);
        if (tableNameMatch && tableNameMatch[1]) {
          const tableName = tableNameMatch[1];
          try {
            // Query column defaults
            const tableInfoQuery = `
              SELECT column_name, column_default, is_nullable 
              FROM information_schema.columns 
              WHERE table_name = $1
              ORDER BY ordinal_position
            `;
            const columnInfo = await client.query(tableInfoQuery, [tableName]);
            app.log.info({ 
              query: i,
              tableName, 
              columns: columnInfo.rows 
            }, 'Table structure info for transaction query');
          } catch (infoError) {
            app.log.warn({ error: infoError }, 'Error fetching table structure in transaction');
          }
        }
      }
      
      // Log each query in the transaction
      app.log.info({ 
        index: i, 
        sql, 
        params, 
        method,
        containsDefault: sql?.includes('default')
      }, 'Executing transaction query');
      
      try {
        // Execute the query
        const result = await client.query(sql, params);
        
        app.log.info({ 
          index: i,
          rowCount: result.rowCount,
          hasRows: result.rows?.length > 0,
          fieldCount: result.fields?.length,
          commandStatus: result.command,
          firstRowSample: result.rows?.[0] ? JSON.stringify(result.rows[0]).substring(0, 100) : null
        }, 'Transaction query result');
        
        // Format the result
        if (rawTextOutput) {
          const formattedResult = formatQueryResult(result, rawTextOutput);
          formattedResult.rowAsArray = arrayMode;
          results.push(formattedResult);
        } else {
          // Store results according to the specified method
          if (method === 'single') {
            results.push(result.rows[0] || null);
          } else {
            results.push(result.rows);
          }
        }
      } catch (queryError) {
        // Log detailed query error but let the transaction handler catch and rollback
        app.log.error({ 
          index: i,
          error: queryError,
          errorCode: queryError.code,
          errorDetail: queryError.detail,
          sql, 
          params
        }, 'Transaction query failed');
        
        // Propagate the error to trigger rollback
        throw queryError;
      }
    }

    // Commit the transaction
    await client.query('COMMIT');
    
    // Log transaction summary
    app.log.info({ 
      success: true, 
      queryCount: queries.length,
      resultCount: results.length
    }, 'Transaction completed successfully');

    // Return formatted response matching Neon's format
    return { results };
  } catch (error) {
    // Rollback in case of error
    try {
      await client.query('ROLLBACK');
      app.log.info('Transaction rolled back due to error');
    } catch (rollbackError) {
      app.log.error({ error: rollbackError }, 'Error during transaction rollback');
    }
    
    // Detailed error logging
    app.log.error({ 
      error,
      errorCode: error.code,
      errorTable: error.table,
      errorConstraint: error.constraint,
      errorDetail: error.detail,
      errorRoutine: error.routine,
      errorHint: error.hint,
      messageStr: error.message
    }, 'Transaction failed');
    
    return reply.code(400).send(formatPostgresError(error));
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