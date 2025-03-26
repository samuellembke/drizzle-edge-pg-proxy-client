// Utility functions for the PostgreSQL HTTP proxy server

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

module.exports = {
  formatPostgresError,
  formatQueryResult
};
