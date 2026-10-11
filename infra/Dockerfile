# One image for the API (APP_ROLE=all runs the worker modules too). Multi-arch: the Oracle free VM is arm64.
# Build from the repository root:  docker build -f infra/Dockerfile -t smc-copilot-api .
# NOTE: written and its packaging step (`pnpm deploy`) proven locally, but the image itself is UNVERIFIED until
# it is built on a machine with a running Docker daemon.

FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @smc/api... build
# --legacy: pnpm 10 only deploys without inject-workspace-packages when asked to use the legacy algorithm.
RUN pnpm --filter @smc/api deploy --prod --legacy /out

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/package.json ./package.json
# Never run as root; no shell tooling beyond what the base image has; nothing is written to disk by the app.
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
