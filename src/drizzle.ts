import { drizzle as drizzleOrm } from 'drizzle-orm/neon-http';
import { createPgHttpClient } from './client/pg-http-client';
import type { NeonQueryFunction } from '@neondatabase/serverless';

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

  // Create a Neon-compatible client interface that returns data in the expected format
  const neonCompatClient = async (sql: string, params: any[] = [], options: any = {}) => {
    const result = await client.execute(sql, params);
    return result;
  };

  // Add all required methods to match the NeonQueryFunction interface
  neonCompatClient.sql = client.sql;
  
  // Add query method for compatibility
  neonCompatClient.query = async (sql: string, params: any[] = [], options: any = {}) => {
    // Check if this is attempting an operation that requires RETURNING ID
    // This is critical for Auth.js adapter operations (like user creation and account linking)
    const isInsert = sql.trim().toUpperCase().startsWith('INSERT');
    const hasReturning = sql.toUpperCase().includes('RETURNING');
    
    // If we detect an insert that might need the returning ID (like Auth.js operations)
    // but doesn't have RETURNING clause, consider adding it for debugging
    if (isInsert && !hasReturning) {
      console.log('Warning: INSERT query without RETURNING clause detected. Auth.js operations may require RETURNING ID.');
    }
    
    const result = await client.execute(sql, params);
    return {
      ...result,
      // Ensure fields property exists for Neon's mapResult function
      fields: result.fields || []
    };
  };
  
  // Add transaction method for Auth.js operations
  neonCompatClient.transaction = client.transaction;
  
  // Add unsafe method required by NeonQueryFunction
  neonCompatClient.unsafe = (rawSql: string) => ({ sql: rawSql });

  // Use drizzle-orm with our HTTP client
  return drizzleOrm(neonCompatClient as unknown as NeonQueryFunction<any, any>, { schema });
}