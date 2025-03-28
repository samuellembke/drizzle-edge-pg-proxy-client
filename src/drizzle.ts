import { drizzle as drizzleOrm } from 'drizzle-orm/neon-http';
import { createPgHttpClient, TypeParser, LogLevel } from './client'; // Updated import path
import type { LoggerOptions } from './client'; // Correct: LoggerOptions is a type

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
  arrayMode?: boolean;
  fullResults?: boolean;
  typeParser?: TypeParser | Record<number, (value: string) => any>;
  logger?: LoggerOptions; // Add logger option
}) {
  const {
    proxyUrl,
    authToken, 
    schema, 
    fetch, 
    arrayMode = false,
    fullResults = false,
    typeParser,
    logger // Destructure logger
  } = options;

  // Create our custom HTTP client that mirrors Neon's client interface exactly
  const pgClient = createPgHttpClient({ 
    proxyUrl, 
    authToken, 
    fetch,
    arrayMode,
    fullResults,
    typeParser,
    logger // Pass logger option
  });

  // Create a drizzle instance using our client
  const db = drizzleOrm(pgClient as any, { schema });

  // CRITICAL: Expose the client's query method directly on the db object
  // This is what Auth.js DrizzleAdapter looks for
  // Wrap the query method to ensure it's always called with proper context
  // and always returns a properly structured result
  Object.defineProperty(db, 'query', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: async function(queryText: string, params?: any[], options?: any) {
      try {
        // Call the query method with the correct context and arguments
        const result = await pgClient.query(queryText, params || [], options);
        
        // Ensure the result has a rows property
        if (!result || !result.rows) {
          return {
            command: 'SELECT',
            rowCount: 0,
            fields: [],
            rows: [],
            rowAsArray: false
          };
        }
        
        return result;
      } catch (error) {
        console.error('Error in query method:', error);
        throw error;
      }
    }
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
  
  // Expose the type parser for custom type handling
  Object.defineProperty(db, 'typeParser', {
    enumerable: true,
    configurable: true,
    writable: false,
    value: pgClient.typeParser
  });

  return db;
}
