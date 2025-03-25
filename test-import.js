// test-import.js
import { drizzle, createPgHttpClient } from './dist/index.js';

console.log('Successfully imported drizzle:', typeof drizzle);
console.log('Successfully imported createPgHttpClient:', typeof createPgHttpClient);

// Create a simple test client
const client = createPgHttpClient({
  proxyUrl: 'http://localhost:7432',
  authToken: 'test-token'
});

console.log('Client:', client);