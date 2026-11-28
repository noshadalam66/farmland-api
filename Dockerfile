# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci && npm run build && npm prune --omit=dev && npm cache clean --force \
    && mkdir -p /release/workers/terrain \
    && mv package.json dist node_modules /release/ \
    && mv workers/terrain/export.py /release/workers/terrain/

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-gdal python3-numpy \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node --chmod=u=rwX,go=rX /release/ ./
ENV TERRAIN_PYTHON=/usr/bin/python3
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
