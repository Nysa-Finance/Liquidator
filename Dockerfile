# Build stage: full dependencies, compile.
FROM node:24-slim AS build
WORKDIR /app
# the lockfile is written by npm 12; older npm rejects it in `npm ci`
RUN npm install -g --silent npm@12
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
RUN npm run build && npm prune --omit=dev

# Runtime stage: compiled output and production dependencies only.
# No .env and no key in here: both come in at run time (docker-compose.yml).
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/src/index.js"]
