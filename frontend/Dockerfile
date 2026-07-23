# syntax=docker/dockerfile:1
# --- Build stage: install ALL deps (build tools live in devDependencies) ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build

# --- Runtime: unprivileged nginx (already non-root uid 101, listens on 8080) ---
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/.next /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q --spider http://localhost:8080/healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]
