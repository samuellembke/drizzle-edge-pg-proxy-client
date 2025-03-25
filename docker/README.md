# High-Performance PostgreSQL HTTP Proxy

This directory contains a high-performance PostgreSQL HTTP proxy implementation using Docker and Docker Compose. The proxy is built with Fastify and uses pg-native for optimal performance when communicating with PostgreSQL.

## Features

- **High Performance**: Built with Fastify, significantly faster than Express.js
- **Connection Pooling**: Pre-configured connection pool for optimal database performance
- **Native PostgreSQL Driver**: Uses pg-native for better performance
- **Response Compression**: Optional gzip compression for smaller response sizes
- **Authentication**: Secure your proxy with token-based authentication
- **Graceful Shutdown**: Proper handling of shutdown signals
- **Health Checks**: Built-in health check endpoint
- **Docker Ready**: Easy deployment with Docker and Docker Compose
- **PostgreSQL Included**: Bundled PostgreSQL database for quick testing

## Requirements

- Docker
- Docker Compose

## Quick Start

1. Create a `.env` file in the repository root with your configuration:

```env
# Required: Your PostgreSQL connection string
DATABASE_URL=postgres://username:password@your-postgres-host:5432/database

# Optional: Authentication token for proxy security
AUTH_TOKEN=your-secret-token

# Optional: Configure the exposed port on your host machine
HTTP_PORT=7432

# Optional: Configure the port inside the container
CONTAINER_PORT=8080
```

2. Start the proxy:

```bash
# From the repository root directory
docker-compose up -d
```

**Note**: You need to provide your own PostgreSQL database. The proxy does not include a database - it simply connects to your existing database.

3. Use the client library to connect to your proxy:

```typescript
import { drizzle } from 'drizzle-edge-pg-proxy-client';
import { users } from './schema';

const db = drizzle({
  proxyUrl: 'http://localhost:8080',
  authToken: 'your-secret-token',
  schema: { users },
});

const allUsers = await db.select().from(users);
```

## Configuration

The proxy can be configured using environment variables in the docker-compose.yml file:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://postgres:postgres@postgres:5432/postgres` |
| `AUTH_TOKEN` | Authentication token | None (auth disabled) |
| `PORT` | HTTP port to listen on | `8080` |
| `DB_POOL_MIN` | Minimum pool size | `5` |
| `DB_POOL_MAX` | Maximum pool size | `20` |
| `DB_POOL_IDLE_TIMEOUT` | Idle timeout in ms | `10000` |
| `ENABLE_COMPRESSION` | Enable response compression | `true` |
| `NODE_OPTIONS` | Node.js options | `--max-old-space-size=2048` |

## API Endpoints

### Health Check

```
GET /health
```

Returns `{"status":"ok"}` if the service is healthy.

### Execute Query

```
POST /query
```

Body:
```json
{
  "sql": "SELECT * FROM users WHERE id = $1",
  "params": [1],
  "method": "all"
}
```

- `sql`: SQL query to execute
- `params`: Array of parameters
- `method`: Result method, either "all" (default) or "single"

### Execute Transaction

```
POST /transaction
```

Body:
```json
{
  "queries": [
    {
      "sql": "INSERT INTO users (name, email) VALUES ($1, $2)",
      "params": ["Alice", "alice@example.com"],
      "method": "all"
    },
    {
      "sql": "UPDATE users SET name = $1 WHERE id = $2",
      "params": ["Bob", 1],
      "method": "all"
    }
  ]
}
```

## Auth.js (NextAuth.js) Integration

This proxy is optimized for use with Auth.js (formerly NextAuth.js) and includes special handling for Auth.js operations.

### Key Features for Auth.js

1. **Transaction Support**: Properly handles transactions for user creation and account linking
2. **RETURNING Clause Support**: Ensures proper foreign key relationships between users and accounts
3. **Debug Logging**: Special logging for Auth.js operations to aid in troubleshooting
4. **Null Constraint Prevention**: Helps prevent the common "null value in column user_id" error

### Debug Mode

To enable detailed debugging for Auth.js operations, set:

```env
LOG_LEVEL=debug
```

This will show detailed logs about user creation, account linking, and transaction operations.

### Common Auth.js Issues

If you encounter errors like:

```
null value in column "user_id" of relation "account" violates not-null constraint
```

This proxy has special handling to log and debug these issues. Check the logs for:

1. Warnings about missing RETURNING clauses
2. Account creation operations without prior user creation
3. Transaction query sequencing issues

### Example Auth.js Configuration

```typescript
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { drizzle } from "drizzle-edge-pg-proxy-client";
import { users, accounts, sessions, verificationTokens } from "./schema";

// Create the database client
const db = drizzle({
  proxyUrl: process.env.DATABASE_PROXY_URL || "http://localhost:7432",
  authToken: process.env.DATABASE_PROXY_TOKEN,
  schema: { users, accounts, sessions, verificationTokens }
});

// Auth.js configuration
export const authConfig = {
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  // Other Auth.js options...
};
```

## Performance Tuning

This proxy is configured for high performance, but you can tune it further:

1. **Connection Pool**: Adjust the `DB_POOL_MIN` and `DB_POOL_MAX` based on your workload
2. **Memory**: Adjust `NODE_OPTIONS` if you need more memory
3. **CPU**: Add more CPU resources to the container in docker-compose.yml

## Production Deployment

For production deployments, we recommend:

1. **Reverse Proxy**: Use Nginx as a reverse proxy (we provide a [sample configuration](./nginx.conf))
2. **TLS/SSL**: Enable HTTPS in your reverse proxy
3. **Managed Database**: Use a managed PostgreSQL service instead of the bundled one
4. **Monitoring**: Set up proper monitoring and logging (e.g., Prometheus, Grafana)
5. **High Availability**: Run multiple replicas of the proxy behind a load balancer
6. **Security**: Use a strong authentication token and restrict network access
7. **Resource Tuning**: Adjust container resources based on your workload

### Load Testing

To ensure your deployment can handle the expected load, you can use the included load testing script:

```bash
# Install autocannon
npm install -g autocannon

# Run the load test
node load-test.js
```

This will simulate 100 concurrent users making requests to your proxy for 10 seconds and report throughput and latency metrics.

### Nginx Configuration

We provide a sample [Nginx configuration](./nginx.conf) that includes:

- Reverse proxy setup
- HTTP/2 support
- SSL/TLS with recommended settings
- HSTS for secure connections
- Rate limiting to prevent abuse
- Response caching where appropriate
- Security headers

To use it:

1. Copy the configuration to your Nginx server
2. Adjust the server name and paths
3. Uncomment the HTTPS section and provide SSL certificates
4. Reload Nginx

## Building Custom Images

```bash
docker build -t pg-edge-proxy -f docker/Dockerfile .
```