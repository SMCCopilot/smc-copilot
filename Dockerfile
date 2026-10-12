# syntax=docker/dockerfile:1
# The API (and, with INGEST_ENABLED=true, the market-data and engine workers in the same process).
# Built from the repository root: `docker build -t smc-api .`  Railway builds this file automatically.

FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
# No git in the image: do not try to install the commit hooks.
ENV LEFTHOOK=0 CI=true
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 # A standalone copy of the API with only production dependencies and the workspace packages it uses.
 && pnpm --filter @smc/api deploy --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
USER node
EXPOSE 3000
# /healthz answers without a database; /readyz checks the database and the feeds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
