// Query handling for the PostgreSQL HTTP proxy server

const { formatQueryResult, formatPostgresError } = require('./utils');

// Handle a single query execution
async function handleQuery(request, reply, pool, logger) {
  // Get client session from the request context
  const session = request.session;

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
    logger.info({ 
      sql, 
      params,
      hasDefault: true,
      lowercaseSql: sql.toLowerCase(), 
      sqlType: sql.trim().split(' ')[0].toUpperCase(),
      headers: request.headers,
      sessionId: request.headers['x-session-id'],
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
        logger.info({ 
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

        // Special handling for Auth.js pattern. This is critical to get right!
        if (isAccountTable && userIdColumn) {
          logger.info({
            pattern: 'Auth.js account linking detected',
            sessionSize: session.latestTableData.size,
            userIdColumn: userIdColumn.column_name,
            sessionId: request.headers['x-session-id']
          }, 'Processing potential Auth.js pattern');

          // Look for any user tables that we've previously captured IDs from
          let userId = null;

          // First check session for stored user IDs
          for (const [tableName, values] of session.latestTableData.entries()) {
            if (tableName.toLowerCase().includes('user') && values.has('id')) {
              userId = values.get('id');
              logger.info({ 
                userId, 
                source: tableName,
                sessionId: request.headers['x-session-id']
              }, 'Found user ID from previous request in session');
              break;
            }
          }

          // If no user ID found in session but this is clearly an Auth.js account linking,
          // query for the most recently created user as a fallback strategy
          if (userId === null) {
            try {
              // Auth.js typically creates the user immediately before linking the account
              // So query for the most recently created user as a fallback
              const userLookupQuery = `
                SELECT id FROM ${tableName.replace('account', 'user')} 
                ORDER BY "createdAt" DESC LIMIT 1
              `;
              
              logger.info({ 
                query: userLookupQuery
              }, 'Looking up most recent user as fallback');
              
              const userResult = await pool.query(userLookupQuery);
              if (userResult.rows && userResult.rows.length > 0 && userResult.rows[0].id) {
                userId = userResult.rows[0].id;
                logger.info({ 
                  userId, 
                  source: 'database_lookup',
                  sessionId: request.headers['x-session-id']
                }, 'Found user ID from database lookup');
                
                // Add to session for future queries
                if (!session.latestTableData.has('user')) {
                  session.latestTableData.set('user', new Map());
                }
                session.latestTableData.get('user').set('id', userId);
              }
            } catch (lookupError) {
              logger.warn({ 
                error: lookupError
              }, 'Failed to look up most recent user');
            }
          }
          
          // If we found a user ID, replace DEFAULT in the SQL
          if (userId !== null) {
            const columnName = userIdColumn.column_name;
            // Find the column pattern and DEFAULT keyword
            // This is the critical regular expression pattern that needs to be fixed
            
            // Match patterns like:
            // 1. "user_id", DEFAULT
            // 2. "user_id" default
            // Both with potential trailing commas or parentheses
            const columnPattern = new RegExp(`"${columnName}"[^,]*,\\s*DEFAULT\\s*[,)]`, 'i');

            if (columnPattern.test(sql)) {
              // Clone params array for modification
              const modifiedParams = [...params];
              const paramIndex = modifiedParams.length + 1;

              // Update the SQL statement with the parameter placeholder
              const newSql = sql.replace(columnPattern, (match) => {
                return match.endsWith(')') 
                  ? `"${columnName}", $${paramIndex})` 
                  : `"${columnName}", $${paramIndex},`;
              });

              // Add the user ID to params
              modifiedParams.push(userId);

              logger.info({
                originalSql: sql,
                modifiedSql: newSql,
                modifiedParams,
                userId,
                sessionId: request.headers['x-session-id']
              }, 'Substituted user ID for DEFAULT keyword');

              // Update the parameters for execution
              sql = newSql;
              params = modifiedParams;
            } else {
              // Specific match for Auth.js pattern: values (default, ...
              // This handles the case where user_id is the first param
              const firstValuePattern = /values\s*\(\s*DEFAULT\s*,/i;
              if (firstValuePattern.test(sql) && sql.toLowerCase().includes('"user_id"')) {
                // Find the position of user_id in the columns list
                const columnsMatch = sql.match(/\(([^)]+)\)\s+values/i);
                if (columnsMatch) {
                  const columns = columnsMatch[1].split(',').map(c => c.trim());
                  const userIdPos = columns.findIndex(c => c.includes(`"${columnName}"`));
                  
                  if (userIdPos === 0) { // If user_id is the first column
                    // Clone params array for modification
                    const modifiedParams = [...params];
                    const paramIndex = modifiedParams.length + 1;

                    // Replace DEFAULT with parameter placeholder
                    const newSql = sql.replace(
                      firstValuePattern, 
                      `values ($${paramIndex}, `
                    );

                    // Add the user ID to params
                    modifiedParams.push(userId);

                    logger.info({
                      originalSql: sql,
                      modifiedSql: newSql,
                      modifiedParams,
                      userId,
                      sessionId: request.headers['x-session-id']
                    }, 'Substituted user ID for DEFAULT in first position');

                    // Update the parameters for execution
                    sql = newSql;
                    params = modifiedParams;
                  }
                }
              }
            }
          }
        }
      }
    } catch (infoError) {
      logger.warn({ error: infoError }, 'Error fetching table structure');
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

              // Add to returningValues for compatibility checks - critically important!
              // This fixes the check for session.returningValues.size > 0
              session.returningValues.set(`${tableName}.${key.toLowerCase()}`, value);
              
              // Log important IDs with special detail
              if (key.toLowerCase() === 'id') {
                logger.info({ 
                  table: tableName, 
                  id: value,
                  mapSize: session.latestTableData.size,
                  returningValuesSize: session.returningValues.size,
                  sessionId: request.headers['x-session-id']
                }, 'Stored ID from RETURNING clause in session');
              }
            }
          }
          
          // If this is a user table, explicitly log that we stored the user for later
          if (tableName.toLowerCase().includes('user') && row.id) {
            logger.info({ 
              userId: row.id,
              clientId: request.clientId?.substring(0, 50), // Log part of client ID for debugging
              sessionId: request.headers['x-session-id']
            }, 'Stored user ID in session for future account linking');
          }
        }
      } catch (contextError) {
        logger.warn({ error: contextError }, 'Error storing result context');
      }
    }

    // Log results for debugging
    logger.debug({ 
      rowCount: result.rowCount,
      hasRows: result.rows.length > 0,
      sessionId: request.headers['x-session-id']
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
    logger.error({ 
      error, 
      sql, 
      params,
      errorCode: error.code,
      errorTable: error.table,
      errorConstraint: error.constraint,
      errorDetail: error.detail,
      errorRoutine: error.routine,
      errorHint: error.hint,
      sessionId: request.headers['x-session-id']
    }, 'Database query error');

    // Format PostgreSQL error like Neon does
    return reply.code(400).send(formatPostgresError(error));
  }
}

module.exports = {
  handleQuery
};
