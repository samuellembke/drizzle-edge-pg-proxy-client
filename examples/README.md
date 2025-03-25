# Examples

This directory contains examples of how to use the `drizzle-edge-pg-proxy-client` package.

## Client Examples

- [`basic-usage.ts`](./client/basic-usage.ts): Basic usage example of the Drizzle client.
- [`auth-js-example.ts`](./client/auth-js-example.ts): Complete example of using the client with Auth.js (NextAuth.js).

## Proxy Examples

- [`express-pg-proxy.js`](./proxy/express-pg-proxy.js): A simple PostgreSQL HTTP proxy implementation using Express.
- [`cloudflare-worker-proxy.js`](./proxy/cloudflare-worker-proxy.js): A serverless PostgreSQL HTTP proxy for Cloudflare Workers.

## Auth.js Integration Troubleshooting

When using this client with Auth.js (formerly NextAuth.js), you might encounter specific issues. Here's how to fix the most common problems:

### Foreign Key Constraint Errors

If you encounter errors like:

```
null value in column "user_id" of relation "account" violates not-null constraint
```

This usually means your proxy isn't handling transactions correctly. The issue happens because:

1. Auth.js first creates a user record with a RETURNING clause to get the user ID
2. Then tries to create an account record with that user_id
3. If the transaction doesn't properly pass the RETURNING clause results, the user_id will be null

**Solutions:**

1. **Modify your proxy implementation:**
   - Ensure it properly handles RETURNING clauses in SQL queries
   - Return the appropriate results from queries in transactions
   - Use the example proxy implementations provided here

2. **Check your schema definition:**
   - Make sure your foreign key constraints match Auth.js expectations
   - The account table must have a userId column that references the users table
   - Follow the schema example in the Auth.js example

3. **Verify transaction handling:**
   - Auth.js operations need proper transaction support
   - Transactions must execute queries sequentially, not in parallel
   - Results from earlier queries must be available to later queries

### Authentication Flow Issues

Auth.js has a complex authentication flow. If you're having issues:

1. **Enable debug mode:**
   ```typescript
   debug: process.env.NODE_ENV === 'development'
   ```

2. **Check query logs:**
   - Add logging to your proxy implementation to see what queries are being executed
   - Look for missing RETURNING clauses or incorrect column names

3. **Verify table names:**
   - Auth.js expects specific table names
   - If you're using custom names, make sure to use the correct configuration

### Connection Issues

1. **Correct Protocol:**
   - Use `http://` for local development
   - Use `https://` for production with proper SSL

2. **Edge Runtime Compatibility:**
   - Edge runtimes like Cloudflare Workers have specific requirements
   - Make sure your database proxy is accessible from your edge environment

### Comprehensive Schema Example

Here's a complete schema example for Auth.js with PostgreSQL:

```typescript
import { relations } from 'drizzle-orm';
import { pgTable, text, primaryKey, timestamp } from 'drizzle-orm/pg-core';

// Define tables
export const users = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name'),
  email: text('email').notNull().unique(),
  emailVerified: timestamp('email_verified', { mode: 'date' }),
  image: text('image'),
});

export const accounts = pgTable('account', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  provider: text('provider').notNull(),
  providerAccountId: text('provider_account_id').notNull(),
  refresh_token: text('refresh_token'),
  access_token: text('access_token'),
  expires_at: timestamp('expires_at', { mode: 'date' }),
  token_type: text('token_type'),
  scope: text('scope'),
  id_token: text('id_token'),
  session_state: text('session_state'),
}, (table) => {
  return {
    pk: primaryKey({ columns: [table.provider, table.providerAccountId] }),
  };
});

export const sessions = pgTable('session', {
  sessionToken: text('session_token').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { mode: 'date' }).notNull(),
});

export const verificationTokens = pgTable('verification_token', {
  identifier: text('identifier').notNull(),
  token: text('token').notNull(),
  expires: timestamp('expires', { mode: 'date' }).notNull(),
}, (table) => {
  return {
    pk: primaryKey({ columns: [table.identifier, table.token] }),
  };
});

// Define relations
export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));
```