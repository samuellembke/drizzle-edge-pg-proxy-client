/**
 * Creates a custom HTTP client for PostgreSQL that works in edge environments
 * This implementation is designed to be compatible with Auth.js (NextAuth.js)
 * and follows a similar pattern to Neon's HTTP client.
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

// Create a class implementing Promise for SQL queries
export class QueryPromise<T = any> implements Promise<T> {
  readonly [Symbol.toStringTag]: string = 'Promise';

  constructor(
    private executeFn: (query: string, params: any[]) => Promise<T>,
    private queryObj: { query: string; params: any[] }
  ) {}

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null | undefined
  ): Promise<TResult1 | TResult2> {
    return this.executeFn(this.queryObj.query, this.queryObj.params).then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null | undefined
  ): Promise<T | TResult> {
    return this.executeFn(this.queryObj.query, this.queryObj.params).catch(onrejected);
  }

  finally(onfinally?: (() => void) | null | undefined): Promise<T> {
    return this.executeFn(this.queryObj.query, this.queryObj.params).finally(onfinally);
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
      const rows = await response.json() as any[];
      
      // Match Neon's result format, which is what drizzle-orm/neon-http expects
      return {
        command: query.trim().toUpperCase().startsWith('INSERT') ? 'INSERT' : 'SELECT',
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
      params.push(values[i]);
      query += `$${params.length}${strings[i + 1] || ''}`;
    }

    return new QueryPromise(execute, { query, params });
  };

  // Transaction handling
  const transaction = async (queries: { text: string, values: unknown[] }[]): Promise<PgQueryResult[]> => {
    try {
      const response = await fetchFn(`${formattedProxyUrl}/transaction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          queries: queries.map(q => ({
            sql: q.text,
            params: q.values,
            method: 'all',
          })),
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
      return Array.isArray(results) ? results.map((rows, i) => {
        const isInsert = (queries[i]?.text || '').trim().toUpperCase().startsWith('INSERT');
        return {
          command: isInsert ? 'INSERT' : 'SELECT',
          fields: [],
          rowCount: Array.isArray(rows) ? rows.length : 0,
          rows: rows,
          rowAsArray: false
        };
      }) : [];
    } catch (error) {
      console.error('Error executing transaction on PostgreSQL HTTP proxy:', error);
      throw new Error(`Failed to execute transaction on PostgreSQL HTTP proxy at ${formattedProxyUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Create a query function that directly executes SQL with parameters
  const query = async (queryText: string, params: any[] = []): Promise<PgQueryResult> => {
    return execute(queryText, params);
  };

  // Unsafe query builder
  const unsafe = (rawSql: string) => ({ sql: rawSql });

  // Return the client interface that matches Neon's
  return {
    execute,   // Our internal method
    query,     // Direct query method (used by Auth.js)
    sql,       // SQL template tag
    unsafe,    // For unsafe raw SQL
    transaction, // For transactions
  };
}