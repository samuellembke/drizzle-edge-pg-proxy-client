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
    version: '1.1.0',
    endpoints: [
      { path: '/query', method: 'POST', description: 'Execute SQL queries' },
      { path: '/transaction', method: 'POST', description: 'Execute transactions' },
      { path: '/health', method: 'GET', description: 'Health check endpoint' }
    ],
    documentation: 'https://github.com/samuellembke/drizzle-edge-pg-proxy-client'
  };
});

// Helper function to extract client identifier from request - used to maintain session state
function getClientIdentifier(request) {
  // Try to get auth token first as most reliable identifier
  const authHeader = request.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  
  // Fall back to a combination of headers that should identify the client
  if (token) return `auth_${token}`;
  
  // If no auth token, use a combination of headers
  const userAgent = request.headers['user-agent'] || '';
  const acceptLanguage = request.headers['accept-language'] || '';
  const host = request.headers.host || '';
  return `noauth_${host}_${userAgent.substring(0, 20)}_${acceptLanguage.substring(0, 10)}`;
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
  
  // Check if this is a RETURNING query to track result values
  const hasReturning = sql.toLowerCase().includes('returning');
  
  // Check for DEFAULT keywords that might need substitution from session context
  if (sql.toLowerCase().includes('default')) {
    app.log.info({ 
      sql, 
      params,
      hasDefault: true,
      lowercaseSql: sql.toLowerCase(), 
      sqlType: sql.trim().split(' ')[0].toUpperCase(),
      headers: request.headers,
      sessionSize: session.returningValues.size
    }, 'Processing query with DEFAULT keyword');
    
    // Get the table structure to understand required columns
    try {
      // Extract table name from INSERT statements
      const tableNameMatch = sql.match(/into\s+"([^"]+)"/i);
      if (tableNameMatch && tableNameMatch[1]) {
        const tableName = tableNameMatch[1];
        
        // Get column information
        const tableInfoQuery = `
          SELECT 
            column_name, 
            column_default, 
            is_nullable,
            (SELECT kcu.table_name 
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu 
               ON tc.constraint_catalog = kcu.constraint_catalog
               AND tc.constraint_schema = kcu.constraint_schema
               AND tc.constraint_name = kcu.constraint_name
             WHERE tc.constraint_type = 'FOREIGN KEY'
               AND tc.table_name = c.table_name
               AND kcu.column_name = c.column_name
             LIMIT 1) as referenced_table
          FROM information_schema.columns c
          WHERE table_name = $1
          ORDER BY ordinal_position
        `;
        const columnInfo = await pool.query(tableInfoQuery, [tableName]);
        app.log.info({ 
          tableName, 
          columns: columnInfo.rows 
        }, 'Table structure info');
        
        // Look for columns with DEFAULT that should be substituted
        // Specifically looking for Auth.js pattern: account table with user_id
        const isAccountTable = tableName.toLowerCase().includes('account');
        const userIdColumn = columnInfo.rows.find(col => 
          col.column_name.toLowerCase() === 'user_id' || 
          col.referenced_table?.toLowerCase()?.includes('user')
        );
        
        if (isAccountTable && userIdColumn && session.returningValues.size > 0) {
          app.log.info({
            pattern: 'Auth.js account linking',
            userIdColumn: userIdColumn.column_name
          }, 'Detected Auth.js pattern from session context');
          
          // Look for any user tables that we've previously captured IDs from
          let userId = null;
          
          // First check session for stored user IDs
          for (const [tableName, values] of session.latestTableData.entries()) {
            if (tableName.toLowerCase().includes('user') && values.has('id')) {
              userId = values.get('id');
              app.log.info({ 
                userId, 
                source: tableName 
              }, 'Found user ID from previous query');
              break;
            }
          }
          
          // If we found a user ID, replace DEFAULT in the SQL
          if (userId !== null) {
            const columnName = userIdColumn.column_name;
            // Replace DEFAULT for user_id with parameter
            const pattern = new RegExp(`"${columnName}"[^,]*,\\s*DEFAULT\\s*[,)]`, 'i');
            
            if (pattern.test(sql)) {
              // Clone params array for modification
              const modifiedParams = [...params];
              const paramIndex = modifiedParams.length + 1;
              
              // Update the SQL statement with the parameter placeholder
              const newSql = sql.replace(pattern, (match) => {
                return match.endsWith(')') 
                  ? `"${columnName}", $${paramIndex})` 
                  : `"${columnName}", $${paramIndex},`;
              });
              
              // Add the user ID to params
              modifiedParams.push(userId);
              
              app.log.info({
                originalSql: sql,
                modifiedSql: newSql,
                modifiedParams,
                userId
              }, 'Substituted user ID for DEFAULT keyword');
              
              // Update the parameters for execution
              sql = newSql;
              params = modifiedParams;
            }
          }
        }
      }
    } catch (infoError) {
      app.log.warn({ error: infoError }, 'Error fetching table structure');
    }
  }

  try {
    // Execute the query with potentially modified SQL and parameters
    const result = await pool.query(sql, params);
    
    // Check if this is a RETURNING query and save values for future context
    if (hasReturning && result.rows && result.rows.length > 0) {
      try {
        // Extract table name from query
        let tableName = '';
        const tableMatch = sql.match(/into\s+"([^"]+)"/i);
        if (tableMatch && tableMatch[1]) {
          tableName = tableMatch[1].toLowerCase();
          
          // Get the first row as the source of values
          const row = result.rows[0];
          
          // Create table map if it doesn't exist
          if (!session.latestTableData.has(tableName)) {
            session.latestTableData.set(tableName, new Map());
          }
          
          // Save all non-null values from the returned row
          const tableData = session.latestTableData.get(tableName);
          for (const [key, value] of Object.entries(row)) {
            if (value !== null && value !== undefined) {
              tableData.set(key.toLowerCase(), value);
              
              // Special handling for primary keys
              if (key.toLowerCase() === 'id') {
                session.returningValues.set(`${tableName}.id`, value);
                app.log.info({ 
                  table: tableName, 
                  id: value 
                }, 'Stored ID from RETURNING clause in session context');
              }
            }
          }
        }
      } catch (contextError) {
        app.log.warn({ error: contextError }, 'Error storing result context');
      }
    }
    
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

    // Execute all queries with transaction context awareness
    const results = [];
    
    // Transaction context for tracking IDs and other values from RETURNING clauses
    const txContext = {
      // Store captured values by table and column
      capturedValues: new Map(),
      // Store ID mappings for foreign keys
      foreignKeyValues: new Map()
    };
    
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      let { sql, params = [], method = 'all' } = query;
      let modifiedParams = [...params]; // Clone params array for potential modification
      
      // Detect if this query has a RETURNING clause (potential source of IDs)
      const hasReturning = sql?.toLowerCase().includes('returning');
      
      // Analyze and process DEFAULT keywords in the current query
      if (sql?.toLowerCase().includes('default') && txContext.capturedValues.size > 0) {
        // Get the table structure to understand column relations
        const tableNameMatch = sql.match(/into\s+"([^"]+)"/i);
        if (tableNameMatch && tableNameMatch[1]) {
          const tableName = tableNameMatch[1];
          
          try {
            // Get column information for this table
            const tableInfoQuery = `
              SELECT 
                column_name, 
                column_default, 
                is_nullable,
                (SELECT kcu.table_name 
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu 
                  ON tc.constraint_catalog = kcu.constraint_catalog
                  AND tc.constraint_schema = kcu.constraint_schema
                  AND tc.constraint_name = kcu.constraint_name
                WHERE tc.constraint_type = 'FOREIGN KEY'
                  AND tc.table_name = c.table_name
                  AND kcu.column_name = c.column_name
                LIMIT 1) as referenced_table
              FROM information_schema.columns c
              WHERE table_name = $1
              ORDER BY ordinal_position
            `;
            const columnInfo = await client.query(tableInfoQuery, [tableName]);
            
            app.log.info({ 
              query: i,
              tableName, 
              columns: columnInfo.rows 
            }, 'Table structure info for transaction query');
            
            // Auth.js-specific pattern detection: account table with user_id
            const isAccountTable = tableName.toLowerCase().includes('account');
            const userIdColumn = columnInfo.rows.find(col => 
              col.column_name.toLowerCase() === 'user_id' || 
              col.referenced_table?.toLowerCase()?.includes('user')
            );
            
            if (isAccountTable && userIdColumn) {
              app.log.info({
                pattern: 'Auth.js account linking',
                userIdColumn: userIdColumn.column_name,
                referencedTable: userIdColumn.referenced_table
              }, 'Detected Auth.js pattern');
              
              // Look for captured user IDs from previous queries
              let userId = null;
              
              // First check for direct user table ID
              for (const [table, columns] of txContext.capturedValues.entries()) {
                if (table.toLowerCase().includes('user') && columns.has('id')) {
                  userId = columns.get('id');
                  break;
                }
              }
              
              // If we found a user ID, replace DEFAULT in the SQL for user_id
              if (userId) {
                app.log.info({
                  userId,
                  column: userIdColumn.column_name,
                  originalSql: sql
                }, 'Replacing DEFAULT with user ID in Auth.js pattern');
                
                // Use regex to replace DEFAULT in the user_id column
                // This handles various SQL formats like:
                // - "user_id", DEFAULT)
                // - "user_id" DEFAULT,
                const columnName = userIdColumn.column_name;
                const pattern = new RegExp(`"${columnName}"[^,]*,\\s*DEFAULT\\s*[,)]`, 'i');
                
                if (pattern.test(sql)) {
                  // Replace DEFAULT with parameter placeholder
                  const paramIndex = modifiedParams.length + 1;
                  sql = sql.replace(pattern, (match) => {
                    return match.endsWith(')') 
                      ? `"${columnName}", $${paramIndex})` 
                      : `"${columnName}", $${paramIndex},`;
                  });
                  
                  // Add the user ID to params
                  modifiedParams.push(userId);
                  
                  app.log.info({
                    modifiedSql: sql,
                    modifiedParams,
                    paramIndex: modifiedParams.length
                  }, 'SQL modified with user ID parameter');
                }
              }
            }
            
            // General case: Scan for any DEFAULT keywords where we have matching captured values
            const defaultColumnPattern = /"([^"]+)"[^,]*,\s*DEFAULT\s*[,)]/gi;
            let match;
            let replacementsMade = false;
            
            while ((match = defaultColumnPattern.exec(sql)) !== null) {
              const columnName = match[1].toLowerCase();
              
              // Find a suitable value from captured values (from any table)
              let replacementValue = null;
              let foundInTable = null;
              
              // First try exact column name match (e.g., id -> id)
              for (const [table, columns] of txContext.capturedValues.entries()) {
                if (columns.has(columnName)) {
                  replacementValue = columns.get(columnName);
                  foundInTable = table;
                  break;
                }
                
                // Then try foreign key pattern (e.g., user_id -> id in users table)
                if (columnName.includes('_')) {
                  const baseColumn = columnName.split('_').pop(); // Get last part after underscore
                  if (baseColumn && table.toLowerCase().includes(columnName.split('_')[0]) && 
                      columns.has(baseColumn)) {
                    replacementValue = columns.get(baseColumn);
                    foundInTable = table;
                    break;
                  }
                }
              }
              
              // If we found a value, replace DEFAULT in the SQL
              if (replacementValue !== null) {
                const paramIndex = modifiedParams.length + 1;
                const originalMatch = match[0];
                
                // Replace DEFAULT with parameter placeholder
                sql = sql.replace(originalMatch, (match) => {
                  return match.endsWith(')') 
                    ? `"${match[1]}", $${paramIndex})` 
                    : `"${match[1]}", $${paramIndex},`;
                });
                
                // Add the replacement value to params
                modifiedParams.push(replacementValue);
                
                app.log.info({
                  columnName,
                  replacementValue,
                  foundInTable,
                  paramIndex
                }, 'Replacing DEFAULT with captured value');
                
                replacementsMade = true;
              }
            }
            
            if (replacementsMade) {
              app.log.info({
                originalSql: query.sql,
                modifiedSql: sql
              }, 'SQL modified with replacements for DEFAULT keywords');
            }
            
          } catch (infoError) {
            app.log.warn({ error: infoError }, 'Error analyzing table structure in transaction');
          }
        }
      }
      
      // Log each query in the transaction
      app.log.info({ 
        index: i, 
        sql, 
        params: modifiedParams, 
        method,
        hasReturning,
        hasDefault: sql?.toLowerCase().includes('default'),
        modifiedFromOriginal: sql !== query.sql
      }, 'Executing transaction query');
      
      try {
        // Execute the query with potentially modified SQL and params
        const result = await client.query(sql, modifiedParams);
        
        // If this query has RETURNING, capture returned values for subsequent queries
        if (hasReturning && result.rows && result.rows.length > 0) {
          // Extract table name from the query
          let tableName = '';
          const tableMatch = sql.match(/into\s+"([^"]+)"/i);
          if (tableMatch && tableMatch[1]) {
            tableName = tableMatch[1];
          } else {
            // Use a generic name if we can't extract the actual table name
            tableName = `query_${i}`;
          }
          
          // Get the first row as the source of values (typical for RETURNING clauses)
          const row = result.rows[0];
          
          // Create a new column map for this table if it doesn't exist
          if (!txContext.capturedValues.has(tableName)) {
            txContext.capturedValues.set(tableName, new Map());
          }
          
          // Store all non-null values from the result
          const tableColumns = txContext.capturedValues.get(tableName);
          for (const [key, value] of Object.entries(row)) {
            if (value !== null && value !== undefined) {
              tableColumns.set(key.toLowerCase(), value);
              app.log.info({
                table: tableName,
                column: key,
                value
              }, 'Captured value from RETURNING clause');
            }
          }
        }
        
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
