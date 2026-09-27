FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile --filter @ma/server... \
 && pnpm -r --filter @ma/server... build \
 && pnpm --filter @ma/server deploy --legacy --prod /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /app/packages/db/drizzle ./node_modules/@ma/db/drizzle
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
