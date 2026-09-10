FROM node:22.22.1-bookworm-slim AS build

WORKDIR /workspace

COPY apps/hmi/public ./public
COPY infra/docker/hmi-server.mjs ./server.mjs

FROM node:22.22.1-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app
COPY --chown=node:node --from=build /workspace/public ./public
COPY --chown=node:node --from=build /workspace/server.mjs ./server.mjs

USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
