FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir /data && chown node:node /data
COPY --chown=node:node src/ src/
COPY --chown=node:node bin/ bin/

USER node
ENV HOST=0.0.0.0 PORT=8790 LINGO_DB=/data/lingo.db
EXPOSE 8790 8791
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:8790/healthz").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'
CMD ["node", "--import", "tsx", "src/server.ts"]
