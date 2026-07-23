# syntax=docker/dockerfile:1
# --- Build stage: all deps so the build (if any) can run ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .

# --- Runtime: prod-only deps, non-root built-in `node` user ---
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi && npm cache clean --force
COPY --from=builder /app ./
USER node
EXPOSE 3000
CMD ["node","server.js"]
