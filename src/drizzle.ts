import { drizzle as drizzleOrm } from 'drizzle-orm/neon-http';
import { createPgHttpClient } from './client/pg-http-client';

/**
 * Creates a Drizzle client connecting to PostgreSQL via HTTP proxy
 * This implementation is specifically designed to be compatible with Auth.js
 * by matching the interface expected by the Auth.js DrizzleAdapter.
 * 
 * @param options Configuration options
 * @returns Drizzle ORM instance for your database
 */
export function drizzle<TSchema extends Record<string, unknown>>(options: {
  proxyUrl: string;
  authToken?: string;
  schema: TSchema;
  fetch?: typeof globalThis.fetch;
}) {
  const { proxyUrl, authToken, schema, fetch } = options;

  // Create our custom HTTP client that mimics Neon's client
  const pgClient = createPgHttpClient({ 
    proxyUrl, 
    authToken, 
    fetch 
  });

  // Create a drizzle instance using our client
  const db = drizzleOrm(pgClient as any, { schema });

  // This is the critical part for Auth.js compatibility
  // The DrizzleAdapter directly accesses db.query method
  // We need to ensure it's available and properly bound
  Object.defineProperty(db, 'query', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: pgClient.query.bind(pgClient)  // Important: bind the method to maintain 'this' context
  });
  
  // Also expose the client for direct access if needed
  Object.defineProperty(db, 'client', {
    enumerable: true,
    configurable: true,
    writable: false,
    value: pgClient
  });
  
  // Add direct sql method access too
  Object.defineProperty(db, 'sql', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: pgClient.sql
  });

  return db;
}