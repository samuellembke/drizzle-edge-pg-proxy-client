import { neon, NeonQueryFunction } from '@neondatabase/serverless';
import pg from 'pg';

const { Pool } = pg;

// --- Configuration ---
// Ensure these environment variables are set before running!
const NEON_DB_URL_HTTP = process.env.NEON_DB_URL_HTTP; // Your Neon HTTP connection string
const STANDARD_PG_URL = process.env.STANDARD_PG_URL; // Your standard PostgreSQL connection string

// --- Schema Definition ---
const CREATE_USERS_TABLE = `
CREATE TABLE IF NOT EXISTS verify_users (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT
);
`;

const CREATE_ACCOUNTS_TABLE = `
CREATE TABLE IF NOT EXISTS verify_accounts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES verify_users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  provider TEXT NOT NULL,
  "providerAccountId" TEXT NOT NULL
);
`;

const DROP_TABLES = `
DROP TABLE IF EXISTS verify_accounts;
DROP TABLE IF EXISTS verify_users;
`;

// --- Test Logic ---

async function testNeonHttpAdapter(sql: NeonQueryFunction<false, true>) {
  console.log("\n--- Testing Neon HTTP Adapter ---");
  try {
    // Step 1: Setup Schema (separate transaction)
    console.log("Neon: Setting up schema...");
    await sql.transaction([
        sql`${sql.unsafe(DROP_TABLES)}`,
        sql`${sql.unsafe(CREATE_USERS_TABLE)}`,
        sql`${sql.unsafe(CREATE_ACCOUNTS_TABLE)}`
    ]);
    console.log("Neon: Schema setup complete.");

    // Step 2: Run the INSERT sequence in its own transaction
    console.log("Neon: Running INSERT sequence...");
    const results = await sql.transaction([
      sql`INSERT INTO verify_users (name) VALUES ('Test User Neon') RETURNING id`,
      // The problematic query using DEFAULT for the foreign key
      sql`INSERT INTO verify_accounts (user_id, type, provider, "providerAccountId") VALUES (DEFAULT, 'oauth', 'test-provider', '12345')`
    ]);

    // Check if the last insert (accounts) succeeded
    console.log("Neon HTTP Test: SUCCESS");
    if (results[0] && results[0].rows.length > 0) {
      console.log(`Neon: Inserted user ID: ${results[0].rows[0].id}`);
    }

  } catch (error: any) {
    console.error("Neon HTTP Test: FAILED");
    console.error(`  Error Code: ${error.code}`);
    console.error(`  Message: ${error.message}`);
    // console.error(error); // Uncomment for full stack trace
  } finally {
      // Optional: Clean up tables after test
      try {
          console.log("Neon: Cleaning up schema...");
          await sql`${sql.unsafe(DROP_TABLES)}`;
          console.log("Neon: Schema cleanup complete.");
      } catch (cleanupError) {
          console.error("Neon: Schema cleanup failed:", cleanupError);
      }
  }
}

async function testStandardPgAdapter(pool: pg.Pool) {
  console.log("\n--- Testing Standard PG Adapter ---");
  const client = await pool.connect();
  try {
    // Setup Schema
    console.log("Standard PG: Setting up schema...");
    await client.query(DROP_TABLES);
    await client.query(CREATE_USERS_TABLE);
    await client.query(CREATE_ACCOUNTS_TABLE);
    console.log("Standard PG: Schema setup complete.");

    // Run INSERT sequence in a transaction
    console.log("Standard PG: Running INSERT sequence...");
    await client.query('BEGIN');
    const userInsertResult = await client.query(`INSERT INTO verify_users (name) VALUES ('Test User Standard') RETURNING id`);
    const userId = userInsertResult.rows[0]?.id;
    console.log(`Standard PG: Inserted user ID: ${userId}`);

    // The problematic query using DEFAULT for the foreign key
    await client.query(`INSERT INTO verify_accounts (user_id, type, provider, "providerAccountId") VALUES (DEFAULT, 'oauth', 'test-provider', '54321')`);

    await client.query('COMMIT');
    console.log("Standard PG Test: SUCCESS");

  } catch (error: any) {
    // Rollback on error during INSERT sequence
    try { await client.query('ROLLBACK'); } catch (rbError) { console.error("Standard PG: Rollback failed", rbError); }
    console.error("Standard PG Test: FAILED");
    console.error(`  Error Code: ${error.code}`);
    console.error(`  Message: ${error.message}`);
    // console.error(error); // Uncomment for full stack trace
  } finally {
    // Clean up tables
    try {
        console.log("Standard PG: Cleaning up schema...");
        await client.query(DROP_TABLES);
        console.log("Standard PG: Schema cleanup complete.");
    } catch (cleanupError) {
        console.error("Standard PG: Schema cleanup failed:", cleanupError);
    }
    client.release();
  }
}

// --- Main Execution ---

async function runTests() {
  if (!NEON_DB_URL_HTTP) {
    console.warn("Skipping Neon test: NEON_DB_URL_HTTP environment variable not set.");
  } else {
    const sql = neon(NEON_DB_URL_HTTP, { fullResults: true });
    await testNeonHttpAdapter(sql);
  }

  if (!STANDARD_PG_URL) {
    console.warn("Skipping Standard PG test: STANDARD_PG_URL environment variable not set.");
  } else {
    const pool = new Pool({ connectionString: STANDARD_PG_URL });
    await testStandardPgAdapter(pool);
    await pool.end(); // Close the pool
  }
}

runTests().catch(console.error);
