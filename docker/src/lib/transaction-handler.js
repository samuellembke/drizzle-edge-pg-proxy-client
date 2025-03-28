// Transaction handling for the PostgreSQL HTTP proxy server

const { formatQueryResult, formatPostgresError } = require('./utils');

// Handle a transaction with multiple queries
async function handleTransaction(request, reply, pool, logger) {
  // Get client session from the request context
  const session = request.session;
  const sessionId = request.headers['x-session-id'];

  const { queries, options = {} } = request.body;
  const rawTextOutput = request.headers['neon-raw-text-output'] === 'true';
  const arrayMode = request.headers['neon-array-mode'] === 'true';

  // Validate queries array
  if (!queries || !Array.isArray(queries) || queries.length === 0) {
    return reply.code(400).send({ error: 'Queries array is required and must not be empty' });
  }

  // Check for optional transaction settings
  const { isolationLevel, readOnly, deferrable } = options;
  
  // Log transaction start with context
  logger.debug({
    queryCount: queries.length,
    hasOptions: Object.keys(options).length > 0,
    isolationLevel,
    readOnly,
    deferrable,
    sessionId,
    sessionStorageSize: session.returningValues.size
  }, 'Starting transaction');

  // Get a client from the pool
  const client = await pool.connect();
  
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
      const queryItem = queries[i];
      // Expect 'query' field to match Neon protocol
      const { query, params = [], method = 'all' } = queryItem; 

      // Validate SQL query text
      if (!query) { // Check for 'query' field
        throw new Error(`Query at index ${i} is missing SQL statement (field: "query")`);
      }

      // Detect if this query has a RETURNING clause (potential source of values)
      const hasReturning = query?.toLowerCase().includes('returning'); // Use 'query' variable

      // Execute the query exactly as received
      logger.debug({
        query, // Log 'query' field
        params,
        hasReturning,
        index: i,
        transactionSize: queries.length,
        sessionId
      }, 'Executing query in transaction');

      const result = await client.query(query, params); // Use 'query' variable

      // Capture values from RETURNING clause for use in later queries
      if (hasReturning && result.rows && result.rows.length > 0) {
        const row = result.rows[0]; // Use first row for captured values
        const tableNameMatch = query.match(/into\s+"([^"]+)"/i); // Use 'query' variable

        if (tableNameMatch && tableNameMatch[1]) {
          const tableName = tableNameMatch[1].toLowerCase();

          // Store each column value for future reference
          for (const [key, value] of Object.entries(row)) {
            if (value !== null && value !== undefined) {
              const columnKey = `${tableName}.${key.toLowerCase()}`;
              
              // Store in session
              session.returningValues.set(columnKey, value);
              
              // Log important values for debugging
              if (key.toLowerCase() === 'id') {
                logger.debug({
                  table: tableName,
                  column: key,
                  value,
                  sessionId
                }, 'Stored ID from RETURNING clause in transaction');
              }
            }
          }
        }
      }

      // Format the result according to the requested method
      const formattedResult = formatQueryResult(result, rawTextOutput);
      formattedResult.rowAsArray = arrayMode;
      results.push(formattedResult);
    }

    // Commit the transaction
    await client.query('COMMIT');
    
    logger.debug({
      resultsCount: results.length,
      sessionId
    }, 'Transaction committed successfully');

    return results;
  } catch (error) {
    // If anything goes wrong, rollback the transaction
    try {
      await client.query('ROLLBACK');
      logger.warn({
        error: error.message,
        sessionId
      }, 'Transaction rolled back due to error');
    } catch (rollbackError) {
      logger.error({
        originalError: error.message,
        rollbackError: rollbackError.message,
        sessionId
      }, 'Failed to rollback transaction');
    }

    // Log the detailed error
    logger.error({
      error,
      errorCode: error.code,
      errorTable: error.table,
      errorDetail: error.detail,
      sessionId
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
