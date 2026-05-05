FROM node:22-alpine AS deps

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY tools/wp-import/package.json tools/wp-import/package.json

RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS runner

WORKDIR /app
RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared

RUN pnpm --filter @platforma/api prisma:generate
RUN pnpm --filter @platforma/api build

EXPOSE 3000
CMD ["pnpm", "--filter", "@platforma/api", "start"]
