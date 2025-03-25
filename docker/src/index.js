import Fastify from 'fastify';
import pg from 'pg';
import fastifyCompress from '@fastify/compress';

const { Pool } = pg;

// Configuration
const config = {
  port: process.env.PORT || 8080,
  host: '0.0.0.0',
  database: {
    url: process.env.DATABASE_URL,
    pool: {
      min: parseInt(process.env.DB_POOL_MIN || '5', 10),
      max: parseInt(process.env.DB_POOL_MAX || '20', 10),
      idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '10000', 10),
    },
  },
  auth: {
    token: process.env.AUTH_TOKEN,
  },
  enableCompression: process.env.ENABLE_COMPRESSION === 'true',
};

// Create the app
const app = Fastify({
  logger: true,
  trustProxy: true,
  // Increase the JSON body size limit if needed
  bodyLimit: 1048576, // 1MB
});

// Enable compression for responses
if (config.enableCompression) {
  await app.register(fastifyCompress);
}

// Create PostgreSQL connection pool
const pool = new Pool({
  connectionString: config.database.url,
  min: config.database.pool.min,
  max: config.database.pool.max,
  idleTimeoutMillis: config.database.pool.idleTimeoutMillis,
});

// Handle pool errors
pool.on('error', (err) => {
  app.log.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Authentication hook
app.addHook('preHandler', async (request, reply) => {
  // Skip authentication for health check and OPTIONS requests
  if (request.routerPath === '/health' || request.method === 'OPTIONS') {
    return;
  }

  // Skip auth if no token is configured
  if (!config.auth.token) {
    return;
  }

  const authHeader = request.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (config.auth.token !== token) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
});

// CORS middleware
app.addHook('onRequest', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (request.method === 'OPTIONS') {
    reply.code(204).send();
  }
});

// Health check route
app.get('/health', async () => {
  // Check if the database connection is healthy
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    return { status: 'ok' };
  } finally {
    client.release();
  }
});

// Query endpoint
app.post('/query', async (request, reply) => {
  const { sql, params = [], method = 'all' } = request.body;

  if (!sql) {
    return reply.code(400).send({ error: 'SQL query is required' });
  }

  // Check if the method is valid
  if (method !== 'all' && method !== 'single') {
    return reply.code(400).send({ error: 'Invalid method. Use "all" or "single".' });
  }

  try {
    const result = await pool.query(sql, params);

    // Return the appropriate result based on the method
    if (method === 'single') {
      return result.rows[0] || null;
    }
    return result.rows;
  } catch (error) {
    request.log.error({ error }, 'Database query error');
    return reply.code(500).send({ error: error.message });
  }
});

// Transaction endpoint
app.post('/transaction', async (request, reply) => {
  const { queries } = request.body;

  if (!queries || !Array.isArray(queries)) {
    return reply.code(400).send({ error: 'An array of queries is required' });
  }

  // Get a client from the pool
  const client = await pool.connect();

  try {
    // Start a transaction
    await client.query('BEGIN');

    // Execute all queries
    const results = [];
    for (const query of queries) {
      const { sql, params = [], method = 'all' } = query;
      
      const result = await client.query(sql, params);
      
      // Handle different result methods
      if (method === 'single') {
        results.push(result.rows[0] || null);
      } else {
        results.push(result.rows);
      }
    }

    // Commit the transaction
    await client.query('COMMIT');

    return results;
  } catch (error) {
    // Rollback in case of error
    await client.query('ROLLBACK');
    request.log.error({ error }, 'Transaction error');
    return reply.code(500).send({ error: error.message });
  } finally {
    // Release the client back to the pool
    client.release();
  }
});

// Start the server
const start = async () => {
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Server listening on ${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

// Handle graceful shutdown
const shutdown = async () => {
  app.log.info('Shutting down server...');
  await app.close();
  await pool.end();
  app.log.info('Server successfully shut down');
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the server
start();