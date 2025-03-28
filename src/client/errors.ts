// Custom PostgreSQL Error Class following Neon's pattern
export class PgError extends Error {
  override name = 'PgError' as const;

  // PostgreSQL specific error fields
  severity?: string;
  code?: string;
  detail?: string;
  hint?: string;
  position?: string;
  internalPosition?: string;
  internalQuery?: string;
  where?: string;
  schema?: string;
  table?: string;
  column?: string;
  dataType?: string;
  constraint?: string;
  file?: string;
  line?: string;
  routine?: string;

  // Original error if wrapped
  sourceError?: Error;

  constructor(message: string) {
    super(message);

    if ('captureStackTrace' in Error && typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, PgError);
    }
  }
}

// Standard PostgreSQL error fields for parsing from server responses
export const PG_ERROR_FIELDS = [
  'severity',
  'code',
  'detail',
  'hint',
  'position',
  'internalPosition',
  'internalQuery',
  'where',
  'schema',
  'table',
  'column',
  'dataType',
  'constraint',
  'file',
  'line',
  'routine',
] as const;


// Helper function to handle PostgreSQL error parsing
export function parsePostgresError(err: any): PgError {
  const pgError = new PgError(err.message || 'Unknown PostgreSQL error');

  // Copy all PostgreSQL error fields if they exist
  for (const field of PG_ERROR_FIELDS) {
    if (err[field] !== undefined) {
      pgError[field] = err[field];
    }
  }

  // Store original error if available
  if (err instanceof Error) {
    pgError.sourceError = err;
  }

  return pgError;
}
