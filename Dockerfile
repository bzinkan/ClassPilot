# Multi-stage build for optimized production image
# Stage 1: Build
FROM node:24-alpine AS builder

WORKDIR /app

# Install build dependencies for canvas
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    pixman-dev

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Stage 2: Production
FROM node:24-alpine

# Install runtime and build dependencies for canvas and dumb-init
RUN apk add --no-cache \
    dumb-init \
    cairo \
    jpeg \
    pango \
    giflib \
    pixman \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    pixman-dev

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy package files and vendor directory
COPY --chown=nodejs:nodejs package.json package-lock.json ./
COPY --chown=nodejs:nodejs vendor ./vendor
COPY --chown=nodejs:nodejs drizzle.config.ts ./

# Copy built files from builder
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/migrations ./migrations

# Copy shared folder directly (needed for drizzle-kit to read schema)
COPY --chown=nodejs:nodejs shared ./shared

# Note: We don't copy server/ because it's already bundled into dist/, but we need shared/ for drizzle-kit

# Install ALL dependencies (including devDependencies because they're marked as external in the build)
# IMPORTANT: Don't set NODE_ENV=production yet, it would cause npm ci to skip devDependencies
RUN npm ci && \
    npm cache clean --force && \
    apk del python3 make g++ cairo-dev jpeg-dev pango-dev giflib-dev pixman-dev && \
    chown -R nodejs:nodejs /app/node_modules

# Set environment AFTER installing dependencies
ENV NODE_ENV=production
ENV PORT=5000

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Use dumb-init to handle signals properly (for graceful shutdown)
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["npm", "start"]
