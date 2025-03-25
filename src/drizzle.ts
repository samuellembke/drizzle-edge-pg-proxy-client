import { drizzle as drizzleOrm } from 'drizzle-orm/neon-http';
import { createPgHttpClient } from './client/pg-http-client';

/**
 * Creates a Drizzle client connecting to PostgreSQL via HTTP proxy
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

  // Create our custom HTTP client that mirrors Neon's client interface
  const pgClient = createPgHttpClient({ 
    proxyUrl, 
    authToken, 
    fetch 
  });

  // Create a drizzle instance using our client
  const db = drizzleOrm(pgClient as any, { schema });

  // Expose the query method directly on the db object
  // This is important for compatibility with adapters that expect this method
  Object.defineProperty(db, 'query', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: pgClient.query.bind(pgClient)
  });
  
  // Also expose the client for direct access if needed
  Object.defineProperty(db, 'client', {
    enumerable: true,
    configurable: true,
    writable: false,
    value: pgClient
  });

  return db;
}