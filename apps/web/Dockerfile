FROM node:22-alpine AS deps

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY tools/wp-import/package.json tools/wp-import/package.json

RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS builder

WORKDIR /app
RUN corepack enable

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY _Fluffy_White_1-02.svg ./_Fluffy_White_1-02.svg
COPY floor-plan.svg ./floor-plan.svg
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared

ARG VITE_API_URL=http://localhost:3000
ARG VITE_YANDEX_MAPS_API_KEY=

RUN VITE_API_URL="$VITE_API_URL" VITE_YANDEX_MAPS_API_KEY="$VITE_YANDEX_MAPS_API_KEY" pnpm --filter @platforma/web build

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5173

COPY apps/web/server.mjs ./apps/web/server.mjs
COPY --from=builder /app/apps/web/dist ./apps/web/dist

EXPOSE 5173
CMD ["node", "apps/web/server.mjs"]
