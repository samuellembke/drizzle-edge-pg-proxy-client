/**
 * Example PostgreSQL HTTP Proxy Implementation using Cloudflare Worker
 * 
 * This is a basic example of how to create a proxy server in a Cloudflare Worker
 * that connects to a PostgreSQL database using Neon's HTTP API.
 * 
 * To use this:
 * 1. Create a Cloudflare Worker project
 * 2. Configure the necessary environment variables in your wrangler.toml
 * 3. Deploy the worker: wrangler deploy
 */

// Example wrangler.toml configuration:
// 
// [vars]
// NEON_PROJECT_ID = "your-neon-project-id"
// NEON_API_KEY = "your-neon-api-key"
// AUTH_TOKEN = "your-auth-token"

export default {
  async fetch(request, env, ctx) {
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle preflight OPTIONS request
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Get the URL path
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle health check
    if (path === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      });
    }

    // Authenticate request
    const authorized = await authenticate(request, env);
    if (!authorized) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      });
    }

    // Handle database operations
    try {
      if (path === '/query' && request.method === 'POST') {
        return await handleQuery(request, env, corsHeaders);
      } else if (path === '/transaction' && request.method === 'POST') {
        return await handleTransaction(request, env, corsHeaders);
      } else {
        return new Response(JSON.stringify({ error: 'Not Found' }), {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        });
      }
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      });
    }
  },
};

/**
 * Authenticate the request
 */
async function authenticate(request, env) {
  // Skip auth if AUTH_TOKEN is not configured
  if (!env.AUTH_TOKEN) {
    return true;
  }

  const authHeader = request.headers.get('Authorization');
  const token = authHeader && authHeader.split(' ')[1];
  
  return env.AUTH_TOKEN === token;
}

/**
 * Handle a single query
 */
async function handleQuery(request, env, corsHeaders) {
  const body = await request.json();
  const { sql, params = [] } = body;
  
  if (!sql) {
    return new Response(JSON.stringify({ error: 'SQL query is required' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
    });
  }

  // Execute the query against your PostgreSQL database
  // This example uses Neon's HTTP API
  const result = await executeNeonQuery(sql, params, env);

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

/**
 * Handle a transaction with multiple queries
 */
async function handleTransaction(request, env, corsHeaders) {
  const body = await request.json();
  const { queries } = body;
  
  if (!queries || !Array.isArray(queries)) {
    return new Response(JSON.stringify({ error: 'An array of queries is required' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
    });
  }

  // Log transaction details for debugging
  console.log('Transaction with', queries.length, 'queries');
  
  // In this example, we manually manage the transaction
  // This approach may vary depending on your PostgreSQL provider
  const results = [];
  
  // Start transaction
  await executeNeonQuery('BEGIN', [], env);
  
  try {
    // Execute each query in sequence
    // Critical for Auth.js: Order matters here because later queries may depend on results from earlier ones
    for (const query of queries) {
      const { sql, params = [] } = query;
      
      // Log each query in the transaction
      console.log('Transaction query:', sql, params);
      
      // Special handling for Auth.js user/account linking operations
      const isInsert = sql.trim().toUpperCase().startsWith('INSERT');
      const isUserInsert = isInsert && sql.includes('user');
      const isAccountInsert = isInsert && sql.includes('account');
      
      // Auth.js typically creates a user, then links an account
      // The user ID from the first query is needed for the second
      if (isUserInsert) {
        console.log('User creation detected in transaction');
      }
      if (isAccountInsert) {
        console.log('Account creation detected in transaction');
      }
      
      const result = await executeNeonQuery(sql, params, env);
      results.push(result);
    }
    
    // Commit transaction
    await executeNeonQuery('COMMIT', [], env);
  } catch (error) {
    // Rollback on error
    console.error('Transaction error:', error);
    await executeNeonQuery('ROLLBACK', [], env);
    throw error;
  }

  return new Response(JSON.stringify(results), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

/**
 * Execute a query using Neon's HTTP API
 * Note: This is a simplified example. Adapt it to your PostgreSQL provider.
 */
async function executeNeonQuery(sql, params, env) {
  // Log queries for debugging
  console.log('Executing query:', sql, params);
  
  // Special handling for Auth.js operations - add logging for debugging
  const isInsert = sql.trim().toUpperCase().startsWith('INSERT');
  const hasReturning = sql.toUpperCase().includes('RETURNING');
  
  // Auth.js needs RETURNING clauses for proper operation
  if (isInsert && !hasReturning && 
     (sql.includes('user') || sql.includes('account') || sql.includes('session'))) {
    console.log('Warning: Auth.js might need RETURNING clause for this operation');
  }

  const response = await fetch(`https://console.neon.tech/api/v2/projects/${env.NEON_PROJECT_ID}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.NEON_API_KEY}`,
    },
    body: JSON.stringify({
      query: sql,
      params: params,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.message || 'Database query failed');
  }

  const data = await response.json();
  
  // For Auth.js compatibility, ensure we return query results in correct format
  return data.rows || [];
}