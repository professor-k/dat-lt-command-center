# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY . .
RUN npm run build -w web \
 && npm run build -w server

# Strip dev dependencies from the runtime image.
RUN npm prune --omit=dev

# ---- runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/prisma ./server/prisma
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh && chown -R app:app /app
USER app

EXPOSE 8080
ENTRYPOINT ["./docker-entrypoint.sh"]
