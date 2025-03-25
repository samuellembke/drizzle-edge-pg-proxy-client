import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPgHttpClient } from './pg-http-client';

// Create a properly typed mock
type MockFetch = {
  (input: string | URL, init?: RequestInit): Promise<Response>;
  mockClear: () => void;
  mockReset: () => void;
  mockResolvedValueOnce: (value: any) => void;
  mockImplementation: (fn: (...args: any[]) => any) => void;
}

// Create the mock
const mockFetch = vi.fn() as unknown as MockFetch;

describe('PostgreSQL HTTP Client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should execute a query', async () => {
    // Mock successful response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 1, name: 'Test' }],
    } as Response);

    const client = createPgHttpClient({
      proxyUrl: 'https://test-proxy.com',
      fetch: mockFetch as unknown as typeof fetch,
    });

    const result = await client.execute('SELECT * FROM users', [1]);

    // Verify fetch was called correctly
    expect(mockFetch).toHaveBeenCalledWith('https://test-proxy.com/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sql: 'SELECT * FROM users',
        params: [1],
        method: 'all',
      }),
    });

    // Verify result
    expect(result).toEqual([{ id: 1, name: 'Test' }]);
  });

  it('should handle errors', async () => {
    // Mock error response
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'Database error' }),
    } as Response);

    const client = createPgHttpClient({
      proxyUrl: 'https://test-proxy.com',
      fetch: mockFetch as unknown as typeof fetch,
    });

    // Expect the query to throw an error
    await expect(client.execute('SELECT * FROM users')).rejects.toThrow(
      'PostgreSQL HTTP proxy error: Database error'
    );
  });

  it('should format SQL template literals correctly', async () => {
    // Mock successful response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 1, name: 'Test' }],
    } as Response);

    const client = createPgHttpClient({
      proxyUrl: 'https://test-proxy.com',
      fetch: mockFetch as unknown as typeof fetch,
    });

    const userId = 1;
    const name = 'Test';

    const query = client.sql`SELECT * FROM users WHERE id = ${userId} AND name = ${name}`;
    
    // Verify query is formatted correctly
    expect(query.queryData.query).toBe('SELECT * FROM users WHERE id = $1 AND name = $2');
    expect(query.queryData.params).toEqual([1, 'Test']);

    // Execute the query (using the Promise interface)
    await query;

    // Verify fetch was called correctly
    expect(mockFetch).toHaveBeenCalledWith('https://test-proxy.com/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sql: 'SELECT * FROM users WHERE id = $1 AND name = $2',
        params: [1, 'Test'],
        method: 'all',
      }),
    });
  });

  it('should execute transactions', async () => {
    // Mock successful response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        [{ id: 1 }], // First query result
        [], // Second query result
      ],
    } as Response);

    const client = createPgHttpClient({
      proxyUrl: 'https://test-proxy.com',
      authToken: 'test-token',
      fetch: mockFetch as unknown as typeof fetch,
    });

    const queries = [
      { text: 'INSERT INTO users (name) VALUES ($1)', values: ['Alice'] },
      { text: 'UPDATE users SET name = $1 WHERE id = $2', values: ['Bob', 1] },
    ];

    const result = await client.transaction(queries);

    // Verify fetch was called correctly
    expect(mockFetch).toHaveBeenCalledWith('https://test-proxy.com/transaction', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token',
      },
      body: JSON.stringify({
        queries: [
          { sql: 'INSERT INTO users (name) VALUES ($1)', params: ['Alice'], method: 'all' },
          { sql: 'UPDATE users SET name = $1 WHERE id = $2', params: ['Bob', 1], method: 'all' },
        ],
      }),
    });

    // Verify result
    expect(result).toEqual([[{ id: 1 }], []]);
  });
});