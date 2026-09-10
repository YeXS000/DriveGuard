FROM node:22.22.1-bookworm-slim AS dependencies

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

FROM node:22.22.1-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY --chown=node:node --from=build /workspace/node_modules ./node_modules
COPY --chown=node:node --from=build /workspace/packages ./packages
COPY --chown=node:node --from=build /workspace/dist ./dist
COPY --chown=node:node --from=build /workspace/package.json ./package.json
COPY --chown=node:node --from=build /workspace/infra/db/migrations ./infra/db/migrations

EXPOSE 3000

USER node

CMD ["node", "dist/apps/api/src/server.js"]
