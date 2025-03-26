# Drizzle Edge PostgreSQL Proxy Client

[![npm version](https://img.shields.io/npm/v/drizzle-edge-pg-proxy-client.svg)](https://www.npmjs.com/package/drizzle-edge-pg-proxy-client)
[![Build Status](https://img.shields.io/github/workflow/status/samuellembke/drizzle-edge-pg-proxy-client/CI)](https://github.com/samuellembke/drizzle-edge-pg-proxy-client/actions)
[![License](https://img.shields.io/npm/l/drizzle-edge-pg-proxy-client.svg)](https://github.com/samuellembke/drizzle-edge-pg-proxy-client/blob/main/LICENSE)

A client library for connecting to PostgreSQL databases from edge environments (Cloudflare Workers, Vercel Edge Functions, Deno Deploy, etc.) via an HTTP proxy. This package is compatible with [Drizzle ORM](https://orm.drizzle.team/) and designed to work in all environments that support the Fetch API.

> CURRENTLY BROKEN

## 🌟 Features

- 🚀 **Edge-Ready**: Works in all edge environments with fetch API support
- 🔌 **Drizzle ORM Compatible**: Drop-in replacement for Drizzle's PostgreSQL client
- 🔒 **Secure**: Support for authentication via bearer token
- 📦 **Lightweight**: Small bundle size, perfect for edge deployments
- 📝 **TypeScript**: Full TypeScript support with proper type definitions
- 🔄 **Transactions**: Support for running multiple queries in a transaction
- 🧪 **Tested**: Comprehensive test suite for reliability
- 📊 **Array Support**: Full PostgreSQL array parsing with element type awareness
- 🔄 **Type System**: Comprehensive type system for PostgreSQL data types

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
  arrayMode?: boolean;
  fullResults?: boolean;
  typeParser?: TypeParser | Record<number, (value: string) => any>;
}): PostgresJsDatabase<TSchema>
```

Creates a Drizzle ORM client connected to your PostgreSQL database via an HTTP proxy.

**Parameters:**
- `options`: Configuration object
  - `proxyUrl`: URL of the PostgreSQL HTTP proxy server
  - `authToken` (optional): Authentication token for the proxy server
  - `schema`: Drizzle ORM schema definition
  - `fetch` (optional): Custom fetch implementation (uses global fetch by default)
  - `arrayMode` (optional): When true, returns results as arrays instead of objects
  - `fullResults` (optional): When true, returns complete result objects with metadata
  - `typeParser` (optional): Custom type parser instance or type parser configuration

**Returns:** Drizzle ORM database client

### createPgHttpClient

```typescript
function createPgHttpClient(options: ClientOptions): PgHttpClient

interface ClientOptions {
  proxyUrl: string;
  authToken?: string;
  fetch?: typeof globalThis.fetch;
  arrayMode?: boolean;
  fullResults?: boolean;
  typeParser?: TypeParser | Record<number, (value: string) => any>;
}
```

Creates a raw PostgreSQL HTTP client.

**Parameters:**
- `proxyUrl`: URL of the PostgreSQL HTTP proxy server
- `authToken` (optional): Authentication token for the proxy server
- `fetch` (optional): Custom fetch implementation (uses global fetch by default)
- `arrayMode` (optional): When true, returns results as arrays instead of objects
- `fullResults` (optional): When true, returns complete result objects with metadata
- `typeParser` (optional): Custom type parser instance or type parser configuration

**Returns:** A client with the following methods:
- `execute(query: string, params?: unknown[]): Promise<PgQueryResult>`: Execute a SQL query with parameters
- `sql(strings: TemplateStringsArray, ...values: unknown[]): QueryPromise<PgQueryResult>`: Create a SQL template literal query
- `transaction(queries: { text: string, values: unknown[] }[], options?): Promise<PgQueryResult[]>`: Execute multiple queries in a transaction
- `query(query: string, params?: unknown[], options?): Promise<PgQueryResult>`: Direct query execution with options
- `unsafe(rawSql: string): UnsafeRawSql`: Create unsafe raw SQL for trusted inputs
- `typeParser`: Access to the type parser instance for custom type handling

### TypeParser

```typescript
class TypeParser {
  constructor(customTypes?: Record<number, (value: string) => any>);
  
  // Add or override a type parser
  setTypeParser(typeId: number, parseFn: (value: string) => any): void;
  
  // Get a parser function for a specific type
  getTypeParser(typeId: number): (value: string) => any;
}
```

Custom type parser for PostgreSQL data types.

**Example: Using a custom type parser**

```typescript
import { createPgHttpClient, TypeParser, PgTypeId } from 'drizzle-edge-pg-proxy-client';

// Create a custom type parser
const customTypeParser = new TypeParser();

// Override the default date parser to use a custom format
customTypeParser.setTypeParser(PgTypeId.DATE, (dateStr) => {
  return new Date(dateStr + 'T00:00:00Z');
});

// Add a parser for a custom type
customTypeParser.setTypeParser(1234, (value) => {
  return JSON.parse(value); // Example: parse a custom JSON type
});

// Use the custom type parser with the client
const client = createPgHttpClient({
  proxyUrl: 'https://your-pg-proxy-url.com',
  typeParser: customTypeParser
});

// Or pass a type parser configuration directly
const client2 = createPgHttpClient({
  proxyUrl: 'https://your-pg-proxy-url.com',
  typeParser: {
    [PgTypeId.DATE]: (dateStr) => new Date(dateStr + 'T00:00:00Z'),
    [PgTypeId.JSON]: (jsonStr) => JSON.parse(jsonStr)
  }
});
```

**PgTypeId**

The `PgTypeId` enum provides constants for all standard PostgreSQL data type OIDs:

```typescript
enum PgTypeId {
  BOOL = 16,
  BYTEA = 17,
  INT8 = 20,
  INT2 = 21,
  INT4 = 23,
  TEXT = 25,
  JSON = 114,
  JSONB = 3802,
  FLOAT4 = 700,
  FLOAT8 = 701,
  DATE = 1082,
  TIMESTAMP = 1114,
  TIMESTAMPTZ = 1184,
  // ... and many more
}
```

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

## 📋 Changelog

### Version 0.3.0 (Latest)

Major architectural update for transaction handling:

- ✅ **Server-Side Transaction Context**: Moved transaction context handling from client to proxy server
- ✅ **Enhanced Docker Proxy**: Updated proxy with intelligent DEFAULT keyword processing for Auth.js compatibility
- ✅ **Neon-Aligned Architecture**: Matched Neon's architecture where the server handles transaction state
- ✅ **Automatic Foreign Key Detection**: Server detects relationships between tables for proper ID propagation
- ✅ **Full Auth.js Compatibility**: Complete compatibility with Auth.js transaction patterns

This version represents a significant architectural shift. Instead of attempting to handle transaction context in the client, the proxy server now intelligently processes transaction batches, detects RETURNING values, and handles DEFAULT keyword substitution. This approach matches Neon's architecture and provides more robust transaction handling for all use cases.

> **Important**: To use this version, you must use our updated PostgreSQL HTTP proxy (v1.1.0+) that supports transaction context handling.

### Version 0.2.11

Targeted Auth.js compatibility approach:

### Version 0.2.10

Modified transaction handling with focus on standard behavior:

- ✅ **Native PostgreSQL Approach**: Maintained standard PostgreSQL behavior for most DEFAULT keywords
- ✅ **Query Preservation**: Transmitted SQL statements with minimal client-side manipulation
- ✅ **Broad Compatibility**: Improved reliability across various ORM patterns

### Version 0.2.9

Added transaction enhancements that were later simplified:

- ✅ **ID Capturing**: Automatic detection of generated IDs from INSERT...RETURNING statements
- ✅ **DEFAULT Handling**: Added DEFAULT keyword handling for foreign key relationships
- ✅ **Pattern Recognition**: Foreign key relationship detection through column naming patterns

### Version 0.2.8

Previous version with basic ID propagation in transactions:

- ✅ **Generated ID Extraction**: Added automatic ID extraction from INSERT queries with RETURNING
- ✅ **Transaction Integration**: Propagates generated IDs between transaction steps
- ✅ **DEFAULT Keyword Support**: Support for SQL's DEFAULT keyword replacement
- ✅ **Foreign Key Handling**: Handling of foreign key references in multi-step transactions
- ✅ **Debugging Support**: Added logging to aid in troubleshooting transaction issues

### Version 0.2.7

This version added enhanced Auth.js compatibility:

- ✅ **Improved Array Handling**: Fixed `l.map is not a function` errors with safer array processing
- ✅ **Robust Row Processing**: Added additional safety checks for Auth.js data structures
- ✅ **Edge Case Handling**: Better handling of non-array row data that Auth.js might pass
- ✅ **Enhanced Error Reporting**: Better context for connection and query errors
- ✅ **Boundary Checks**: Added index bounds checking to prevent out-of-range errors

### Version 0.2.6

This version adds comprehensive array type parsing:

- ✅ **PostgreSQL Array Support**: Added robust array parsing with element type awareness
- ✅ **Multi-dimensional Arrays**: Support for nested arrays of any depth
- ✅ **Type-Aware Parsing**: Each array element is converted to the appropriate JavaScript type
- ✅ **Comprehensive Testing**: Added extensive tests for array parsing functionality
- ✅ **Auth.js Compatibility**: Improved compatibility with Auth.js's array-based data models

### Version 0.2.1

This version adds comprehensive type system support:

- ✅ **TypeParser Class**: Added a robust type parser system for PostgreSQL data types
- ✅ **Custom Type Parsers**: Support for user-defined type parsers
- ✅ **Default Parsers**: Built-in parsers for common PostgreSQL types (numeric, date/time, JSON, etc.)
- ✅ **Query Result Processing**: Automatic type conversion of query results based on column data types
- ✅ **Advanced Configuration**: New options for array mode and full results format

### Version 0.2.0

This version provides significant improvements to match Neon's client interface:

- ✅ **Enhanced Error Handling**: Added proper PostgreSQL error class with all standard Postgres error fields
- ✅ **Improved SQL Processing**: Better handling of parameter binding and type detection
- ✅ **Better Transaction Support**: Added support for transaction isolation levels, read-only and deferrable transactions
- ✅ **Binary Data Handling**: Improved handling of binary data with proper bytea conversion
- ✅ **Format Compatibility**: Response format now exactly matches Neon's for better compatibility with Auth.js

### Version 0.1.9

- Fixed compatibility issues with Auth.js by ensuring the query method is properly exposed and bound
- Fixed parameter binding in SQL templating to match Neon's interface

### Version 0.1.3

- Enhanced Auth.js support with better transaction handling
- Improved error detection for null constraint violations
- Added detailed debugging for Auth.js operations

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
