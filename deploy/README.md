# 武理小精灵部署指南

本文档说明如何把当前项目部署到云服务器。当前生产方案基于 **Docker Compose + nginx + Express + Qdrant**，文档存储使用 **SQLite**（持久化 volume）。向量检索使用 Qdrant 独立服务（dense 512d + n-gram 稀疏向量，版本固定 v1.12.5）。

---

## 架构

```text
用户浏览器
   │
   ▼
nginx:80/443
   │  SSL 终止、反向代理、静态缓存策略
   ▼
backend:3000
   │  Express API + 前端 dist 托管 + uploads 访问
   │
   ├── SQLite (/app/data/store.db)  ← 文档原文 + 元数据 + 会话
   │
   └── Qdrant:6333                  ← 512d 稠密 + n-gram 稀疏向量（混合检索）
```

相关文件：

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 多阶段构建：先构建 Vue 前端，再打包 Express 运行环境 |
| `docker-compose.yml` | CI/CD 标准部署编排：backend + qdrant + 持久化 volume（nginx 默认停用，由宿主机 nginx 服务） |
| `deploy/docker-compose.qdrant.yml` | 历史手工部署版（含 `patches/` 热补丁挂载与 `qdrant-deps` 依赖目录）。仅在需要热补丁旧镜像时使用，常规部署勿用 |
| `deploy/.env.production.example` | 生产环境变量模板 |
| `deploy/nginx.conf` | HTTPS 域名部署配置 |
| `deploy/nginx.http.conf` | 纯 HTTP / IP 测试配置 |
| `deploy/deploy.sh` | 服务器侧部署脚本 |
| `deploy/init-server.sh` | 服务器初始化辅助脚本 |
| `.github/workflows/deploy.yml` | GitHub Actions 自动部署流水线 |

---

## 前置条件

- Linux 云服务器，推荐 **2C4G** 及以上（需容纳 BGE embedding + reranker 两个本地 ONNX 模型，约 1.5G 内存峰值）。
- 已安装 Docker 和 Docker Compose V2。
- 已开放安全组端口：`22`、`80`、`443`。
- 可选：已备案域名和 SSL 证书。
- 已准备模型服务、JWT 等生产环境变量。

> 不建议把 `3000` 端口暴露到公网。当前 `docker-compose.yml` 仅绑定 `127.0.0.1:3000:3000`，由 nginx 访问后端。

---

## 快速部署

### 1. 上传代码

```bash
git clone https://github.com/L123121/Vue3_WUT_LLM.git /opt/wuli-elf
cd /opt/wuli-elf
```

如果服务器使用的是私有镜像，也可以只保留 `docker-compose.yml`、`deploy/` 和生产环境变量文件，由 CI/CD 负责推送镜像。

### 2. 配置生产环境变量

```bash
cp deploy/.env.production.example deploy/.env.production
vim deploy/.env.production
```

必须填写：

| 变量 | 说明 |
| --- | --- |
| `JWT_SECRET` | JWT 签名密钥，建议 `openssl rand -hex 32` |
| `CORS_ORIGIN` | 前端访问域名，例如 `https://your-domain.com` |

按需填写：

| 变量 | 说明 |
| --- | --- |
| `AI_BASE_URL` / `AI_MODEL` | 模型服务地址和模型名 |
| `JUDGE_API_KEY` / `JUDGE_MODEL` | LLM-as-judge 独立 Key（可选，默认同 AI_API_KEY） |
| `QDRANT_URL` | Qdrant 连接地址，默认 `http://qdrant:6333`（compose 内已注入，无需手填） |
| `EMBEDDING_CACHE_DIR` | 本地模型缓存目录，默认 `/app/.model-cache`（需挂载完整模型文件） |
| `RAG_RERANK_ENABLED` | cross-encoder 精排开关，默认 `true`；2G 内存机器可设 `false` 关闭（省约 300MB 内存与单次 ~2s 延迟，排序精度略降） |

> `deploy/.env.production` 包含敏感信息，不要提交到 Git。SQLite 无需额外配置，数据自动持久化到 `backend-data` volume。

服务启动时会自动执行 `backend/src/db/migrations/` 中的 SQLite 迁移。若迁移失败，后端不会进入正常服务状态；升级前应备份 `backend-data` volume。后台审计、Wiki 互链、上传清理和隐私留存任务写入同一 SQLite Job 表，管理员可通过 `/api/metrics/jobs` 查询失败任务并调用重试接口。

第二阶段 Compose 会同时启动 `backend`、`worker`、`redis`：API 容器只处理 HTTP/SSE，Worker 容器执行 Job 和调度清理任务。Redis 用于跨实例任务通知和短租约，SQLite 仍是 Job 的事实来源；若本地直接运行且未设置 `REDIS_URL`，系统会保持第一阶段的单机兼容模式。

附件和 Agent 工件使用私有对象存储接口。默认 `OBJECT_STORAGE_BACKEND=local`，对象保存在 `backend-data` volume 的 `objects/` 下；切换 `OBJECT_STORAGE_BACKEND=s3` 后可配置 MinIO、AWS S3 或兼容 SigV4 的对象存储。无论底层实现如何，浏览器始终通过后端的用户/会话归属校验读取对象，不能得到公开对象 URL。

第三阶段 PostgreSQL 采用并存迁移：先设置 `DATABASE_URL`，执行 `npm --prefix backend run db:postgres:migrate` 创建 schema，再执行 `npm --prefix backend run db:sqlite:import-postgres` 导入用户、会话、Job、附件元数据和反馈。核对导入结果后再将 `DATABASE_BACKEND=postgres` 灰度开启；文档与记忆等未迁移 KV 资源仍会继续使用 SQLite。

Docker Compose 默认不启动 PostgreSQL。完成数据备份与导入演练后，可使用 `docker compose --profile postgres up -d postgres backend worker` 启动可选 profile；同时在 `deploy/.env.production` 设置 `POSTGRES_PASSWORD`、`DATABASE_BACKEND=postgres` 和指向 `postgres` 服务的 `DATABASE_URL`。

### 3. 配置 nginx

#### HTTPS 域名部署

默认 `docker-compose.yml` 使用 `deploy/nginx.conf`，并把 Compose volume `ssl-certs` 挂载到 nginx 容器的 `/etc/letsencrypt`。使用 `docker compose -p wuli-elf` 时，实际 Docker volume 名称通常是 `wuli-elf_ssl-certs`。

常见方式：

```bash
# 示例：使用 certbot 申请证书，按实际域名替换 your-domain.com
# 需要先确保 80 端口未被 nginx 占用；如已启动 nginx，请先 docker compose -p wuli-elf stop nginx
docker run --rm \
  -v wuli-elf_ssl-certs:/etc/letsencrypt \
  -p 80:80 \
  certbot/certbot certonly --standalone -d your-domain.com
```

如使用阿里云免费证书，下载 nginx 版证书后也需要写入同一个 volume 中，使容器内存在：

```text
/etc/letsencrypt/live/your-domain.com/fullchain.pem
/etc/letsencrypt/live/your-domain.com/privkey.pem
```

如果更习惯使用服务器目录，也可以把 `docker-compose.yml` 中的 `ssl-certs:/etc/letsencrypt:ro` 改成类似 `./ssl:/etc/letsencrypt:ro`，然后把证书放到 `/opt/wuli-elf/ssl/live/your-domain.com/`。

#### 纯 HTTP / IP 测试

如果暂时没有域名或证书，把 `docker-compose.yml` 中 nginx 配置挂载从：

```yaml
- ./deploy/nginx.conf:/etc/nginx/conf.d/default.conf:ro
```

改为：

```yaml
- ./deploy/nginx.http.conf:/etc/nginx/conf.d/default.conf:ro
```

然后只通过 `http://服务器IP` 访问。

### 4. 启动服务

```bash
docker compose -p wuli-elf up -d --build
docker compose -p wuli-elf ps
docker compose -p wuli-elf logs -f
```

首次启动需拉取 Qdrant v1.12.5 镜像。⚠️ 版本必须固定 v1.12.5：1.13+ 镜像不认旧版 on_disk 存储格式，启动即 panic（2026-08-15 服务器事故）。
⚠️ `.model-cache` 必须包含完整的 `Xenova/bge-small-zh-v1.5`（embedding）与 `Xenova/bge-reranker-base`（rerank，含 tokenizer.json）模型文件，缺失时 embedding/rerank 会静默降级。

健康检查：

```bash
curl http://localhost:3000/api/live
curl http://localhost:3000/api/ready
curl http://localhost:3000/api/health
```

`/api/live` 只检查进程存活；`/api/ready` 检查 SQLite、Qdrant、Embedding 等核心依赖是否已就绪，Docker healthcheck 和部署脚本使用 `/api/ready`；`/api/health` 用于查看详细降级状态。

浏览器访问：

- HTTPS：`https://your-domain.com`
- HTTP 测试：`http://your-server-ip`

---

## 日常运维

### 查看状态与日志

```bash
docker compose -p wuli-elf ps
docker compose -p wuli-elf logs -f backend
docker compose -p wuli-elf logs --tail=100 nginx
docker compose -p wuli-elf logs --tail=50 qdrant
```

### 重启服务

```bash
docker compose -p wuli-elf restart
docker compose -p wuli-elf restart backend
```

### 更新部署

源码构建模式（仅用于服务器本地构建）：

```bash
git pull
docker compose -p wuli-elf up -d --build
docker image prune -f
```

镜像拉取模式：

```bash
export BACKEND_IMAGE=your-dockerhub-username/wuli-elf-backend:<commit-sha>
docker compose -p wuli-elf pull backend
docker compose -p wuli-elf up -d qdrant
docker compose -p wuli-elf up -d --no-deps backend
docker image prune -f
```

### 备份数据

推荐使用仓库自带脚本（SQLite 在线一致性备份 + 上传文件 + Qdrant 官方快照 API + 本地轮转）：

```bash
# 在 docker-compose.yml 所在目录执行
bash scripts/backup.sh

# 自定义备份目录与保留份数（默认 ./backups、每类保留 14 份）
BACKUP_DIR=/data/backups BACKUP_KEEP=30 bash scripts/backup.sh
```

定时备份（crontab -e，每天 03:30）：

```bash
30 3 * * * cd /opt/wuli-elf && BACKUP_DIR=/data/backups bash scripts/backup.sh >> /var/log/wuli-elf-backup.log 2>&1
```

> SQLite 通过 backend 镜像内的 better-sqlite3 `.backup()` 做在线备份，WAL 进行中也能拿到一致快照，无需停服；Qdrant 使用官方 snapshot API（先在远端建快照、下载、随即删除远端），不要对运行中的 qdrant-storage 卷做 tar 冷拷贝。

### 恢复数据

```bash
# 1. 恢复 SQLite（.db 文件为整库快照；.tar.gz 为冷拷贝归档）
docker compose -p wuli-elf stop backend
docker run --rm \
  -v wuli-elf_backend-data:/data \
  -v "$PWD/backups":/backup \
  alpine sh -c "cp /backup/store-YYYYMMDD-HHMMSS.db /data/store.db && rm -f /data/store.db-wal /data/store.db-shm"

# 2. 恢复 Qdrant（上传快照，priority=snapshot 表示以快照为准重建集合）
curl -X POST "http://127.0.0.1:6333/collections/wuli_elf_chunks/snapshots/upload?priority=snapshot" \
  -F "snapshot=@backups/qdrant-YYYYMMDD-HHMMSS.snapshot"

# 3. 恢复上传文件
docker run --rm \
  -v wuli-elf_uploads-data:/data \
  -v "$PWD/backups":/backup \
  alpine tar xzf /backup/uploads-YYYYMMDD-HHMMSS.tar.gz -C /data

# 4. 重启服务
docker compose -p wuli-elf up -d
```

---

## CI/CD 部署

`.github/workflows/deploy.yml` 当前流程：

1. 安装前后端依赖。
2. 执行 `npm run lint:check`。
3. 执行 `npm test`。
4. 构建并推送 Docker 镜像。
5. 通过 SSH 到 ECS 拉取镜像并重启后端。

需要配置的 GitHub Secrets：

| Secret | 说明 |
| --- | --- |
| `DOCKER_USERNAME` / `DOCKER_PASSWORD` | Docker Hub 登录信息 |
| `ECS_HOST` | ECS 公网地址 |
| `ECS_USER` | SSH 用户 |
| `ECS_SSH_KEY` | SSH 私钥 |

如果改用阿里云 ACR，请在 workflow 中启用 ACR 登录步骤并设置对应 Secret。

---

## 安全组建议

| 端口 | 用途 | 建议 |
| --- | --- | --- |
| `22` | SSH | 仅允许固定管理 IP |
| `80` | HTTP | 开放，用于访问或证书签发 |
| `443` | HTTPS | 开放，生产访问入口 |
| `3000` | Backend | 不对公网开放 |
| `6333/6334` | Qdrant REST/gRPC | 不对公网开放（仅 `127.0.0.1` 监听） |

---

## 启用 CDN 加速

CDN 可以显著降低静态资源（JS/CSS/图片）的加载延迟，适合多地域用户访问的场景。

### 推荐方案：阿里云 OSS + CDN

1. **创建 OSS Bucket**（与 ECS 同地域以降低回源费用）
2. **配置 CDN 加速**：在阿里云 CDN 控制台添加域名，源站设为 OSS Bucket 或 ECS 公网 IP
3. **设置 CNAME**：将 CDN 域名（如 `static.your-domain.com`）CNAME 到阿里云 CDN 分配的域名
4. **配置回源**：如果使用 OSS，配置 OSS 回源到 ECS（`http://your-ecs-ip/assets/*` → 读取 `dist/assets/`）

### 构建时启用 CDN

```bash
# 在构建服务器或 CI 中设置：
VITE_CDN_URL=https://static.your-domain.com npm run build
```

构建产物中所有静态资源（JS/CSS/图片/字体）的引用路径会自动加上 CDN 域名前缀，例如：
- `/assets/index-abc123.js` → `https://static.your-domain.com/assets/index-abc123.js`
- `/assets/index-xyz789.css` → `https://static.your-domain.com/assets/index-xyz789.css`

### nginx 同步配置

如果 CDN 需要回源到 ECS，确认 nginx 的 `Access-Control-Allow-Origin` 头允许 CDN 域名访问：
```nginx
location /assets {
    add_header Access-Control-Allow-Origin "https://static.your-domain.com";
    # ... 其余配置
}
```

### 缓存刷新

更新部署后，需要在 CDN 控制台刷新缓存：
```bash
# 阿里云 CLI 示例
aliyun cdn RefreshObjectCaches --ObjectPath https://static.your-domain.com/assets/ --ObjectType Directory
```

---

## 排障清单

- **后端启动失败**：检查 `AI_API_KEY`、`JWT_SECRET` 是否存在。
- **生产环境 CORS 报错**：检查 `CORS_ORIGIN` 是否包含当前访问域名。
- **nginx 证书错误**：检查证书文件路径是否与 `deploy/nginx.conf` 一致。
- **Qdrant 连接失败**：检查 `QDRANT_URL` 是否指向 `http://qdrant:6333`，及 qdrant 容器是否 Up（`docker compose -p wuli-elf ps`）；后端启动日志应出现「[QdrantStore] 已连接 collection」。
- **检索排序异常 / rerank 显示 fallback**：reranker 模型文件缺失，检查 `/app/.model-cache/Xenova/bge-reranker-base/` 是否完整（需含 tokenizer.json 与 onnx/ 目录），补齐后重启 backend。
- **容器重建后知识库/账号「清空」**：确认 backend 的 SQLite 挂载路径是 `/app/backend/data`（应用数据目录），而非 `/app/data`——挂错路径时应用会在镜像层新建空库，数据仍在 `backend-data` volume 中，改回路径重启即可恢复。
- **上传文件丢失**：确认 `uploads-data` volume 未被删除。
- **文档数据丢失**：确认 `backend-data` volume 未被删除；SQLite 数据文件位于 `/app/data/store.db`。

---

## 注意事项

1. `deploy/.env.production`、SSL 私钥不要提交到仓库。
2. 生产环境必须配置 `CORS_ORIGIN`，否则后端会拒绝启动。
3. `backend-data`、`qdrant-storage`、`uploads-data` 是关键持久化 volume，删除前务必备份。
4. nginx 日志和容器日志已配置轮转上限，但仍建议定期清理旧镜像和备份文件。
6. Qdrant 单机模式无需额外的 etcd / minio；SQLite 为单写者模型，仅适合单后端实例。
7. SQLite 是单写者模型，仅适合单后端实例部署。如需水平扩展，需改用 PostgreSQL / Redis 等网络数据库。
