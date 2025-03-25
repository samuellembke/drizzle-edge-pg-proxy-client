import { drizzle, createPgHttpClient } from '../src';
// These imports are needed only for TypeScript type definitions
import { sql } from 'drizzle-orm';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';

// Define your schema
const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  age: integer('age'),
});

// Create a Drizzle client
const db = drizzle({
  proxyUrl: 'https://your-pg-proxy-url.com',
  authToken: 'your-secret-token',
  schema: { users },
});

// Example of using Drizzle ORM
async function getUsers() {
  return db.select().from(users);
}

async function createUser(name: string, email: string, age?: number) {
  return db.insert(users).values({ name, email, age }).returning();
}

async function getUserById(id: number) {
  return db.select().from(users).where(sql`${users.id} = ${id}`).limit(1);
}

// Example of using raw SQL client
async function rawSqlExample() {
  const client = createPgHttpClient({
    proxyUrl: 'https://your-pg-proxy-url.com',
    authToken: 'your-secret-token',
  });

  // Direct query execution
  const allUsers = await client.execute('SELECT * FROM users LIMIT 10');
  console.log('All users:', allUsers);

  // SQL template literals
  const user = await client.sql`SELECT * FROM users WHERE id = ${1}`.execute();
  console.log('User with ID 1:', user[0]);

  // Transactions
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
  console.log('Transaction results:', results);
}

// Export for use in examples or tests
export { getUsers, createUser, getUserById, rawSqlExample };