// Query handling for the PostgreSQL HTTP proxy server

const { formatQueryResult, formatPostgresError } = require('./utils');

// Handle a single query execution
async function handleQuery(request, reply, pool, logger) {
  // Get client session from the request context
  const session = request.session;

  // Expect 'query' field to match Neon protocol
  const { query, params = [], method = 'all' } = request.body; 
  const rawTextOutput = request.headers['neon-raw-text-output'] === 'true';
  const arrayMode = request.headers['neon-array-mode'] === 'true';

  if (!query) { // Check for 'query' field
    return reply.code(400).send({ error: 'SQL query (field: "query") is required' });
  }

  // Check if the method is valid
  if (method !== 'all' && method !== 'single') {
    return reply.code(400).send({ error: 'Invalid method. Use "all" or "single".' });
  }

  // Check if this is a RETURNING query to track result values
  const hasReturning = query.toLowerCase().includes('returning'); // Use 'query' variable

  // Process session values for tracking
  const sessionId = request.headers['x-session-id'];
  
  // Log the query with important session context
  logger.debug({ 
    query, // Log 'query' field
    params, 
    sessionId,
    sessionStorageSize: session.returningValues.size
  }, 'Processing query');

  try {
    // Execute the query exactly as received
    const result = await pool.query(query, params); // Use 'query' variable
    
    // Store RETURNING values in session for future queries
    if (hasReturning && result.rows && result.rows.length > 0) {
      try {
        // Extract table name from query for context
        let tableName = '';
        const tableMatch = query.match(/into\s+"([^"]+)"/i); // Use 'query' variable
        if (tableMatch && tableMatch[1]) {
          tableName = tableMatch[1].toLowerCase();
          
          // Get the first row as the source of values
          const row = result.rows[0];
          
          // Save all returned values to session
          for (const [key, value] of Object.entries(row)) {
            if (value !== null && value !== undefined) {
              // Store with table.column format for context
              const columnKey = `${tableName}.${key.toLowerCase()}`;
              session.returningValues.set(columnKey, value);
              
              // Log important ID values for debugging
              if (key.toLowerCase() === 'id') {
                logger.debug({ 
                  table: tableName, 
                  column: key,
                  value,
                  sessionId
                }, 'Stored ID from RETURNING clause');
              }
            }
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
      sessionId
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
    // Log error with detailed information
    logger.error({ 
      error, 
      query, // Log 'query' field
      params,
      errorCode: error.code,
      errorTable: error.table,
      errorDetail: error.detail,
      sessionId
    }, 'Database query error');

    // Format PostgreSQL error like Neon does
    return reply.code(400).send(formatPostgresError(error));
  }
}

module.exports = {
  handleQuery
};
