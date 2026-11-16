FROM node:22-bookworm-slim AS admin-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY admin/ admin/
COPY src/admin-ui.tsx src/admin-ui.tsx
RUN npm run build:admin

FROM node:22-bookworm-slim AS node-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The official llama.cpp binary needs Ubuntu 26.04's glibc; older Node base images cannot run it.
FROM ghcr.io/ggml-org/llama.cpp:server-b12429
COPY --from=node-deps /usr/local/bin/node /usr/local/bin/node
WORKDIR /srv/lingo
COPY --from=node-deps /app/node_modules/ node_modules/
COPY package.json package-lock.json ./
COPY --chown=1000:1000 src/ src/
COPY --chown=1000:1000 bin/ bin/
COPY --from=admin-build --chown=1000:1000 /app/dist/admin/ dist/admin/
RUN mkdir -p /data /models && chown 1000:1000 /data /models
USER 1000:1000
ENTRYPOINT []
ENV HOST=0.0.0.0 PORT=8790 LINGO_DB=/data/lingo.db
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:8790/healthz").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
CMD ["node", "--import", "tsx", "src/server.ts"]
