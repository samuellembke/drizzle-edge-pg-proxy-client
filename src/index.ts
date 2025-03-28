/**
 * Drizzle Edge PostgreSQL Proxy Client
 * 
 * A client for connecting to PostgreSQL databases from edge runtimes
 * via an HTTP proxy, compatible with Drizzle ORM.
 * 
 * @packageDocumentation
 */

export { drizzle } from './drizzle';
export { 
  createPgHttpClient, 
  TypeParser, 
  PgTypeId, 
  PgError, 
  UnsafeRawSql,
  type PgQueryResult,
  type PgField,
  type ParameterizedQuery,
  type SQLTemplateTag,
  type ClientOptions,
  LogLevel // Also export LogLevel enum
} from './client'; // Changed path to import from client directory index
export * from './types';
