# --- deps: install all deps (incl. dev) for build ---
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# --- build: compile TypeScript ---
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- migrate: ensure DB + drizzle migrations (no app compile) ---
FROM node:20-alpine AS migrate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json drizzle.config.ts ./
COPY scripts ./scripts
COPY src/db ./src/db

# --- prod-deps: prune to production deps only ---
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# --- runner: slim runtime image, non-root ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# drizzle config + schema are handy if migrations run from the image
COPY drizzle.config.ts ./
COPY src/db ./src/db

USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
