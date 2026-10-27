FROM node:25-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:25-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
# /telegram/health answers 503 when the bot cannot get updates or the store is down
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/telegram/health" || exit 1
# Secrets (BOT_TOKEN, MONGO_URI) come from the environment at runtime
CMD ["node", "dist/index.js"]
