/**
 * Creates a custom HTTP client for PostgreSQL that works in edge environments
 *
 * @param options Configuration options
 * @returns A client that communicates with your PostgreSQL proxy
 */
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
  
  // Define the result type to match what drizzle-orm/neon-http expects
  type PgQueryResult = {
    command: string;
    fields: any[];
    rowCount: number;
    rows: any[];
    rowAsArray: boolean;
  };

  // Direct query execution function
  const execute = async (query: string, params: unknown[] = []): Promise<PgQueryResult> => {
    // In middleware and edge runtimes, we need to be careful with fetch options
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

    const rows = await response.json() as any[];
    // Format result to match what drizzle-orm/neon-http expects
    return {
      command: 'SELECT',
      fields: [],  // Fields will be added by drizzle-orm
      rowCount: Array.isArray(rows) ? rows.length : 0,
      rows: rows,
      rowAsArray: false
    };
    } catch (error) {
      console.error('Error connecting to PostgreSQL HTTP proxy:', error);
      // Re-throw with a more helpful message
      throw new Error(`Failed to connect to PostgreSQL HTTP proxy at ${formattedProxyUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // SQL tag template for handling raw SQL queries
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): { 
    query: string; 
    params: unknown[]; 
    execute: () => Promise<PgQueryResult>; 
  } => {
    // Ensure we have a valid string to start with
    let query = strings[0] || '';
    const params: unknown[] = [];

    for (let i = 0; i < values.length; i++) {
      params.push(values[i]);
      // Ensure we have a string to concatenate (default to empty string if undefined)
      query += `$${params.length}${strings[i + 1] || ''}`;
    }

    const result = {
      query,
      params,
      execute: () => execute(query, params),
    };

    return result;
  };

  // Transaction handling
  const transaction = async (queries: { text: string, values: unknown[] }[]): Promise<PgQueryResult[]> => {
    try {
      // For AuthJS, transaction operations are typically:
      // 1. Insert user
      // 2. Get last insert ID (returning clause)
      // 3. Insert account with user_id
      
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
    
    // Format each result to match what drizzle-orm/neon-http expects
    return Array.isArray(results) ? results.map(rows => ({
      command: 'SELECT',
      fields: [],
      rowCount: Array.isArray(rows) ? rows.length : 0,
      rows: rows,
      rowAsArray: false
    })) : [];
    } catch (error) {
      console.error('Error executing transaction on PostgreSQL HTTP proxy:', error);
      throw new Error(`Failed to execute transaction on PostgreSQL HTTP proxy at ${formattedProxyUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    execute,
    sql,
    transaction,
    query: execute,
  };
}