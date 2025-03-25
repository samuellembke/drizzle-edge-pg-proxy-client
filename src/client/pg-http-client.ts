/**
 * Creates a custom HTTP client for PostgreSQL that works in edge environments
 * This implementation mirrors Neon's HTTP client interface to ensure compatibility
 * with drizzle-orm, Auth.js and other tools that expect the Neon client.
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

// Class for RAW SQL representation
export class UnsafeRawSql {
  constructor(public sql: string) {}
}

// This is used to tag template literals in SQL queries
export type SQLTemplateTag = (strings: TemplateStringsArray, ...values: any[]) => QueryPromise<PgQueryResult>;

// Create a class implementing Promise for SQL queries with expanded functionality to match Neon's
export class QueryPromise<T = any> implements Promise<T> {
  readonly [Symbol.toStringTag]: string = 'Promise';
  public queryData: ParameterizedQuery;

  constructor(
    private executeFn: (query: string, params: any[]) => Promise<T>,
    queryObj: ParameterizedQuery
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
        fields: result?.fields || [],
        rowCount: Array.isArray(rows) ? rows.length : 0,
        rows: rows,
        rowAsArray: result?.rowAsArray || false
      };
    } catch (error) {
      console.error('Error connecting to PostgreSQL HTTP proxy:', error);
      throw new Error(`Failed to connect to PostgreSQL HTTP proxy at ${formattedProxyUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * Helper to convert SqlTemplate to ParameterizedQuery
   * This mirrors Neon's sqlTemplate.toParameterizedQuery
   */
  const toParameterizedQuery = (
    strings: TemplateStringsArray, 
    values: any[]
  ): ParameterizedQuery => {
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
          if (value.queryData) {
            // Inline the query text but not params
            query += value.queryData.query;
          } else {
            throw new Error('This query is not composable');
          }
        } else {
          params.push(value);
          query += `$${params.length}`;
        }
      }
    }
    
    return { query, params };
  };

  // SQL tag template for handling raw SQL queries
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): QueryPromise<PgQueryResult> => {
    const parameterizedQuery = toParameterizedQuery(strings, values);
    return new QueryPromise(execute, parameterizedQuery);
  };

  // Transaction handling
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

      // Parse results from response
      let results: any[] = [];
      try {
        const json = await response.json() as any;
        results = json.results || json;
      } catch (error) {
        throw new Error(`Error parsing transaction response: ${error}`);
      }
      
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
          fields: rows.fields || [],
          rowCount: Array.isArray(rows.rows || rows) ? (rows.rows || rows).length : 0,
          rows: rows.rows || rows,
          rowAsArray: rows.rowAsArray || false
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
  
  // Unsafe query builder - create raw SQL that won't be escaped
  const unsafe = (rawSql: string) => new UnsafeRawSql(rawSql);

  // Return the client interface that exactly matches Neon's
  return {
    execute,      // Execute method
    query,        // Direct query method used by Auth.js
    sql,          // SQL template tag
    unsafe,       // For unsafe raw SQL
    transaction,  // For transactions
  };
}