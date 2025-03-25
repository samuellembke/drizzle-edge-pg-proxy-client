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
  - [Using with Auth.js in Next.js](#using-with-authjs-in-nextjs)
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
- [Troubleshooting](#-troubleshooting)

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
  proxyUrl: 'http://localhost:7432', // Use http:// for local development
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

### Using with Auth.js in Next.js

This package can be used with Auth.js (formerly NextAuth.js) using the Drizzle adapter. Here's how to set it up:

```typescript
// src/server/db/index.ts
import { drizzle } from 'drizzle-edge-pg-proxy-client';
import * as schema from "./schema";

// Make sure to use http:// for local development
export const db = drizzle({
  proxyUrl: process.env.DATABASE_PROXY_URL || 'http://localhost:7432',
  authToken: process.env.DATABASE_PROXY_TOKEN,
  schema
});
```

Then in your Auth.js configuration:

```typescript
// src/server/auth/config.ts
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "../db";
import { users, accounts, sessions, verificationTokens } from "../db/schema";

export const authConfig = {
  // Your other Auth.js config...
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  // ...
};
```

**Important Note for Next.js Edge Runtime or Middleware**:
If you're using this in the Edge Runtime or middleware, be aware that you need to:

1. Use the correct URL protocol (http:// vs https://) depending on your environment.
2. Make sure your PostgreSQL proxy is accessible from the edge environment.
3. In development, use http:// for localhost connections.

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

> **New in v0.1.3**: Enhanced Auth.js (NextAuth.js) support with improved transaction handling, better error detection for null constraint violations, and detailed debugging for Auth.js operations. See the [Docker README](./docker/README.md) for more details.

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

Now you can connect to your proxy at `http://localhost:7432` and start using it with the client.

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
   - `HTTP_PORT` - (Optional) External port for the proxy (default: 7432)
   - `CONTAINER_PORT` - (Optional) Internal container port (default: 8080)
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

## 🔧 Troubleshooting

### Error: ERR_SSL_WRONG_VERSION_NUMBER

If you encounter an error like `ERR_SSL_WRONG_VERSION_NUMBER` when trying to connect to your PostgreSQL proxy, it usually indicates one of these issues:

1. **Incorrect Protocol**: You're using `https://` when you should be using `http://` (or vice versa). In local development, use `http://`.

   ```typescript
   // Correct for local development
   const db = drizzle({
     proxyUrl: 'http://localhost:7432',
     // ...
   });
   ```

2. **Proxy Not Running**: Your PostgreSQL proxy server isn't running or isn't accessible at the specified URL.

3. **Middleware/Edge Runtime Restrictions**: When using in Next.js middleware or Edge Runtime, there might be additional restrictions on network requests. Make sure your proxy is accessible from these environments.

### Auth.js DrizzleAdapter Errors

If you encounter errors with the Auth.js DrizzleAdapter like "Unsupported database type", make sure:

1. You're using the correct version of `@auth/drizzle-adapter` that's compatible with your Auth.js version
2. The adapter has correct table configurations
3. The database client is correctly initialized before the adapter

If you encounter foreign key constraint errors such as `null value in column "user_id" of relation "account" violates not-null constraint`, this indicates that your proxy implementation isn't correctly handling transactions with RETURNING clauses. Auth.js typically:

1. Creates a user record with a RETURNING clause to get the user ID
2. Uses that ID to create related records (accounts, sessions)

To fix this issue:

1. Ensure your PostgreSQL proxy properly handles RETURNING clauses in SQL queries
2. Properly returns results from transactions in sequence
3. Check your schema to ensure foreign key constraints match what Auth.js expects:

```typescript
// Example of proper Auth.js schema with Drizzle
import { relations } from "drizzle-orm";
import { pgTable, text, primaryKey, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").notNull().unique(),
  // other user fields
});

export const accounts = pgTable("account", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  // other account fields
},
(table) => {
  return {
    pk: primaryKey({ columns: [table.provider, table.providerAccountId] }),
  };
});

// Define relations
export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));
```

### Other Connection Issues

1. **Check Proxy Logs**: Check the logs of your PostgreSQL HTTP proxy for any errors
2. **Verify Environment Variables**: Make sure all required environment variables are set correctly
3. **Network Access**: In production, ensure your Edge functions have network access to your proxy server
4. **CORS Issues**: If you're getting CORS errors, make sure your proxy server has appropriate CORS headers configured

For more detailed debugging, try:

```typescript
// Add this to see more details about connection issues
console.error = (...args) => {
  console.log('Error:', ...args);
};

// Then initialize your client
const db = drizzle({
  proxyUrl: 'http://localhost:7432',
  // ...
});
```