// Transaction handling for the PostgreSQL HTTP proxy server

const { formatQueryResult, formatPostgresError } = require('./utils');

// Handle a transaction with multiple queries
async function handleTransaction(request, reply, pool, logger) {
  // Get client session from the request context
  const session = request.session;

  const { queries, options = {} } = request.body;
  const rawTextOutput = request.headers['neon-raw-text-output'] === 'true';
  const arrayMode = request.headers['neon-array-mode'] === 'true';

  // Validate queries array
  if (!queries || !Array.isArray(queries) || queries.length === 0) {
    return reply.code(400).send({ error: 'Queries array is required and must not be empty' });
  }

  // Check for unsupported options
  const { isolationLevel, readOnly, deferrable } = options;
  
  // Analyze the transaction for DEFAULT keywords
  logger.info({
    queryCount: queries.length,
    hasOptions: Object.keys(options).length > 0,
    isolationLevel,
    readOnly,
    deferrable,
    headers: request.headers,
    sessionId: request.headers['x-session-id'],
    queriesWithDefault: queries.filter(q => q.sql?.includes('default')).length
  }, 'Starting transaction');

  // Log queries containing DEFAULT for deeper analysis
  queries.forEach((query, index) => {
    if (query.sql?.includes('default')) {
      logger.info({
        index,
        sql: query.sql,
        params: query.params,
        method: query.method,
        sessionId: request.headers['x-session-id']
      }, 'Transaction query with DEFAULT keyword');
    }
  });

  // Get a client from the pool
  const client = await pool.connect();
  
  // Define transaction context for tracking values between steps
  const txContext = {
    capturedValues: new Map(), // Store values captured from RETURNING clauses
    tableStructures: new Map(), // Cache table structure information
  };

  // Define transaction results array
  const results = [];

  try {
    // Start transaction with optional isolation level
    let startCmd = 'BEGIN';
    if (isolationLevel) {
      startCmd += ` ISOLATION LEVEL ${isolationLevel}`;
    }
    if (readOnly === true) {
      startCmd += ' READ ONLY';
    }
    if (deferrable === true) {
      startCmd += ' DEFERRABLE';
    }
    await client.query(startCmd);

    // Process each query in sequence
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      const { sql, params = [], method = 'all' } = query;

      // Validate SQL
      if (!sql) {
        throw new Error(`Query at index ${i} is missing SQL statement`);
      }

      // Clone params array and potentially modify SQL for DEFAULT substitution
      let modifiedParams = [...params]; // Clone params array for potential modification

      // Detect if this query has a RETURNING clause (potential source of IDs)
      const hasReturning = sql?.toLowerCase().includes('returning');

      // Analyze and process DEFAULT keywords in the current query
      if (sql?.toLowerCase().includes('default') && (txContext.capturedValues.size > 0 || session.latestTableData.size > 0)) {
        // Get the table structure to understand column relations
        const tableNameMatch = sql.match(/into\s+"([^"]+)"/i);
        if (tableNameMatch && tableNameMatch[1]) {
          const tableName = tableNameMatch[1];
          
          try {
            // Get table structure info from cache or database
            let tableInfo;
            if (txContext.tableStructures.has(tableName)) {
              tableInfo = txContext.tableStructures.get(tableName);
            } else {
              // Query for column information including foreign key relationships
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
              const result = await client.query(tableInfoQuery, [tableName]);
              tableInfo = result.rows;
              txContext.tableStructures.set(tableName, tableInfo);
            }

            // Log table structure for debugging
            logger.info({
              tableName,
              columns: tableInfo,
              sessionId: request.headers['x-session-id']
            }, 'Transaction table structure');
            
            // Look for Auth.js pattern: account linking with user_id
            const isAccountTable = tableName.toLowerCase().includes('account');
            const userIdColumn = tableInfo.find(col => 
              col.column_name.toLowerCase() === 'user_id' || 
              col.referenced_table?.toLowerCase()?.includes('user')
            );

            // Special handling for Auth.js pattern
            if (isAccountTable && userIdColumn) {
              logger.info({
                pattern: 'Auth.js account linking in transaction',
                userId: session.returningValues.get('user_id'),
                sessionId: request.headers['x-session-id']
              }, 'Auth.js pattern detected in transaction');

              // Look for user ID in session context first
              let userId = null;

              // Check session for stored user IDs
              for (const [tableName, values] of session.latestTableData.entries()) {
                if (tableName.toLowerCase().includes('user') && values.has('id')) {
                  userId = values.get('id');
                  break;
                }
              }

              // If not found in session, check transaction context
              if (!userId) {
                // Look for user tables that we've captured IDs from in this transaction
                for (const [table, columns] of txContext.capturedValues.entries()) {
                  if (table.toLowerCase().includes('user') && columns.has('id')) {
                    userId = columns.get('id');
                    break;
                  }
                }
              }

              // If we found a user ID replace DEFAULT in the SQL for user_id
              if (userId) {
                logger.info({
                  userId,
                  column: userIdColumn.column_name,
                  originalSql: sql,
                  sessionId: request.headers['x-session-id']
                }, 'Replacing DEFAULT with user ID in Auth.js pattern');

                // Use regex to replace DEFAULT in the user_id column
                // This handles various SQL formats like:
                // - "user_id" DEFAULT)
                // - "user_id" DEFAULT,
                const columnName = userIdColumn.column_name;
                
                // First try to match the exact pattern for user_id column with DEFAULT
                const columnPattern = new RegExp(`"${columnName}"[^,]*,\\s*DEFAULT\\s*[,)]`, 'i');

                if (columnPattern.test(sql)) {
                  // Replace DEFAULT with parameter placeholder
                  const paramIndex = modifiedParams.length + 1;
                  const newSql = sql.replace(columnPattern, (match) => {
                    return match.endsWith(')') 
                      ? `"${columnName}", $${paramIndex})` 
                      : `"${columnName}", $${paramIndex},`;
                  });
                  
                  // Update parameters and SQL
                  modifiedParams.push(userId);
                  sql = newSql;
                  
                  logger.info({
                    originalSql: query.sql,
                    modifiedSql: sql,
                    sessionId: request.headers['x-session-id']
                  }, 'SQL modified with user ID parameter');
                } else {
                  // Try alternative pattern for values (DEFAULT, ...)
                  const firstValuePattern = /values\s*\(\s*DEFAULT\s*,/i;
                  if (firstValuePattern.test(sql) && sql.toLowerCase().includes(`"${columnName.toLowerCase()}"`)) {
                    // Find the position of user_id in the columns list
                    const columnsMatch = sql.match(/\(([^)]+)\)\s+values/i);
                    if (columnsMatch) {
                      const columns = columnsMatch[1].split(',').map(c => c.trim());
                      const userIdPos = columns.findIndex(c => c.includes(`"${columnName}"`));
                      
                      if (userIdPos === 0) { // If user_id is the first column
                        // Replace DEFAULT with parameter placeholder
                        const paramIndex = modifiedParams.length + 1;
                        const newSql = sql.replace(
                          firstValuePattern, 
                          `values ($${paramIndex}, `
                        );
                        
                        // Update parameters and SQL
                        modifiedParams.push(userId);
                        sql = newSql;
                        
                        logger.info({
                          originalSql: query.sql,
                          modifiedSql: sql,
                          sessionId: request.headers['x-session-id']
                        }, 'SQL modified with user ID for first parameter');
                      }
                    }
                  }
                }
              }
            }

            // General case: Scan for any DEFAULT keywords where we have matching captured values
            const defaultColPatternText = /"([^"]+)"[^,]*,\s*DEFAULT\s*[,)]/gi;
            let match;
            let replacementsMade = false;
            let modifiedSql = sql;

            while ((match = defaultColPatternText.exec(sql)) !== null) {
              const columnName = match[1].toLowerCase();
              let replacementValue = null;
              let foundInTable = null;

              // Find replacement value from transaction context or session
              for (const [table, columns] of txContext.capturedValues.entries()) {
                // Match by column name or with table prefix
                if (columns.has(columnName) || columns.has(`${table}.${columnName}`)) {
                  replacementValue = columns.has(columnName) 
                    ? columns.get(columnName) 
                    : columns.get(`${table}.${columnName}`);
                  foundInTable = table;
                  break;
                }
              }

              // If not found in transaction context, try session
              if (replacementValue === null) {
                for (const [table, values] of session.latestTableData.entries()) {
                  if (values.has(columnName)) {
                    replacementValue = values.get(columnName);
                    foundInTable = `session:${table}`;
                    break;
                  }
                }
              }

              // If we found a value replace DEFAULT in the SQL
              if (replacementValue !== null) {
                const paramIndex = modifiedParams.length + 1;
                const originalMatch = match[0];

                // Replace DEFAULT with parameter placeholder
                modifiedSql = modifiedSql.replace(originalMatch, (matchStr) => {
                  return matchStr.endsWith(')') 
                    ? `"${match[1]}", $${paramIndex})` 
                    : `"${match[1]}", $${paramIndex},`;
                });

                // Add the value to params
                modifiedParams.push(replacementValue);

                logger.info({
                  columnName,
                  replacementValue,
                  foundInTable,
                  paramIndex,
                  sessionId: request.headers['x-session-id']
                }, 'Replacing DEFAULT with captured value');

                replacementsMade = true;
              }
            }

            if (replacementsMade) {
              sql = modifiedSql;
              logger.info({
                originalSql: query.sql,
                modifiedSql: sql,
                sessionId: request.headers['x-session-id']
              }, 'SQL modified with replacements for DEFAULT keywords');
            }

          } catch (infoError) {
            logger.warn({ error: infoError }, 'Error analyzing table structure in transaction');
          }
        }
      }

      // Execute the potentially modified query
      logger.debug({
        sql,
        params: modifiedParams,
        hasReturning,
        index: i,
        transactionSize: queries.length,
        sessionId: request.headers['x-session-id']
      }, 'Executing query in transaction');

      const result = await client.query(sql, modifiedParams);

      // Capture values from RETURNING clause for use in later queries
      if (hasReturning && result.rows && result.rows.length > 0) {
        const row = result.rows[0]; // Use first row for captured values
        const tableNameMatch = sql.match(/into\s+"([^"]+)"/i);

        if (tableNameMatch && tableNameMatch[1]) {
          const tableName = tableNameMatch[1].toLowerCase();

          // Initialize table in captured values if needed
          if (!txContext.capturedValues.has(tableName)) {
            txContext.capturedValues.set(tableName, new Map());
          }

          // Store each column value for future reference
          const tableMap = txContext.capturedValues.get(tableName);
          for (const [key, value] of Object.entries(row)) {
            if (value !== null && value !== undefined) {
              const lowerKey = key.toLowerCase();
              tableMap.set(lowerKey, value);
              
              // Add to session for cross-request persistence
              session.returningValues.set(`${tableName}.${lowerKey}`, value);
              
              // For user tables, update the session latestTableData as well
              if (tableName.toLowerCase().includes('user')) {
                if (!session.latestTableData.has(tableName)) {
                  session.latestTableData.set(tableName, new Map());
                }
                session.latestTableData.get(tableName).set(lowerKey, value);
                
                if (lowerKey === 'id') {
                  // Explicitly log user ID storage for debugging
                  logger.info({
                    userId: value,
                    tableName,
                    sessionId: request.headers['x-session-id']
                  }, 'Stored user ID in transaction and session');
                }
              }
            }
          }

          logger.debug({
            storedValues: Object.fromEntries(tableMap),
            tableName,
            capturedSize: txContext.capturedValues.size,
            sessionId: request.headers['x-session-id']
          }, 'Captured values from RETURNING clause');
        }
      }

      // Format the result according to the requested method
      const formattedResult = formatQueryResult(result, rawTextOutput);
      formattedResult.rowAsArray = arrayMode; // Set the array mode based on header
      results.push(formattedResult);
    }

    // Commit the transaction
    await client.query('COMMIT');
    
    logger.info({
      resultsCount: results.length,
      capturedTablesCount: txContext.capturedValues.size,
      sessionId: request.headers['x-session-id']
    }, 'Transaction committed successfully');

    return results;
  } catch (error) {
    // If anything goes wrong, rollback the transaction
    try {
      await client.query('ROLLBACK');
      logger.warn({
        error: error.message,
        sessionId: request.headers['x-session-id']
      }, 'Transaction rolled back due to error');
    } catch (rollbackError) {
      // Just log if rollback itself fails, original error is still thrown
      logger.error({
        originalError: error.message,
        rollbackError: rollbackError.message,
        sessionId: request.headers['x-session-id']
      }, 'Failed to rollback transaction');
    }

    // Log the error with full details
    logger.error({
      error,
      errorCode: error.code,
      errorTable: error.table,
      errorConstraint: error.constraint,
      errorDetail: error.detail,
      errorRoutine: error.routine,
      errorHint: error.hint,
      sessionId: request.headers['x-session-id']
    }, 'Transaction failed');

    // Format the error response
    return reply.code(400).send(formatPostgresError(error));
  } finally {
    // Always release the client back to the pool
    client.release();
  }
}

module.exports = {
  handleTransaction
};
