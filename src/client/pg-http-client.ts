/**
 * Creates a custom HTTP client for PostgreSQL that works in edge environments
 * This implementation mirrors Neon's HTTP client interface to ensure compatibility
 * with drizzle-orm and other tools that expect the Neon client.
 */

// Define basic types based on Neon's HTTP client
export interface PgQueryResult {
  command: string;
  fields: any[];
  rowCount: number;
  rows: any[];
  rowAsArray: boolean;
}

export interface ParameterizedQuery {
  query: string;
  params: any[];
}

// This is used to tag template literals in SQL queries
export type SQLTemplateTag = (strings: TemplateStringsArray, ...values: any[]) => QueryPromise<PgQueryResult>;

// Create a class implementing Promise for SQL queries with expanded functionality to match Neon's
export class QueryPromise<T = any> implements Promise<T> {
  readonly [Symbol.toStringTag]: string = 'Promise';
  public queryData: { query: string; params: any[] };

  constructor(
    private executeFn: (query: string, params: any[]) => Promise<T>,
    queryObj: { query: string; params: any[] }
  ) {
    this.queryData = queryObj;
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null | undefined
  ): Promise<TResult1 | TResult2> {
    return this.executeFn(this.queryData.query, this.queryData.params).then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null | undefined
  ): Promise<T | TResult> {
    return this.executeFn(this.queryData.query, this.queryData.params).catch(onrejected);
  }

  finally(onfinally?: (() => void) | null | undefined): Promise<T> {
    return this.executeFn(this.queryData.query, this.queryData.params).finally(onfinally);
  }
  
  // For compatibility with result iteration, implement Symbol.iterator
  // This is a simplified version that just returns the Promise result
  [Symbol.iterator](): Iterator<T> {
    // Create a reference to the promise outside the iterator
    const promise = this;
    let isDone = false;
    let resolvedValue: T | undefined = undefined;
    
    return {
      next(): IteratorResult<T> {
        if (isDone) {
          return { done: true, value: undefined as any };
        }
        
        if (resolvedValue === undefined) {
          // For the first call, return the promise result
          return promise.then((value: T) => {
            resolvedValue = value;
            isDone = true;
            return { done: false, value };
          }) as any;
        }
        
        // For subsequent calls (after the promise resolved)
        isDone = true;
        return { done: false, value: resolvedValue };
      }
    };
  }
}

export function createPgHttpClient({
  proxyUrl,
  authToken,
  fetch: customFetch,
}: {
  proxyUrl: string;
  authToken?: string;
  fetch?: typeof globalThis.fetch;
}) {
  // Use provided fetch or global fetch
  const fetchFn = customFetch || globalThis.fetch;

  // Format the proxy URL to ensure it's valid
  const formattedProxyUrl = proxyUrl.endsWith('/') ? proxyUrl.slice(0, -1) : proxyUrl;
  
  // Check if fetch is available in the current environment
  if (!fetchFn) {
    throw new Error('fetch is not available in the current environment. Please provide a fetch implementation.');
  }

  // Direct query execution function - the core of the client
  const execute = async (query: string, params: any[] = []): Promise<PgQueryResult> => {
    const fetchOptions: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({
        sql: query,
        params,
        method: 'all',
      }),
    };
    
    try {
      const response = await fetchFn(`${formattedProxyUrl}/query`, fetchOptions);

      if (!response.ok) {
        let errorMessage = '';
        
        try {
          const errorData = await response.json() as { error?: string };
          errorMessage = errorData.error || response.statusText;
        } catch {
          errorMessage = `Status ${response.status}: ${response.statusText}`;
        }
        
        throw new Error(`PostgreSQL HTTP proxy error: ${errorMessage}`);
      }

      // Parse the rows from the response
      const result = await response.json() as any;
      const rows = Array.isArray(result) ? result : (result?.rows || []);
      
      // Determine command type from the query
      let command = 'SELECT';
      if (query.trim().toUpperCase().startsWith('INSERT')) command = 'INSERT';
      else if (query.trim().toUpperCase().startsWith('UPDATE')) command = 'UPDATE';
      else if (query.trim().toUpperCase().startsWith('DELETE')) command = 'DELETE';
      
      // Match Neon's result format, which is what drizzle-orm/neon-http expects
      return {
        command,
        fields: [],
        rowCount: Array.isArray(rows) ? rows.length : 0,
        rows: rows,
        rowAsArray: false
      };
    } catch (error) {
      console.error('Error connecting to PostgreSQL HTTP proxy:', error);
      throw new Error(`Failed to connect to PostgreSQL HTTP proxy at ${formattedProxyUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // SQL tag template for handling raw SQL queries
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): QueryPromise<PgQueryResult> => {
    let query = strings[0] || '';
    const params: unknown[] = [];

    for (let i = 0; i < values.length; i++) {
      // Check if the value is a special object
      const value = values[i];
      
      // Handle raw SQL specially
      if (value && typeof value === 'object' && 'sql' in value && typeof value.sql === 'string') {
        query += value.sql;
      } else if (value instanceof QueryPromise) {
        // Handle nested query case (similar to Neon)
        if (value.queryData) {
          // Try to inline the query directly - this is a simplified version
          // Full implementation would need recursive handling
          query += value.queryData.query;
        } else {
          // Fallback to parameter binding
          params.push(value);
          query += `$${params.length}`;
        }
      } else {
        // Regular parameter binding
        params.push(value);
        query += `$${params.length}`;
      }
      
      // Add the next string part
      query += strings[i + 1] || '';
    }

    // Return a query promise with the prepared query
    return new QueryPromise(execute, { query, params });
  };

  // Transaction handling - simplified to match Neon's approach
  const transaction = async (queries: { text: string, values: unknown[] }[]): Promise<PgQueryResult[]> => {
    try {
      // Format queries for the transaction
      const formattedQueries = queries.map(q => ({
        sql: q.text,
        params: q.values,
        method: 'all',
      }));

      // Send the transaction request
      const response = await fetchFn(`${formattedProxyUrl}/transaction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          queries: formattedQueries
        }),
      });

      if (!response.ok) {
        let errorMessage = '';
        try {
          const errorData = await response.json() as { error?: string };
          errorMessage = errorData.error || response.statusText;
        } catch {
          errorMessage = `Status ${response.status}: ${response.statusText}`;
        }
        throw new Error(`PostgreSQL HTTP transaction error: ${errorMessage}`);
      }

      const results = await response.json() as any[];
      
      // Format each result to match what Neon returns
      const formattedResults = Array.isArray(results) ? results.map((rows, i) => {
        // Determine the command type from the query
        let command = 'SELECT';
        const query = formattedQueries[i]?.sql || '';
        
        if (query.trim().toUpperCase().startsWith('INSERT')) command = 'INSERT';
        else if (query.trim().toUpperCase().startsWith('UPDATE')) command = 'UPDATE';
        else if (query.trim().toUpperCase().startsWith('DELETE')) command = 'DELETE';
        
        return {
          command,
          fields: [],
          rowCount: Array.isArray(rows) ? rows.length : 0,
          rows: rows,
          rowAsArray: false
        };
      }) : [];
      
      return formattedResults;
    } catch (error) {
      console.error('Error executing transaction on PostgreSQL HTTP proxy:', error);
      throw new Error(`Failed to execute transaction on PostgreSQL HTTP proxy at ${formattedProxyUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Create a query function that directly executes SQL with parameters
  const query = async (queryText: string, params: any[] = []): Promise<PgQueryResult> => {
    return execute(queryText, params);
  };

  // Raw SQL support class
  class UnsafeRawSql {
    constructor(public sql: string) {}
  }
  
  // Unsafe query builder
  const unsafe = (rawSql: string) => new UnsafeRawSql(rawSql);

  // Return the client interface that matches Neon's
  return {
    execute,      // Execute method
    query,        // Direct query method
    sql,          // SQL template tag
    unsafe,       // For unsafe raw SQL
    transaction,  // For transactions
    UnsafeRawSql, // Raw SQL class
  };
}