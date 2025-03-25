/**
 * Drizzle Edge PostgreSQL Proxy Client
 * 
 * A client for connecting to PostgreSQL databases from edge runtimes
 * via an HTTP proxy, compatible with Drizzle ORM.
 * 
 * @packageDocumentation
 */

export { drizzle } from './drizzle';
export { createPgHttpClient } from './client/pg-http-client';
export * from './types';