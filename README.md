# 围炉夜话 Fireside

一个用于团队内部发现、认领、排期和沉淀分享议题的小型共创平台。

## 功能

- 创建议题：记录标题、简介、发起人与标签
- 认领议题：分享人接过火炬，进入准备阶段
- 议题排期：设置日期、时间、分享时长和地点
- 议题归档：沉淀核心收获与外部资料链接
- 议题广场：按状态筛选，支持全文搜索
- 数据看板：展示待认领、已排期和已归档数据

议题状态按 `等待认领 → 准备中 → 近期排期 → 往期归档` 顺序流转，后端会阻止重复认领和越级排期。

## 技术栈

- React 19 + TypeScript + Vite
- Fastify 5
- SQLite（WAL 模式）
- Node.js 22

## 本地运行

```bash
npm install
npm run build
PORT=443 HOST=0.0.0.0 npm start
```

默认数据库位于 `data/fireside.db`。可通过 `DATABASE_PATH` 指定其他位置。

开发前端时，可以分别运行：

```bash
npm run dev
npm run dev:web
```

Vite 会将 `/api` 请求代理到 `127.0.0.1:3000`，因此后端开发服务需设置 `PORT=3000`。

## 质量检查

```bash
npm run check
```

该命令依次执行 TypeScript 类型检查、API 生命周期测试和生产构建。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/topics` | 获取议题，可用 `status` 筛选 |
| `POST` | `/api/topics` | 创建议题 |
| `POST` | `/api/topics/:id/claim` | 认领议题 |
| `POST` | `/api/topics/:id/schedule` | 安排分享 |
| `POST` | `/api/topics/:id/archive` | 归档议题 |
| `GET` | `/api/stats` | 首页统计与最近排期 |

## 生产部署

仓库内提供了 systemd 服务文件：

```bash
sudo cp ops/fireside.service /etc/systemd/system/fireside.service
sudo systemctl daemon-reload
sudo systemctl enable --now fireside
```

服务监听 `0.0.0.0:443`，更新代码后运行 `npm ci && npm run build && sudo systemctl restart fireside`。当前应用直接提供 HTTP；如需标准 HTTPS，还需要在服务前配置 TLS 证书和反向代理。
