# ======================================================================
# Dockerfile — 武理小精灵 (WUT RAG Copilot)
# 多阶段构建：前端(Vite) + 后端(Express + SQLite/Qdrant)
# ======================================================================

# ---- Stage 1: 构建前端 SPA ----
FROM node:26-slim AS frontend-builder

WORKDIR /app

# 安装前端依赖（显式包含 devDependencies，Vite 构建依赖不能被生产环境配置省略）
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --include=dev

# 拷贝前端源码
COPY vite.config.js vite-plugin-perf.js index.html ./
COPY src/ src/
COPY public/ public/
COPY scripts/ scripts/

# 构建前端
RUN npm run build

# ---- Stage 2: 构建后端生产依赖 ----
FROM node:26-slim AS backend-deps

WORKDIR /app

# sharp（@huggingface/transformers 传递依赖）与 better-sqlite3 的预编译二进制
# 默认从 GitHub Releases 下载，服务器网络受限会失败；指向 npmmirror 镜像加速。
ENV npm_config_sharp_binary_host=https://registry.npmmirror.com/-/binary/sharp
ENV npm_config_sharp_libvips_binary_host=https://registry.npmmirror.com/-/binary/sharp-libvips
ENV npm_config_better_sqlite3_binary_host=https://registry.npmmirror.com/-/binary/better-sqlite3

# 预编译包不可用时，better-sqlite3 会回退到 node-gyp 源码编译。
RUN sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/package-lock.json* ./backend/
RUN cd backend && npm ci --omit=dev --ignore-scripts
# better-sqlite3 是运行期硬依赖（auth.service / memory-store 直接 require），
# 编译或下载失败必须报错中止，不能静默跳过，否则容器启动即崩。
RUN cd backend && npm_config_build_from_source=true npm rebuild better-sqlite3 --omit=dev || (echo "[Docker] better-sqlite3 编译失败，构建中止" >&2 && exit 1)

# ---- Stage 3: 后端运行环境 ----
FROM node:26-slim

LABEL maintainer="武理小精灵团队"
LABEL description="武理小精灵 - 武理校园 AI 助手 / WUT Campus AI Assistant"

WORKDIR /app

# ---- 拷贝前端构建产物 ----
COPY --from=frontend-builder /app/dist ./dist

# ---- 拷贝后端源码 ----
COPY backend/ ./backend/
COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules

# ---- 运行时目录 ----
RUN mkdir -p /app/data /app/backend/uploads /app/.model-cache

# ---- 环境变量默认值 ----
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# 持久化数据目录
VOLUME ["/app/backend/data", "/app/backend/uploads", "/app/.model-cache"]

CMD ["node", "backend/src/app.js"]
