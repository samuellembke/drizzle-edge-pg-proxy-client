# Examples

This directory contains various examples to help you get started with the `drizzle-edge-pg-proxy-client` package.

## Client Examples

These examples show how to use the client library in your application:

- [Basic Usage](./client/basic-usage.ts) - How to use the client with Drizzle ORM and raw SQL queries

## Proxy Examples

These examples show how to implement a PostgreSQL HTTP proxy server:

- [Express Proxy](./proxy/express-pg-proxy.js) - A proxy server using Express and node-postgres
- [Cloudflare Worker Proxy](./proxy/cloudflare-worker-proxy.js) - A proxy server using Cloudflare Workers and Neon Database

## Setting Up

To run these examples:

1. Clone the repository:
   ```bash
   git clone https://github.com/samuellembke/drizzle-edge-pg-proxy-client.git
   cd drizzle-edge-pg-proxy-client
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Build the package:
   ```bash
   bun run build
   ```

4. For the Express proxy example, you'll need to:
   ```bash
   cd examples/proxy
   npm install express pg cors dotenv
   node express-pg-proxy.js
   ```

## Contributing

If you'd like to contribute more examples, please submit a pull request!