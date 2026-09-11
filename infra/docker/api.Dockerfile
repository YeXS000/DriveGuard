FROM node:22.23.2-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284 AS dependencies

WORKDIR /workspace

# npm ci is deliberately lockfile-only. .dockerignore keeps credentials and local state out.
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services
RUN npm ci --ignore-scripts

FROM dependencies AS build

COPY infra ./infra
COPY tsconfig*.json ./
RUN npm run build \
  && npm prune --omit=dev --ignore-scripts \
  && find apps packages services -type f \( -name '*.ts' -o -name 'tsconfig.json' \) -delete \
  && find apps packages services -type d -empty -delete

FROM node:22.23.2-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284 AS runtime

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

RUN apt-get update \
  && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY --chown=node:node --from=build /workspace/node_modules ./node_modules
COPY --chown=node:node --from=build /workspace/packages ./packages
COPY --chown=node:node --from=build /workspace/dist ./dist
COPY --chown=node:node --from=build /workspace/package.json ./package.json
COPY --chown=node:node --from=build /workspace/infra/db/migrations ./infra/db/migrations

EXPOSE 3000

USER node

CMD ["node", "dist/apps/api/src/server.js"]
