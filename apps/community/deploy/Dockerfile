FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm run build -w @open-grokbot/runner -w @open-grokbot/community \
    && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ARG RELEASE=development
ENV COMMUNITY_RELEASE=$RELEASE
LABEL org.opencontainers.image.revision=$RELEASE
ENV NODE_ENV=production COMMUNITY_HOST=0.0.0.0 COMMUNITY_PORT=8787 COMMUNITY_DATA_DIR=/data
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","apps/community/server.mjs"]
