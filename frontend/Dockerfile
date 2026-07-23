# syntax=docker/dockerfile:1
# --- Build stage: all deps so the build (if any) can run ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
# Auto-build when the app defines a build script (Next.js, TS, etc.).
RUN node -e "process.exit(require('./package.json').scripts && require('./package.json').scripts.build ? 0 : 1)" \
    && npm run build || echo "no build script — skipping"

# --- Runtime: non-root built-in `node` user ---
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
# Copy the built app WITH its node_modules from the builder (avoids a second
# install and guarantees framework binaries + build output are present).
COPY --from=builder /app ./
USER node
EXPOSE 3000
CMD ["sh", "-c", "export PATH=/app/node_modules/.bin:$PATH; exec next start"]
