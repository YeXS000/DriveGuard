FROM node:22.22.1-bookworm-slim AS dependencies

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services
RUN npm ci --ignore-scripts

FROM dependencies AS build

COPY tsconfig*.json ./
RUN npm run build \
  && npm prune --omit=dev --ignore-scripts \
  && find packages services -type f \( -name '*.ts' -o -name 'tsconfig.json' \) -delete \
  && find packages services -type d -empty -delete

FROM node:22.22.1-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3001

WORKDIR /app

COPY --chown=node:node --from=build /workspace/node_modules ./node_modules
COPY --chown=node:node --from=build /workspace/packages ./packages
COPY --chown=node:node --from=build /workspace/services/vehicle-simulator ./services/vehicle-simulator

EXPOSE 3001

USER node

CMD ["node", "services/vehicle-simulator/dist/server.js"]
