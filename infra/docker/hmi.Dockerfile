FROM node:22.22.1-bookworm-slim

WORKDIR /app

COPY apps/hmi/public ./public
COPY infra/docker/hmi-server.mjs ./server.mjs

USER node

EXPOSE 8080

CMD ["node", "server.mjs"]

EXPOSE 8080
