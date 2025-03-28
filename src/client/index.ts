/**
 * Creates a custom HTTP client for PostgreSQL that works in edge environments
 * This implementation mirrors Neon's HTTP client interface to ensure compatibility
 * with drizzle-orm, Auth.js and other tools that expect the Neon client.
 */
import { LogLevel } from './types'; // Import LogLevel as a value
import type {
  ClientOptions,
  PgQueryResult,
  ParameterizedQuery,
  TransactionQuery,
  SQLTemplateTag
  // LogLevel removed from type-only import
} from './types';
import { PgError, parsePostgresError, PG_ERROR_FIELDS } from './errors';
import { TypeParser, processQueryResult } from './parsing';
import { QueryPromise } from './query-promise'; // Import QueryPromise from its own file
import {
  UnsafeRawSql,
  encodeBuffersAsBytea,
  generateUUID,
  toParameterizedQuery
} from './utils';

// Re-export core types and classes for external use
export { PgError } from './errors';
export { UnsafeRawSql } from './utils'; // QueryPromise removed from here
export { QueryPromise } from './query-promise'; // Export QueryPromise from its new file
export { TypeParser, PgTypeId } from './parsing';
export type {
  PgQueryResult,
  PgField,
  ParameterizedQuery,
  TransactionQuery,
  ClientOptions,
  SQLTemplateTag
} from './types';


export function createPgHttpClient({
  proxyUrl,
  authToken,
  fetch: customFetch,
  arrayMode = false,
  fullResults = false,
  typeParser: customTypeParser,
  sessionId,
  logger: loggerOptions // Destructure logger options
}: ClientOptions) {

  // --- Logger Setup ---
  const configuredLevel = loggerOptions?.level ?? LogLevel.Warn; // Default to Warn
  const customLogFn = loggerOptions?.logFn;

  const log = (level: LogLevel, message: string, data?: any) => {
    if (level >= configuredLevel && configuredLevel !== LogLevel.None) {
      if (customLogFn) {
        customLogFn(level, message, data);
      } else {
        // Default console logging
        const logData = data ? { data } : {};
        const logMessage = `[PG-HTTP-CLIENT][${LogLevel[level]}] ${message}`;
        switch (level) {
          case LogLevel.Debug:
          case LogLevel.Info:
            console.log(logMessage, logData);
            break;
          case LogLevel.Warn:
            console.warn(logMessage, logData);
            break;
          case LogLevel.Error:
            console.error(logMessage, logData);
            break;
        }
      }
    }
  };
  // --- End Logger Setup ---


  // Use provided fetch or global fetch
  const fetchFn = customFetch || globalThis.fetch;

  // Format the proxy URL to ensure it's valid
  const formattedProxyUrl = proxyUrl.endsWith('/') ? proxyUrl.slice(0, -1) : proxyUrl;

  // Initialize type parser
  const typeParser = customTypeParser instanceof TypeParser
    ? customTypeParser
    : new TypeParser(customTypeParser);

  // Create or use provided session ID - this matches Neon's implementation
  const clientSessionId = sessionId || generateUUID();

  // Check if fetch is available in the current environment
  if (!fetchFn) {
    throw new PgError('fetch is not available in the current environment. Please provide a fetch implementation.');
  }

  // Direct query execution function - the core of the client
  const execute = async (queryText: string, params: any[] = []): Promise<PgQueryResult> => {
    log(LogLevel.Debug, 'Executing query', { query: queryText, paramsCount: params.length, sessionId: clientSessionId });
    const startTime = Date.now();

    const fetchOptions: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Add Neon-specific headers for compatibility
        'Neon-Raw-Text-Output': 'true',
        'Neon-Array-Mode': String(arrayMode), // Use default arrayMode for single queries unless overridden
        // Add session ID header for consistent session tracking (just like Neon does)
        'X-Session-ID': clientSessionId,
        // IMPORTANT: Always include Authorization header first if authToken is provided
        // to ensure compatibility with all server implementations
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({
        query: queryText, // Use 'query' field to match Neon
        params: Array.isArray(params) ? params.map(param => encodeBuffersAsBytea(param)) : [],
        // method: 'all', // Neon doesn't seem to use 'method' for single queries
      }),
    };

    try {
      const response = await fetchFn(`${formattedProxyUrl}/query`, fetchOptions);

      if (!response.ok) {
        let errorData: any = { error: response.statusText };
        try { errorData = await response.json(); }
        catch (parseError) { errorData = { error: `Status ${response.status}: ${response.statusText}` }; }
        const pgError = parsePostgresError(errorData); // Use helper
        log(LogLevel.Error, `Query failed with status ${response.status}`, { error: pgError, query: queryText, sessionId: clientSessionId });
        throw pgError;
      }

      const result = await response.json() as any;
      const duration = Date.now() - startTime;
      log(LogLevel.Info, `Query executed successfully`, { durationMs: duration, query: queryText, sessionId: clientSessionId });

      // Process with type parsers - always return full structure internally
      const processedResult = processQueryResult(result, typeParser, arrayMode);

      // Return based on fullResults option (mimicking Neon's behavior)
      // Note: Neon's httpQuery returns rows directly if fullResults is false,
      // but the Pool query override returns the full result object.
      // We'll return the full object from execute for consistency within this client.
      return processedResult;

    } catch (error) {
      if (error instanceof PgError) {
        // Error already logged if it came from response handling
        throw error;
      }
      // Log connection or other unexpected errors
      const connError = new PgError(`Failed to execute query: ${error instanceof Error ? error.message : String(error)}`);
      connError.sourceError = error instanceof Error ? error : undefined;
      log(LogLevel.Error, `Query execution failed`, { error: connError, query: queryText, sessionId: clientSessionId });
      throw connError;
    }
  };


  // SQL tag template for handling raw SQL queries
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): QueryPromise<PgQueryResult> => {
    const parameterizedQuery = toParameterizedQuery(strings, values);
    // Pass arrayMode and fullResults options to the QueryPromise if needed
    return new QueryPromise(
      (q: string, p: any[]) => execute(q, p), // Add types to lambda parameters
      parameterizedQuery,
      { arrayMode, fullResults } // Pass options if QueryPromise needs them
    );
  };


  // Transaction handling
  const transaction = async (
    queries: (TransactionQuery | QueryPromise<PgQueryResult>)[], // Allow both raw objects and QueryPromises
    options?: {
      isolationLevel?: 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
      readOnly?: boolean;
      deferrable?: boolean;
      arrayMode?: boolean;
      fullResults?: boolean;
    }
  ): Promise<any[]> => { // Return type depends on fullResults option
    log(LogLevel.Debug, 'Executing transaction', { queryCount: queries.length, options, sessionId: clientSessionId });
    const startTime = Date.now();
    try {
      if (!Array.isArray(queries)) {
        const err = new PgError('Input to transaction must be an array of queries.');
        log(LogLevel.Error, 'Transaction failed: Invalid input', { error: err, sessionId: clientSessionId });
        throw err;
      }

      // Format queries for the server
      const formattedQueries = queries.map((q) => {
        let queryText: string;
        let queryParams: any[];

        if (q instanceof QueryPromise) {
          // Extract from QueryPromise
          if (!q.queryData) throw new PgError('Invalid QueryPromise passed to transaction.');
          queryText = q.queryData.query;
          queryParams = q.queryData.params;
        } else if (typeof q === 'object' && q !== null && typeof q.text === 'string') {
          // Handle TransactionQuery object
          queryText = q.text;
          queryParams = Array.isArray(q.values) ? q.values : [];
        } else {
          throw new PgError('Invalid query type passed to transaction. Use sql`` or { text: string, values: any[] }.');
        }

        return {
          query: queryText,
          params: queryParams.map(value => encodeBuffersAsBytea(value)),
        };
      });

      // Determine the array mode and full results settings for this transaction
      const txnArrayMode = options?.arrayMode ?? arrayMode; // Inherit from client options if not specified
      const txnFullResults = options?.fullResults ?? fullResults; // Inherit from client options

      // Prepare headers with transaction options
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Neon-Raw-Text-Output': 'true',
        'Neon-Array-Mode': String(txnArrayMode), // Use transaction-specific array mode
        'X-Session-ID': clientSessionId,
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
      };

      if (options?.isolationLevel) headers['Neon-Batch-Isolation-Level'] = options.isolationLevel;
      if (options?.readOnly !== undefined) headers['Neon-Batch-Read-Only'] = String(options.readOnly);
      if (options?.deferrable !== undefined) headers['Neon-Batch-Deferrable'] = String(options.deferrable);

      // Send the transaction request
      const response = await fetchFn(`${formattedProxyUrl}/transaction`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ queries: formattedQueries }),
      });

      if (!response.ok) {
        let errorData: any = {};
        try { errorData = await response.json(); }
        catch { errorData = { error: `Status ${response.status}: ${response.statusText}` }; }
        const pgError = parsePostgresError(errorData); // Use helper
        log(LogLevel.Error, `Transaction failed with status ${response.status}`, { error: pgError, queryCount: formattedQueries.length, sessionId: clientSessionId });
        throw pgError;
      }

      // Parse results from response
      let results: any[] = [];
      try {
        const json = await response.json() as any;
        // Neon proxy returns { results: [...] } for batch
        results = json.results || (Array.isArray(json) ? json : []);
      } catch (error: any) {
        const parseError = new PgError(`Error parsing transaction response: ${error.message}`);
        log(LogLevel.Error, 'Transaction failed: Response parse error', { error: parseError, sessionId: clientSessionId });
        throw parseError;
      }

      // Format each result
      const formattedResults = Array.isArray(results) ? results.map((result) => {
        // Process with type parsers
        const processed = processQueryResult(result, typeParser, txnArrayMode);
        // Return based on transaction's fullResults setting
        return txnFullResults ? processed : processed.rows;
      }) : [];

      const duration = Date.now() - startTime;
      log(LogLevel.Info, `Transaction executed successfully`, { durationMs: duration, queryCount: formattedQueries.length, sessionId: clientSessionId });
      return formattedResults;

    } catch (error) {
      if (error instanceof PgError) {
        // Error should have been logged already if it came from response handling or input validation
        throw error;
      }
      // Log connection or other unexpected errors during transaction setup/execution
      const txError = new PgError(`Failed to execute transaction: ${error instanceof Error ? error.message : String(error)}`);
      txError.sourceError = error instanceof Error ? error : undefined;
      log(LogLevel.Error, `Transaction execution failed`, { error: txError, sessionId: clientSessionId });
      throw txError;
    }
  };

  // Direct query function (often used by libraries like Auth.js)
  // This needs to return the full PgQueryResult structure for compatibility
  const query = async (
    queryText: string,
    params?: any[],
    options?: { // Allow overriding arrayMode/fullResults per query call
      arrayMode?: boolean;
      fullResults?: boolean; // Note: Even if false, we return the full object for consistency here
    }
  ): Promise<PgQueryResult> => {
    log(LogLevel.Debug, 'Executing direct query', { query: queryText, paramsCount: params?.length, options, sessionId: clientSessionId });
    const startTime = Date.now();
    // Use the core execute function, potentially overriding arrayMode for this call
    const callArrayMode = options?.arrayMode ?? arrayMode;
    // We'll call execute which always returns the full structure
    // The caller (e.g., Drizzle) might then extract rows based on its own logic

    const fetchOptions: RequestInit = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Neon-Raw-Text-Output': 'true',
            'Neon-Array-Mode': String(callArrayMode), // Use specific mode for this call
            'X-Session-ID': clientSessionId,
            ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
            query: queryText,
            params: Array.isArray(params) ? params.map(param => encodeBuffersAsBytea(param)) : [],
        }),
    };

    try {
        const response = await fetchFn(`${formattedProxyUrl}/query`, fetchOptions);

        if (!response.ok) {
            let errorData: any = { error: response.statusText };
            try { errorData = await response.json(); }
            catch { errorData = { error: `Status ${response.status}: ${response.statusText}` }; }
            const pgError = parsePostgresError(errorData);
            log(LogLevel.Error, `Direct query failed with status ${response.status}`, { error: pgError, query: queryText, sessionId: clientSessionId });
            throw pgError;
        }

        const result = await response.json() as any;
        const duration = Date.now() - startTime;
        log(LogLevel.Info, `Direct query executed successfully`, { durationMs: duration, query: queryText, sessionId: clientSessionId });
        // Process result using the specific arrayMode for this call
        return processQueryResult(result, typeParser, callArrayMode);

    } catch (error) {
        if (error instanceof PgError) {
            // Error already logged if it came from response handling
            throw error;
        }
        const connError = new PgError(`Direct query failed: ${error instanceof Error ? error.message : String(error)}`);
        connError.sourceError = error instanceof Error ? error : undefined;
        log(LogLevel.Error, `Direct query execution failed`, { error: connError, query: queryText, sessionId: clientSessionId });
        throw connError;
    }
  };


  // Unsafe query builder
  const unsafe = (rawSql: string) => new UnsafeRawSql(rawSql);

  // Return the client interface matching Neon's http client
  return {
    // execute, // Keep execute internal for now unless needed externally
    query,        // Direct query method
    sql,          // SQL template tag
    unsafe,       // For unsafe raw SQL
    transaction,  // For transactions
    // Expose typeParser if users need to interact with it directly
    // typeParser,
  };
}
