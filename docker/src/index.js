import Fastify from 'fastify';
import pg from 'pg';
import fastifyCompress from '@fastify/compress';

// Import modules
const { config, logLevel } = require('./lib/config');
const { getClientIdentifier, getOrCreateSession, setupSessionCleanup } = require('./lib/session');
const { handleQuery } = require('./lib/query-handler');
const { handleTransaction } = require('./lib/transaction-handler');
const { formatPostgresError } = require('./lib/utils');

const { Pool } = pg;

// Create the app with configured logging
const app = Fastify({
  logger: {
    level: logLevel,
    timestamp: true,
    serializers: {
      req: (req) => {
        return {
          method: req.method,
          url: req.url,
          path: req.routerPath,
          parameters: req.params,
        };
      }
    }
  },
  trustProxy: true,
  bodyLimit: 1048576, // 1MB
});

// Enable compression for responses if configured
if (config.enableCompression) {
  await app.register(fastifyCompress);
}

// Check for database connection string
if (!config.database.url) {
  app.log.error('DATABASE_URL environment variable is not set. Please provide a PostgreSQL connection string.');
  process.exit(1);
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
  app.log.error('Please check your DATABASE_URL environment variable.');
  // Don't exit the process to allow for recovery
});

// Setup session cleanup interval
const cleanupInterval = setupSessionCleanup(app.log);

// Session middleware to attach session to request
app.addHook('preHandler', async (request, reply) => {
  // Store client ID in request object
  request.clientId = getClientIdentifier(request);
  
  // Get or create session and attach to request
  request.session = getOrCreateSession(request);
  
  // Log session info for debugging purposes
  app.log.debug({ 
    clientId: request.clientId,
    sessionId: request.headers['x-session-id'],
    sessionSize: request.session.returningValues.size
  }, 'Request session context');
});

// Authentication hook
app.addHook('preHandler', async (request, reply) => {
  // Skip authentication for health check, root path, and OPTIONS requests
  if (request.url === '/health' || request.url === '/' || request.method === 'OPTIONS') {
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
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-ID, Neon-Connection-String, Neon-Raw-Text-Output, Neon-Array-Mode, Neon-Batch-Isolation-Level, Neon-Batch-Read-Only, Neon-Batch-Deferrable');

  if (request.method === 'OPTIONS') {
    reply.code(204).send();
  }
});

// Root route to provide info about the service
app.get('/', async () => {
  return {
    name: 'PostgreSQL HTTP Proxy',
    version: '1.1.0',
    endpoints: [
      { path: '/query', method: 'POST', description: 'Execute SQL queries' },
      { path: '/transaction', method: 'POST', description: 'Execute transactions' },
      { path: '/health', method: 'GET', description: 'Health check endpoint' }
    ],
    documentation: 'https://github.com/samuellembke/drizzle-edge-pg-proxy-client'
  };
});

// Health check route
app.get('/health', async () => {
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      return { 
        status: 'ok',
        database: 'connected'
      };
    } finally {
      client.release();
    }
  } catch (error) {
    app.log.warn('Database connection failed in health check:', error.message);
    return { 
      status: 'ok',
      database: 'disconnected',
      message: 'Application is running but database connection failed'
    };
  }
});

// Query endpoint
app.post('/query', async (request, reply) => {
  return handleQuery(request, reply, pool, app.log);
});

// Transaction endpoint
app.post('/transaction', async (request, reply) => {
  return handleTransaction(request, reply, pool, app.log);
});

// Start the server
const start = async () => {
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Server listening on ${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

// Handle graceful shutdown
const shutdown = async () => {
  app.log.info('Shutting down server...');
  clearInterval(cleanupInterval);
  await app.close();
  await pool.end();
  app.log.info('Server successfully shut down');
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the server
start();
