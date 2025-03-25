import { drizzle as drizzleOrm } from 'drizzle-orm/neon-http';
import { createPgHttpClient } from './client/pg-http-client';
import type { FullQueryResults, NeonQueryFunction } from '@neondatabase/serverless';

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
  const client = createPgHttpClient({ proxyUrl, authToken, fetch });

  // Create a compatible client for drizzle-orm
  const compatClient = {
    // Main query function
    query: async (sql: string, params: any[] = [], options: any = {}) => {
      try {
        const result = await client.execute(sql, params);
        return {
          ...result,
          // Ensure all required properties exist
          command: sql.trim().toUpperCase().startsWith('INSERT') ? 'INSERT' : 'SELECT',
          fields: result.fields || [],
          rowCount: result.rowCount,
          rows: result.rows || []
        };
      } catch (error) {
        console.error('Query error:', sql, params);
        throw error;
      }
    },

    // SQL tag function
    sql: client.sql,
    
    // For compatibility
    execute: client.execute,
    
    // Unsafe query builder
    unsafe: (sql: string) => ({ sql }),
    
    // Transaction support
    transaction: client.transaction
  };

  // Create the drizzle-orm instance
  const db = drizzleOrm(compatClient as any, { schema });
  
  // Add direct query execution method used by Auth.js DrizzleAdapter
  // This is a critical compatibility layer for Auth.js
  Object.defineProperty(db, 'query', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: compatClient.query
  });

  return db;
}