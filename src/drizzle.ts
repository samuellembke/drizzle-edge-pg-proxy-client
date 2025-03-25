import { drizzle as drizzleOrm } from 'drizzle-orm/neon-http';
import { createPgHttpClient } from './client/pg-http-client';

/**
 * Creates a Drizzle client connecting to PostgreSQL via HTTP proxy.
 * This client is compatible with both drizzle-orm and Auth.js.
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

  // Create our custom HTTP client that mirrors Neon's client interface exactly
  const pgClient = createPgHttpClient({ 
    proxyUrl, 
    authToken, 
    fetch 
  });

  // Create a drizzle instance using our client
  const db = drizzleOrm(pgClient as any, { schema });

  // CRITICAL: Expose the client's query method directly on the db object
  // This is what Auth.js DrizzleAdapter looks for
  Object.defineProperty(db, 'query', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: pgClient.query.bind(pgClient)
  });
  
  // Also expose other methods for direct access if needed
  Object.defineProperty(db, 'sql', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: pgClient.sql
  });
  
  Object.defineProperty(db, 'transaction', {
    enumerable: true,
    configurable: true,
    writable: true, 
    value: pgClient.transaction.bind(pgClient)
  });
  
  Object.defineProperty(db, 'client', {
    enumerable: true,
    configurable: true,
    writable: false,
    value: pgClient
  });

  return db;
}