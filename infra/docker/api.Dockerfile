FROM node:22.22.1-bookworm-slim AS build

WORKDIR /workspace

COPY . .

RUN npm ci --ignore-scripts \
  && npm run build \
  && npm prune --omit=dev --ignore-scripts

FROM node:22.22.1-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/dist ./dist
COPY --from=build /workspace/package.json ./package.json
COPY --from=build /workspace/infra/db/migrations ./infra/db/migrations

EXPOSE 3000

USER node

CMD ["node", "dist/apps/api/src/server.js"]
