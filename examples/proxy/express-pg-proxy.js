/**
 * Example PostgreSQL HTTP Proxy Implementation using Express
 * 
 * This is a basic example of how to create a proxy server that can be used with
 * the drizzle-edge-pg-proxy-client package. This example uses Express and node-postgres.
 * 
 * To use this:
 * 1. Install dependencies: npm install express pg cors dotenv
 * 2. Create a .env file with DATABASE_URL and AUTH_TOKEN variables
 * 3. Run the server: node proxy-implementation.js
 */

import express from 'express';
import pg from 'pg';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const { Pool } = pg;

// Create a PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Middleware
app.use(cors());
app.use(express.json());

// Authentication middleware
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!process.env.AUTH_TOKEN || process.env.AUTH_TOKEN === token) {
    return next();
  }
  
  return res.status(401).json({ error: 'Unauthorized' });
};

// Query endpoint
app.post('/query', authenticate, async (req, res) => {
  const { sql, params, method } = req.body;
  
  if (!sql) {
    return res.status(400).json({ error: 'SQL query is required' });
  }
  
  try {
    const result = await pool.query(sql, params || []);
    return res.json(result.rows);
  } catch (error) {
    console.error('Database error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Transaction endpoint
app.post('/transaction', authenticate, async (req, res) => {
  const { queries } = req.body;
  
  if (!queries || !Array.isArray(queries)) {
    return res.status(400).json({ error: 'An array of queries is required' });
  }
  
  // Get a client from the pool
  const client = await pool.connect();
  
  try {
    // Start a transaction
    await client.query('BEGIN');
    
    // Execute all queries
    const results = [];
    for (const query of queries) {
      const { sql, params } = query;
      const result = await client.query(sql, params || []);
      results.push(result.rows);
    }
    
    // Commit the transaction
    await client.query('COMMIT');
    
    return res.json(results);
  } catch (error) {
    // Rollback in case of error
    await client.query('ROLLBACK');
    console.error('Transaction error:', error);
    return res.status(500).json({ error: error.message });
  } finally {
    // Release the client back to the pool
    client.release();
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start the server
app.listen(port, () => {
  console.log(`PostgreSQL HTTP proxy server running on port ${port}`);
});