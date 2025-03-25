/**
 * Example of using drizzle-edge-pg-proxy-client with Auth.js (formerly NextAuth.js)
 * This example demonstrates how to set up Auth.js with the DrizzleAdapter
 * and the PostgreSQL HTTP client for edge runtimes.
 */

import { drizzle } from 'drizzle-edge-pg-proxy-client';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { relations } from 'drizzle-orm';
import { pgTable, text, primaryKey, timestamp } from 'drizzle-orm/pg-core';
import NextAuth from 'next-auth';
import Discord from 'next-auth/providers/discord';

// Define your schema
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

// Create database client
const db = drizzle({
  // Make sure to use http:// for local development
  proxyUrl: process.env.DATABASE_PROXY_URL || 'http://localhost:7432',
  authToken: process.env.DATABASE_PROXY_TOKEN,
  schema: {
    users,
    accounts,
    sessions,
    verificationTokens,
    usersRelations,
    accountsRelations,
    sessionsRelations,
  }
});

// Configure Auth.js
export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers: [
    Discord({
      clientId: process.env.DISCORD_CLIENT_ID || '',
      clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    }),
    // Add other providers as needed
  ],
  // Add other Auth.js options here
  debug: process.env.NODE_ENV === 'development',
});

// Usage in Next.js App Router
// In app/api/auth/[...nextauth]/route.js:
// export { GET, POST } from './path/to/this/file';