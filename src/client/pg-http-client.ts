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
    // For debugging Auth.js issues
    if (query.includes('account') || query.includes('user') || query.includes('session')) {
      console.log('Auth.js query detected:', query);
      console.log('Params:', params);
    }
    
    // Auto-add RETURNING for Auth.js operations that need it
    let modifiedQuery = query;
    
    // Check if this is an INSERT into account or session with user_id but no RETURNING
    const isInsert = query.trim().toUpperCase().startsWith('INSERT');
    const hasReturning = query.toUpperCase().includes('RETURNING');
    
    // Special handling for Auth.js account inserts
    if (isInsert && query.includes('account') && query.includes('user_id')) {
      console.log('Auth.js account insert detected');
      
      // If DEFAULT is used for user_id, this will cause the error
      if (query.includes('default') && params.length > 0) {
        console.log('WARNING: Auth.js is trying to insert account with DEFAULT for user_id');
        
        // Best approach is to let the server handle this with its auto-RETURNING functionality
        // But we can log it for debugging
        console.log('This will likely cause a foreign key constraint violation');
      }
    }
    
    // Only auto-add RETURNING to INSERT statements that don't already have it
    // and specifically for Auth.js operations
    if (isInsert && !hasReturning && 
       (query.includes('_account') || query.includes('account') || 
        query.includes('_user') || query.includes('user'))) {
      
      // Add RETURNING * to get IDs and all columns back
      modifiedQuery = `${query.trim()} RETURNING *`;
      console.log('Auto-adding RETURNING clause to query for Auth.js compatibility');
    }
    
    // In middleware and edge runtimes, we need to be careful with fetch options
    const fetchOptions: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({
        sql: modifiedQuery, // Use modified query with RETURNING if applicable
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
      
      // For Auth.js-related errors, add more details
      if (errorMessage.includes('user_id') && errorMessage.includes('null')) {
        console.error('Auth.js foreign key violation detected!');
        console.error('Query:', modifiedQuery);
        console.error('Params:', params);
        console.error('This is likely because Auth.js created a user record but the ID was not properly passed to the account creation query.');
      }
      
      throw new Error(`PostgreSQL HTTP proxy error: ${errorMessage}`);
    }

    const rows = await response.json() as any[];
    
    // For debugging Auth.js operations
    if ((query.includes('user') || query.includes('account')) && rows.length > 0) {
      console.log('Auth.js query result:', rows);
    }
    
    // Format result to match what drizzle-orm/neon-http expects
    return {
      command: isInsert ? 'INSERT' : 'SELECT',
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
      
      // Modify queries to add RETURNING clauses for Auth.js operations
      const modifiedQueries = queries.map(q => {
        const isInsert = q.text.trim().toUpperCase().startsWith('INSERT');
        const hasReturning = q.text.toUpperCase().includes('RETURNING');
        
        // Only auto-add RETURNING to INSERT statements that don't already have it
        // and specifically for Auth.js operations
        if (isInsert && !hasReturning && 
            (q.text.includes('_account') || q.text.includes('account') || 
             q.text.includes('_user') || q.text.includes('user'))) {
          
          // Add RETURNING * to get IDs and all columns back
          const modifiedSql = `${q.text.trim()} RETURNING *`;
          console.log('Auto-adding RETURNING clause to transaction query for Auth.js compatibility');
          
          return {
            sql: modifiedSql,
            params: q.values,
            method: 'all',
          };
        }
        
        return {
          sql: q.text,
          params: q.values,
          method: 'all',
        };
      });
      
      const response = await fetchFn(`${formattedProxyUrl}/transaction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          queries: modifiedQueries,
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

  return {
    execute,
    sql,
    transaction,
    query: execute,
  };
}