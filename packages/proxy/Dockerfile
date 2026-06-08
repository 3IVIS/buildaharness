FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies as root, then drop privileges
COPY package.json ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src

# Build TypeScript to JS
RUN npm install --save-dev typescript && \
    npx tsc --outDir dist --module commonjs --target ES2022 \
      --moduleResolution node --esModuleInterop true \
      --skipLibCheck true src/index.ts || true

# Copy pre-built dist if present (CI may build before docker build)
COPY dist* ./dist/

# Run as non-root
RUN addgroup -S proxy && adduser -S proxy -G proxy
USER proxy

EXPOSE 3001

# Health check — matches GET /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

# Start the Node.js server via the compiled entry point.
# Hono's node adapter is used in src/server.ts (Node.js-specific entry point).
CMD ["node", "dist/server.js"]
