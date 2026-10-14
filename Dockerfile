# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_store_dir=/pnpm/store \
    CI=true
WORKDIR /repo
COPY package.json ./
RUN corepack enable && corepack install

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

FROM deps AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm build && pnpm --filter @ma/worker build
RUN pnpm --config.inject-workspace-packages=true --filter @ma/worker deploy --prod --offline /out \
 && rm -rf /out/src /out/tsconfig*.json \
      /out/node_modules/.pnpm/@ma+*/node_modules/@ma/*/src \
      /out/node_modules/.pnpm/@ma+*/node_modules/@ma/*/tsconfig*.json

FROM ${NODE_IMAGE} AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && groupadd --system --gid 10001 worker \
 && useradd --system --uid 10001 --gid worker --no-create-home --shell /usr/sbin/nologin worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER 10001:10001
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
