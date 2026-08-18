# syntax=docker/dockerfile:1
# --- Build stage: all deps so the build (if any) can run ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
# Prisma: generate client BEFORE build so TS type checks see the enums.
# Skipped when the app doesn't use Prisma.
RUN if [ -f prisma/schema.prisma ] || [ -f schema.prisma ]; then \
      npx --yes prisma generate; \
    fi
# Auto-build when the app defines a build script (Next.js needs it).
# Fails the image build if the script exists and errors — surfaces bugs early.
RUN if node -e "process.exit(require('./package.json').scripts?.build ? 0 : 1)"; then \
      npm run build; \
    else \
      echo "no build script — skipping"; \
    fi

# --- Runtime: non-root built-in `node` user ---
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
# Copy the built app WITH its node_modules from the builder (avoids a second
# install and guarantees framework binaries + build output are present).
# Fix output copy to copy the 'build' folder (Create React App) instead of '.next'
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
USER node
EXPOSE 3000
CMD ["sh", "-c", "export PATH=/app/node_modules/.bin:$PATH; exec npm start"]
