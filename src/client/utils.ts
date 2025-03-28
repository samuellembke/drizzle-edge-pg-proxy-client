import type { ParameterizedQuery } from './types'; // Assuming types are in types.ts
import { QueryPromise } from './query-promise'; // Import QueryPromise from new file
// Removed incorrect self-import: import { UnsafeRawSql } from './utils'; 

// Class for RAW SQL representation (Ensure this is defined, not imported)
export class UnsafeRawSql {
  constructor(public sql: string) {}
}

// Helper function to encode binary data for PostgreSQL
export function encodeBuffersAsBytea(value: unknown): unknown {
  // Convert Buffer to bytea hex format: https://www.postgresql.org/docs/current/datatype-binary.html
  if (typeof Buffer !== 'undefined' && (value instanceof Buffer || ArrayBuffer.isView(value))) {
    return '\\x' + Buffer.from(value as any).toString('hex');
  }
  return value;
}

// Generate a UUID similar to what Neon uses for session IDs
export function generateUUID(): string {
  // Simple UUID v4 implementation
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Helper to convert SqlTemplate (from tagged template) to ParameterizedQuery
 * This mirrors Neon's sqlTemplate.toParameterizedQuery
 */
export function toParameterizedQuery(
  strings: TemplateStringsArray,
  values: any[]
): ParameterizedQuery {
  let query = '';
  const params: any[] = [];

  for (let i = 0, len = strings.length; i < len; i++) {
    query += strings[i];
    if (i < values.length) {
      const value = values[i];

      // Handle different value types
      if (value instanceof UnsafeRawSql) {
        query += value.sql;
      } else if (value instanceof QueryPromise) {
        // Ensure QueryPromise has queryData before accessing it
        if (value.queryData) {
          // Inline the query text but not params - check if params exist
          if (value.queryData.params && value.queryData.params.length > 0) {
             // If the nested query has parameters, it's not safely composable this way
             throw new Error('Cannot compose a query promise that has parameters.');
          }
          query += value.queryData.query;
        } else {
          // Handle cases where queryData might be missing (should not happen with current structure)
          throw new Error('Invalid QueryPromise encountered during composition.');
        }
      } else {
        params.push(value);
        query += `$${params.length}`;

        // Type hint for binary data
        const isBinary = typeof Buffer !== 'undefined' && (value instanceof Buffer || ArrayBuffer.isView(value));
        if (isBinary) query += '::bytea';
      }
    }
  }

  return { query, params };
}
