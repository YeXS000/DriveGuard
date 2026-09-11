FROM node:22.23.2-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284 AS build

WORKDIR /workspace

COPY apps/hmi/public ./public
COPY infra/docker/hmi-server.mjs ./server.mjs

FROM node:22.23.2-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284 AS runtime

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

RUN apt-get update \
  && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY --chown=node:node --from=build /workspace/public ./public
COPY --chown=node:node --from=build /workspace/server.mjs ./server.mjs

USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
