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

  // Direct query execution function
  const execute = async (query: string, params: unknown[] = []): Promise<any[]> => {
    const response = await fetchFn(`${proxyUrl}/query`, {
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
    });

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

    return response.json() as Promise<any[]>;
  };

  // SQL tag template for handling raw SQL queries
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
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
  const transaction = async (queries: { text: string, values: unknown[] }[]) => {
    const response = await fetchFn(`${proxyUrl}/transaction`, {
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

    return response.json() as Promise<any[]>;
  };

  return {
    execute,
    sql,
    transaction,
    query: execute,
  };
}