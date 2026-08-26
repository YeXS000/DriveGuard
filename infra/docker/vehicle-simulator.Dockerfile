FROM node:22.22.1-bookworm-slim AS build

WORKDIR /workspace

COPY . .

RUN npm ci --ignore-scripts \
  && npm run build

FROM node:22.22.1-bookworm-slim AS production-deps

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services

RUN npm ci --omit=dev --ignore-scripts \
  --workspace @driveguard/vehicle-simulator \
  --include-workspace-root=false

FROM node:22.22.1-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3001

WORKDIR /app

COPY --from=production-deps /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/domain ./packages/domain
COPY --from=build /workspace/packages/shared ./packages/shared
COPY --from=build /workspace/services/vehicle-simulator ./services/vehicle-simulator
COPY --from=build /workspace/services/vehicle-simulator/package.json ./package.json

EXPOSE 3001

USER node

CMD ["node", "services/vehicle-simulator/dist/server.js"]
