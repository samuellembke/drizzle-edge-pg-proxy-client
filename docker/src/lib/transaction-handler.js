// Transaction handling for the PostgreSQL HTTP proxy server

const { formatQueryResult, formatPostgresError } = require('./utils');

// Handle a transaction with multiple queries
async function handleTransaction(request, reply, pool, logger) {
  // Get client session from the context
  const session = request.session;
  
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
  logger.info({ 
    queryCount: queries.length,
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

    logger.info({ beginQuery, sessionId: request.headers['x-session-id'] }, 'Starting transaction with isolation level');
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

            logger.info({ 
              query: i,
              tableName, 
              columns: columnInfo.rows,
              sessionId: request.headers['x-session-id']
            }, 'Table structure info for transaction query');

            // Auth.js-specific pattern detection: account table with user_id
            const isAccountTable = tableName.toLowerCase().includes('account');
            const userIdColumn = columnInfo.rows.find(col => 
              col.column_name.toLowerCase() === 'user_id' || 
              col.referenced_table?.toLowerCase()?.includes('user')
            );

            if (isAccountTable && userIdColumn) {
              logger.info({
                pattern: 'Auth.js account linking',
                userIdColumn: userIdColumn.column_name,
                referencedTable: userIdColumn.referenced_table,
                sessionId: request.headers['x-session-id']
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
                logger.info({
                  userId,
                  column: userIdColumn.column_name,
                  originalSql: sql,
                  sessionId: request.headers['x-session-id']
                }, 'Replacing DEFAULT with user ID in Auth.js pattern');

                // Use regex to replace DEFAULT in the user_id column
                // This handles various SQL formats like:
                // - "user_id", DEFAULT)
                // - "user_id" DEFAULT,
                const columnName = userIdColumn.column_name;
                const pattern = new RegExp(`"${columnName}"[^,]*,\s*DEFAULT\s*[,)]`, 'i');

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

                  logger.info({
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

      // Log each query in the transaction
      logger.info({ 
        index: i, 
        sql, 
        params: modifiedParams, 
        method,
        hasReturning,
        hasDefault: sql?.toLowerCase().includes('default'),
        modifiedFromOriginal: sql !== query.sql,
        sessionId: request.headers['x-session-id']
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
              logger.info({
                table: tableName,
                column: key,
                value,
                sessionId: request.headers['x-session-id']
              }, 'Captured value from RETURNING clause');
            }
          }
        }

        logger.info({ 
          index: i,
          rowCount: result.rowCount,
          hasRows: result.rows?.length > 0,
          fieldCount: result.fields?.length,
          commandStatus: result.command,
          sessionId: request.headers['x-session-id']
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
        logger.error({ 
          index: i,
          error: queryError,
          errorCode: queryError.code,
          errorDetail: queryError.detail,
          sql, 
          params: modifiedParams,
          sessionId: request.headers['x-session-id']
        }, 'Transaction query failed');

        // Propagate the error to trigger rollback
        throw queryError;
      }
    }

    // Commit the transaction
    await client.query('COMMIT');

    // Log transaction summary
    logger.info({ 
      success: true, 
      queryCount: queries.length,
      resultCount: results.length,
      sessionId: request.headers['x-session-id']
    }, 'Transaction completed successfully');

    // Return formatted response matching Neon's format
    return { results };
  } catch (error) {
    // Rollback in case of error
    try {
      await client.query('ROLLBACK');
      logger.info('Transaction rolled back due to error');
    } catch (rollbackError) {
      logger.error({ error: rollbackError }, 'Error during transaction rollback');
    }

    // Detailed error logging
    logger.error({ 
      error,
      errorCode: error.code,
      errorTable: error.table,
      errorConstraint: error.constraint,
      errorDetail: error.detail,
      errorRoutine: error.routine,
      errorHint: error.hint,
      messageStr: error.message,
      sessionId: request.headers['x-session-id']
    }, 'Transaction failed');

    return reply.code(400).send(formatPostgresError(error));
  } finally {
    // Release the client back to the pool
    client.release();
  }
}

module.exports = {
  handleTransaction
};
