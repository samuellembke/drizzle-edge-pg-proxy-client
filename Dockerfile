FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files
COPY package.json ./
COPY bun.lock ./

# Install dependencies
RUN bun install

# Copy project files
COPY . .

# Build the application
RUN bun run build

# Production stage
FROM oven/bun:1-slim AS runner

WORKDIR /app

# Set production environment
ENV NODE_ENV=production

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/docker/src ./src
COPY --from=builder /app/package.json ./

# Install only production dependencies
RUN bun install --production

# Expose port
EXPOSE 8080

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start the server
CMD ["bun", "src/index.js"]