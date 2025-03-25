/**
 * Simple load test script for the PostgreSQL HTTP proxy
 * 
 * Usage:
 * 1. Start the proxy server: docker-compose up -d
 * 2. Run the load test: node load-test.js
 * 
 * Requirements: npm install autocannon -g
 */

const autocannon = require('autocannon');

// Configuration
const url = 'http://localhost:8080';
const connections = 100; // Concurrent connections
const duration = 10; // Test duration in seconds
const token = 'your-secret-token-here'; // Auth token from .env

// Test payload
const queryPayload = {
  sql: 'SELECT 1 as result',
  params: [],
  method: 'all'
};

// Run the test
async function runLoadTest() {
  console.log(`Starting load test on ${url} for ${duration} seconds with ${connections} connections`);
  
  const result = await autocannon({
    url: `${url}/query`,
    connections,
    duration,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    method: 'POST',
    body: JSON.stringify(queryPayload),
  });

  console.log('Load test completed!');
  console.log('===========================================');
  console.log(`Average Throughput: ${result.requests.average} req/sec`);
  console.log(`Max Throughput: ${result.requests.max} req/sec`);
  console.log(`Average Latency: ${result.latency.average} ms`);
  console.log(`Max Latency: ${result.latency.max} ms`);
  console.log(`Total Requests: ${result.requests.total}`);
  console.log(`Errors: ${result.errors}`);
  console.log('===========================================');
}

runLoadTest().catch(console.error);