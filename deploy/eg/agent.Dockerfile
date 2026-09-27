# eg-agent 镜像（含本地管理页）。构建上下文由 scripts/pack-eg.mjs 拼好（dist/.stage-agent）：
#   apps/agent  packages/config  packages/lsa-model  packages/lsa-points（后端库的两个包，vendored）  web/（管理页构建产物）
# 开发时这两个后端包经 link: 引用；这里改成工作区内的包（pack-eg 改写 apps/agent/package.json）。
# 运行时仍用 swc 即时编译 TS（NestJS 装饰器要转换，Node 自带的去类型不够）。

FROM node:22-bookworm-slim AS build
# better-sqlite3 优先下载预编译件，下不到就现编
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY . .
RUN pnpm install --no-frozen-lockfile

FROM node:22-bookworm-slim
ENV NODE_ENV=production TZ=Asia/Shanghai EG_CONFIG_DIR=/config EG_WEB_DIR=/app/web
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/apps/agent
EXPOSE 80
CMD ["node", "--import", "@swc-node/register/esm-register", "src/main.ts"]
