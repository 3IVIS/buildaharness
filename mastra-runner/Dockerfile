# itsharness — Mastra execution runner
#
# Multi-stage build: compile TypeScript in a builder image, then copy
# only the compiled dist/ into a lean runtime image.
#
# Usage (via docker compose):
#   docker compose up --build mastra-runner
#
# Usage (standalone):
#   docker build -f mastra-runner/Dockerfile -t itsharness-mastra-runner ./mastra-runner
#   docker run -p 8001:8001 -e OPENAI_API_KEY=sk-... itsharness-mastra-runner

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /build

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app

# Copy compiled output and production deps.
COPY --from=builder /build/dist        ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY package.json ./

EXPOSE 8001

# Run as non-root.
RUN useradd -m runner
USER runner

HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=15s \
  CMD node -e "fetch('http://localhost:8001/health').then(r=>r.ok||process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "--experimental-vm-modules", "dist/server.js"]
