# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:22-alpine AS builder

# Prisma's query engine needs OpenSSL on Alpine.
RUN apk add --no-cache openssl

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
# `npm ci` triggers postinstall -> prisma generate, which needs prisma/ present.
RUN npm ci

COPY . .
RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine AS runner

RUN apk add --no-cache openssl
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
# The generated client is produced by postinstall above, but copying it keeps
# the runtime image consistent with what was actually built and tested.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Overridden by the platform when it injects its own PORT.
ENV PORT=3000
EXPOSE 3000

# Applies pending migrations, then boots. Safe to re-run: `migrate deploy`
# is a no-op when the schema is already current.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
