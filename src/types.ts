/**
 * Common types used throughout the package
 */

/**
 * Options for creating a PostgreSQL HTTP client
 */
export interface PgHttpClientOptions {
  /**
   * URL of the PostgreSQL HTTP proxy server
   */
  proxyUrl: string;
  
  /**
   * Optional authentication token for the proxy server
   */
  authToken?: string;
  
  /**
   * Optional fetch implementation (uses globalThis.fetch by default)
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Options for creating a Drizzle ORM client
 */
export interface DrizzleClientOptions<TSchema extends Record<string, unknown>> extends PgHttpClientOptions {
  /**
   * Drizzle schema definition
   */
  schema: TSchema;
}

/**
 * SQL query parameters
 */
export interface QueryParams {
  text: string;
  values: unknown[];
}

/**
 * Result of a SQL template literal
 */
export interface SqlQueryResult {
  query: string;
  params: unknown[];
  execute: () => Promise<any[]>;
}

/**
 * PostgreSQL HTTP client interface
 */
export interface PgHttpClient {
  execute: (query: string, params?: unknown[]) => Promise<any[]>;
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => SqlQueryResult;
  transaction: (queries: QueryParams[]) => Promise<any[]>;
  query: (query: string, params?: unknown[]) => Promise<any[]>;
}