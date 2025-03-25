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

  // Store recently created user IDs for Auth.js account linking
  const recentUserIds: string[] = [];

  // Register a user ID (called when user creation queries return)
  const registerUserId = (userId: string) => {
    if (userId && !recentUserIds.includes(userId)) {
      recentUserIds.unshift(userId); // Add to the front for newest first
      // Keep the list manageable
      if (recentUserIds.length > 10) recentUserIds.pop();
    }
  };

  // Get the most recent user ID
  const getRecentUserId = (): string | undefined => {
    return recentUserIds.length > 0 ? recentUserIds[0] : undefined;
  };

  // Prepare query and handle special values like DEFAULT
  const prepareQuery = (query: string, params: any[] = []): { query: string, params: any[] } => {
    // Basic query type detection
    const isInsert = query.trim().toUpperCase().startsWith('INSERT');
    const hasReturning = query.toUpperCase().includes('RETURNING');
    
    // Auth.js table detection
    const isUserTable = query.includes('_user') || query.includes(' user');
    const isAccountTable = query.includes('_account') || query.includes(' account');
    const isSessionTable = query.includes('_session') || query.includes(' session');
    
    const isAuthJsOperation = isInsert && (isUserTable || isAccountTable || isSessionTable);
    
    // Capture user IDs from user creation queries
    if (isInsert && isUserTable && hasReturning) {
      console.log('User creation query detected with RETURNING - will capture user ID');
    }
    
    // Special handling for Auth.js account inserts with DEFAULT for user_id
    if (isInsert && isAccountTable && 
        query.toLowerCase().includes('user_id') && 
        query.toLowerCase().includes('default')) {
      
      console.warn('Auth.js account insert with DEFAULT for user_id detected');
      
      // Check if we have a recent user ID we can use
      const userId = getRecentUserId();
      if (userId) {
        console.log(`Using recent user ID: ${userId} for account linking`);
        
        // Try to replace DEFAULT with the user ID parameter
        // This regex matches "default" preceded by optional whitespace and followed by a comma
        // It's designed to match the first occurrence in VALUES clause
        const defaultRegex = /\(\s*default\s*,/i;
        if (defaultRegex.test(query)) {
          // Replace DEFAULT with a parameter and add the user ID parameter
          const modifiedQuery = query.replace(defaultRegex, `($${params.length + 1},`);
          const modifiedParams = [...params, userId];
          
          console.log('Modified account query with user ID parameter');
          
          // Ensure RETURNING is present
          if (!hasReturning) {
            return {
              query: `${modifiedQuery.trim()} RETURNING *`,
              params: modifiedParams
            };
          }
          
          return {
            query: modifiedQuery,
            params: modifiedParams
          };
        }
        
        // If the regex replacement didn't work, try a more complex approach with column parsing
        console.warn('Simple DEFAULT replacement failed, trying alternative approach');
        
        try {
          // Extract column names from the query
          const columnsMatch = query.match(/insert\s+into\s+\S+\s*\((.*?)\)\s*values/i);
          if (columnsMatch && columnsMatch[1]) {
            const columns = columnsMatch[1].split(',').map(col => col.trim());
            
            // Find user_id column index
            const userIdColIndex = columns.findIndex(col => 
              col.toLowerCase() === 'user_id' || 
              col.toLowerCase().includes('"user_id"')
            );
            
            if (userIdColIndex >= 0) {
              console.log(`Found user_id at column index ${userIdColIndex}`);
              
              // Create new parameters array with the user ID inserted
              const newParams = [...params];
              
              // Build new VALUES clause with the user ID parameter
              let valuesPart = '(';
              for (let i = 0; i < columns.length; i++) {
                if (i === userIdColIndex) {
                  // Add user ID parameter
                  valuesPart += `$${newParams.length + 1}`;
                  newParams.push(userId);
                } else if (query.includes(`$${i+1}`)) {
                  // Keep existing parameter reference
                  valuesPart += `$${i+1}`;
                } else {
                  // Keep DEFAULT for other columns
                  valuesPart += 'DEFAULT';
                }
                
                if (i < columns.length - 1) {
                  valuesPart += ', ';
                }
              }
              valuesPart += ')';
              
              // Reconstruct the query
              const tableMatch = query.match(/insert\s+into\s+(\S+)/i);
              if (tableMatch && tableMatch[1]) {
                let modifiedQuery = `INSERT INTO ${tableMatch[1]} (${columns.join(', ')}) VALUES ${valuesPart}`;
                
                // Add RETURNING if needed
                if (hasReturning) {
                  const returningMatch = query.match(/returning\s+(.*)/i);
                  if (returningMatch && returningMatch[0]) {
                    modifiedQuery += ` ${returningMatch[0]}`;
                  }
                } else {
                  modifiedQuery += ' RETURNING *';
                }
                
                console.log('Successfully reconstructed account query with user ID parameter');
                
                return {
                  query: modifiedQuery,
                  params: newParams
                };
              }
            }
          }
        } catch (error) {
          console.error('Error trying to fix account query:', error);
        }
      } else {
        console.warn('No recent user ID available for account linking');
      }
    }

    // Auto-add RETURNING * for Auth.js operations if not present
    if (isAuthJsOperation && !hasReturning) {
      console.log('Auto-adding RETURNING * clause for Auth.js operation');
      return { 
        query: `${query.trim()} RETURNING *`, 
        params 
      };
    }
    
    return { query, params };
  };

  // Direct query execution function - the core of the client
  const execute = async (query: string, params: any[] = []): Promise<PgQueryResult> => {
    // Prepare the query with special handling for Auth.js operations
    const preparedQuery = prepareQuery(query, params);
    
    const fetchOptions: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({
        sql: preparedQuery.query,
        params: preparedQuery.params,
        method: 'all',
        // Add context to help server identify Auth.js operations
        context: {
          isAuthJs: preparedQuery.query.includes('_account') || 
                   preparedQuery.query.includes('_user') || 
                   preparedQuery.query.includes('_session'),
        }
      }),
    };
    
    try {
      const response = await fetchFn(`${formattedProxyUrl}/query`, fetchOptions);

      if (!response.ok) {
        let errorMessage = '';
        let errorDetails = {};
        
        try {
          const errorData = await response.json() as { error?: string, details?: any };
          errorMessage = errorData.error || response.statusText;
          errorDetails = errorData.details || {};
        } catch {
          errorMessage = `Status ${response.status}: ${response.statusText}`;
        }
        
        // Enhance error for Auth.js operations
        if (preparedQuery.query.includes('_account') && errorMessage.includes('violates not-null constraint')) {
          console.error('Auth.js foreign key violation - check that users are created before accounts');
        }
        
        throw new Error(`PostgreSQL HTTP proxy error: ${errorMessage}`);
      }

      // Parse the rows from the response
      const result = await response.json() as any;
      const rows = Array.isArray(result) ? result : (result?.rows || []);
      
      // Determine command type from the query
      let command = 'SELECT';
      if (preparedQuery.query.trim().toUpperCase().startsWith('INSERT')) command = 'INSERT';
      else if (preparedQuery.query.trim().toUpperCase().startsWith('UPDATE')) command = 'UPDATE';
      else if (preparedQuery.query.trim().toUpperCase().startsWith('DELETE')) command = 'DELETE';
      
      // Check for Auth.js user creation operations and capture user IDs
      const isUserInsert = preparedQuery.query.trim().toUpperCase().startsWith('INSERT') &&
        (preparedQuery.query.includes('_user') || preparedQuery.query.includes(' user'));
      
      if (isUserInsert && rows.length > 0) {
        // Extract user IDs from user creation results
        for (const row of rows) {
          if (row.id) {
            console.log(`Capturing user ID: ${row.id} from user insert result`);
            registerUserId(row.id);
          }
        }
      }
      
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

  // Transaction handling - enhanced to better support Auth.js
  const transaction = async (queries: { text: string, values: unknown[] }[]): Promise<PgQueryResult[]> => {
    try {
      // Prepare each query to handle Auth.js operations
      const preparedQueries = queries.map(q => {
        // Check each query for Auth.js operations
        const prepared = prepareQuery(q.text, q.values as any[]);
        return {
          sql: prepared.query,
          params: prepared.params,
          method: 'all',
        };
      });

      // Send the transaction request
      const response = await fetchFn(`${formattedProxyUrl}/transaction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          queries: preparedQueries,
          // Add context to help server identify Auth.js transactions
          context: {
            isAuthJs: queries.some(q => 
              q.text.includes('_user') || q.text.includes('_account') || q.text.includes('_session')
            )
          }
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
        const query = preparedQueries[i]?.sql || '';
        
        if (query.trim().toUpperCase().startsWith('INSERT')) command = 'INSERT';
        else if (query.trim().toUpperCase().startsWith('UPDATE')) command = 'UPDATE';
        else if (query.trim().toUpperCase().startsWith('DELETE')) command = 'DELETE';
        
        // Check for user inserts and capture IDs for account linking
        const isUserInsert = command === 'INSERT' &&
          (query.includes('_user') || query.includes(' user'));
        
        if (isUserInsert && Array.isArray(rows) && rows.length > 0) {
          // Extract user IDs from results
          for (const row of rows) {
            if (row.id) {
              console.log(`Capturing user ID: ${row.id} from transaction user insert`);
              registerUserId(row.id);
            }
          }
        }
        
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
  // This is the critical method that Auth.js DrizzleAdapter calls directly
  const query = async (queryText: string, params: any[] = []): Promise<PgQueryResult> => {
    return execute(queryText, params);
  };

  // Raw SQL support - used by drizzle and can be used by Auth.js
  class UnsafeRawSql {
    constructor(public sql: string) {}
  }
  
  // Unsafe query builder
  const unsafe = (rawSql: string) => new UnsafeRawSql(rawSql);

  // Return the client interface that matches Neon's
  return {
    execute,      // Our internal method
    query,        // Direct query method (used by Auth.js)
    sql,          // SQL template tag
    unsafe,       // For unsafe raw SQL
    transaction,  // For transactions
    UnsafeRawSql, // Raw SQL class
  };
}