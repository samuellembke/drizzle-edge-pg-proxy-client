# Drizzle Edge PostgreSQL Proxy Client

[![npm version](https://img.shields.io/npm/v/drizzle-edge-pg-proxy-client.svg)](https://www.npmjs.com/package/drizzle-edge-pg-proxy-client)
[![Build Status](https://img.shields.io/github/workflow/status/samuellembke/drizzle-edge-pg-proxy-client/CI)](https://github.com/samuellembke/drizzle-edge-pg-proxy-client/actions)
[![License](https://img.shields.io/npm/l/drizzle-edge-pg-proxy-client.svg)](https://github.com/samuellembke/drizzle-edge-pg-proxy-client/blob/main/LICENSE)

A client library for connecting to PostgreSQL databases from edge environments (Cloudflare Workers, Vercel Edge Functions, Deno Deploy, etc.) via an HTTP proxy. This package is compatible with [Drizzle ORM](https://orm.drizzle.team/) and designed to work in all environments that support the Fetch API.

## 🌟 Features

- 🚀 **Edge-Ready**: Works in all edge environments with fetch API support
- 🔌 **Drizzle ORM Compatible**: Drop-in replacement for Drizzle's PostgreSQL client
- 🔒 **Secure**: Support for authentication via bearer token
- 📦 **Lightweight**: Small bundle size, perfect for edge deployments
- 📝 **TypeScript**: Full TypeScript support with proper type definitions
- 🔄 **Transactions**: Support for running multiple queries in a transaction
- 🧪 **Tested**: Comprehensive test suite for reliability

## 📋 Table of Contents

- [Installation](#-installation)
- [Quick Start](#-quick-start)
- [Usage](#-usage)
  - [Basic Usage with Drizzle ORM](#basic-usage-with-drizzle-orm)
  - [Raw SQL Queries](#raw-sql-queries)
  - [SQL Template Literals](#sql-template-literals)
  - [Transactions](#transactions)
- [API Reference](#-api-reference)
  - [drizzle](#drizzle)
  - [createPgHttpClient](#createpghttpclient)
- [Setting Up a PostgreSQL HTTP Proxy](#-setting-up-a-postgresql-http-proxy)
  - [Docker Quick Start](#docker-quick-start)
- [Examples](#-examples)
- [Development](#-development)
- [License](#-license)

## 📥 Installation

```bash
# Using npm
npm install drizzle-edge-pg-proxy-client drizzle-orm

# Using yarn
yarn add drizzle-edge-pg-proxy-client drizzle-orm

# Using pnpm
pnpm add drizzle-edge-pg-proxy-client drizzle-orm

# Using bun
bun add drizzle-edge-pg-proxy-client drizzle-orm
```

## 🚀 Quick Start

```typescript
import { drizzle } from 'drizzle-edge-pg-proxy-client';
import { eq } from 'drizzle-orm';
import { users } from './schema';

// Create a Drizzle client
const db = drizzle({
  proxyUrl: 'https://your-pg-proxy-url.com',
  authToken: 'your-secret-token', // Optional
  schema: { users },
});

// Use it like any other Drizzle client
export async function getUser(id: string) {
  return db.select().from(users).where(eq(users.id, id));
}
```

## 📖 Usage

### Basic Usage with Drizzle ORM

First, define your schema using Drizzle's schema definition:

```typescript
import { pgTable, serial, text, integer } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  age: integer('age'),
});
```

Then, create a Drizzle client and use it to query your database:

```typescript
import { drizzle } from 'drizzle-edge-pg-proxy-client';
import { eq } from 'drizzle-orm';
import { users } from './schema';

const db = drizzle({
  proxyUrl: 'https://your-pg-proxy-url.com',
  authToken: 'your-secret-token', // Optional
  schema: { users },
});

// Select all users
const allUsers = await db.select().from(users);

// Select a specific user
const user = await db.select().from(users).where(eq(users.id, 1));

// Insert a new user
const newUser = await db.insert(users).values({
  name: 'Alice',
  email: 'alice@example.com',
  age: 30,
}).returning();

// Update a user
await db.update(users)
  .set({ name: 'Bob' })
  .where(eq(users.id, 1));

// Delete a user
await db.delete(users).where(eq(users.id, 1));
```

### Raw SQL Queries

If you prefer to use raw SQL queries, you can use the `createPgHttpClient` function:

```typescript
import { createPgHttpClient } from 'drizzle-edge-pg-proxy-client';

const client = createPgHttpClient({
  proxyUrl: 'https://your-pg-proxy-url.com',
  authToken: 'your-secret-token', // Optional
});

// Execute a query directly
const users = await client.execute(
  'SELECT * FROM users WHERE email = $1',
  ['user@example.com']
);

console.log(users); // Array of user objects
```

### SQL Template Literals

The client also supports SQL template literals:

```typescript
import { createPgHttpClient } from 'drizzle-edge-pg-proxy-client';

const client = createPgHttpClient({
  proxyUrl: 'https://your-pg-proxy-url.com',
});

const userId = 1;
const result = await client.sql`
  SELECT * FROM users WHERE id = ${userId}
`.execute();

console.log(result); // Array of results
```

### Transactions

You can also run multiple queries in a transaction:

```typescript
import { createPgHttpClient } from 'drizzle-edge-pg-proxy-client';

const client = createPgHttpClient({
  proxyUrl: 'https://your-pg-proxy-url.com',
});

const results = await client.transaction([
  { 
    text: 'INSERT INTO users (name, email) VALUES ($1, $2)',
    values: ['Alice', 'alice@example.com']
  },
  {
    text: 'UPDATE users SET name = $1 WHERE email = $2',
    values: ['Bob', 'bob@example.com']
  }
]);

// results[0] contains the results of the first query
// results[1] contains the results of the second query
```

## 📚 API Reference

### drizzle

```typescript
function drizzle<TSchema extends Record<string, unknown>>(options: {
  proxyUrl: string;
  authToken?: string;
  schema: TSchema;
  fetch?: typeof globalThis.fetch;
}): PostgresJsDatabase<TSchema>
```

Creates a Drizzle ORM client connected to your PostgreSQL database via an HTTP proxy.

**Parameters:**
- `options`: Configuration object
  - `proxyUrl`: URL of the PostgreSQL HTTP proxy server
  - `authToken` (optional): Authentication token for the proxy server
  - `schema`: Drizzle ORM schema definition
  - `fetch` (optional): Custom fetch implementation (uses global fetch by default)

**Returns:** Drizzle ORM database client

### createPgHttpClient

```typescript
function createPgHttpClient({
  proxyUrl,
  authToken,
  fetch,
}: {
  proxyUrl: string;
  authToken?: string;
  fetch?: typeof globalThis.fetch;
}): PgHttpClient
```

Creates a raw PostgreSQL HTTP client.

**Parameters:**
- `proxyUrl`: URL of the PostgreSQL HTTP proxy server
- `authToken` (optional): Authentication token for the proxy server
- `fetch` (optional): Custom fetch implementation (uses global fetch by default)

**Returns:** A client with the following methods:
- `execute(query: string, params?: unknown[]): Promise<any[]>`: Execute a SQL query with parameters
- `sql(strings: TemplateStringsArray, ...values: unknown[]): SqlQueryResult`: Create a SQL template literal query
- `transaction(queries: { text: string, values: unknown[] }[]): Promise<any[]>`: Execute multiple queries in a transaction
- `query(query: string, params?: unknown[]): Promise<any[]>`: Alias for execute

## 🔄 Setting Up a PostgreSQL HTTP Proxy

This client requires a PostgreSQL HTTP proxy server. You can implement your own, use the provided Docker implementation, or adapt one of the example implementations to your needs.

A basic proxy implementation requires:

1. An endpoint that accepts POST requests to `/query` with a JSON body containing:
   ```json
   {
     "sql": "SELECT * FROM users WHERE id = $1",
     "params": [1],
     "method": "all"
   }
   ```

2. An endpoint that accepts POST requests to `/transaction` with a JSON body containing:
   ```json
   {
     "queries": [
       {
         "sql": "INSERT INTO users (name) VALUES ($1)",
         "params": ["Alice"],
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

3. Authentication via bearer token (optional but recommended)

### Docker Quick Start

We provide a high-performance PostgreSQL HTTP proxy implementation using Docker and Docker Compose. This is the easiest way to get started.

```bash
# Clone the repository
git clone https://github.com/samuellembke/drizzle-edge-pg-proxy-client.git
cd drizzle-edge-pg-proxy-client

# Configure your database connection in .env file
# Start the proxy (connects to your external PostgreSQL database)
docker-compose up -d
```

Now you can connect to your proxy at `http://localhost:8080` and start using it with the client.

For more information, see the [Docker README](./docker/README.md).

### Deployment

This repository is configured for easy deployment with platforms like Coolify. The necessary Docker configuration files are located in the repository root:

- `docker-compose.yml` - Docker Compose configuration
- `Dockerfile` - Docker build instructions
- `.env.coolify` - Example environment variables for Coolify

#### Deploying to Coolify

1. Connect your repository to Coolify
2. Set up the required environment variables:
   - `DATABASE_URL` - Connection string to your PostgreSQL database
   - `AUTH_TOKEN` - (Optional) Secret token for proxy authentication
3. Deploy the application

**Important**: You must provide your own PostgreSQL database. The proxy service will connect to your existing database using the `DATABASE_URL` environment variable.

### Example Proxy Implementations

For other environments, we provide example implementations:

- **[Fastify (Docker)](./docker/)**: A high-performance proxy using Fastify and pg-native (recommended)
- **[Node.js/Express](./examples/proxy/express-pg-proxy.js)**: A simple proxy using Express and node-postgres
- **[Cloudflare Worker](./examples/proxy/cloudflare-worker-proxy.js)**: A serverless proxy for Cloudflare Workers

## 📂 Examples

Check out the [examples directory](./examples) for more usage examples.

## 🛠️ Development

```bash
# Clone the repository
git clone https://github.com/samuellembke/drizzle-edge-pg-proxy-client.git
cd drizzle-edge-pg-proxy-client

# Install dependencies
bun install

# Run in development mode with watch
bun run dev

# Build the package
bun run build

# Run tests
bun test

# Run linting
bun run lint
```

## 📄 License

MIT