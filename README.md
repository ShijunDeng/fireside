# 围炉夜话 Fireside

一个用于团队内部发现、认领、排期和沉淀分享议题的小型共创平台。

## 功能

- 创建议题：记录标题、简介、发起人与标签
- 认领议题：分享人接过火炬，进入准备阶段
- 议题排期：设置日期、时间、分享时长和地点
- 议题归档：沉淀核心收获与外部资料链接
- 围炉报名：排期后报名、查看或取消参与，结束后保留只读名单
- 线上会议：公开页面隐藏真实入口，协作会话解锁后才能加入
- 宣讲海报：未来排期一键生成脱敏的 1080×1440 PNG，可下载或系统分享
- 完整管理：编辑各状态允许的字段，二次确认后删除议题
- 流程纠错：支持退出认领、取消排期、未举行后重新排期和撤销归档
- 灵活排序：手动拖拽、上移/下移，以及按创建、排期和状态排序
- 日历规划：列表、月历和周历三种视图，点击事件直接编辑
- 议题广场：按状态筛选，支持全文搜索
- 数据看板：展示待认领、已排期和已归档数据
- 协作保护：共享口令只用于换取 8 小时当前标签页会话，验证带来源/全局限流

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
PORT=80 HOST=0.0.0.0 npm start
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

浏览器端到端验收：

```bash
npx playwright install chromium
npm run test:e2e
```

需求、验收标准和迭代证据统一维护在 [`specs/`](./specs/README.md)。所有新功能和 BUG 修复遵循先更新规格、再开发验证的流程。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/access` | 查询是否启用协作保护 |
| `POST` | `/api/access/verify` | 验证共享口令并签发短期会话 |
| `GET` | `/api/access/session` | 校验当前短期会话 |
| `GET` | `/api/topics` | 获取议题，可用 `status` 筛选 |
| `GET` | `/api/topics/:id` | 获取单个公开脱敏议题 |
| `POST` | `/api/topics` | 创建议题 |
| `PATCH` | `/api/topics/:id` | 编辑议题 |
| `DELETE` | `/api/topics/:id` | 删除议题 |
| `POST` | `/api/topics/reorder` | 保存全局手动顺序 |
| `POST` | `/api/topics/:id/claim` | 认领议题 |
| `POST` | `/api/topics/:id/release` | 退出认领并重新开放 |
| `POST` | `/api/topics/:id/schedule` | 安排分享 |
| `POST` | `/api/topics/:id/unschedule` | 取消排期或标记未举行 |
| `POST` | `/api/topics/:id/archive` | 归档议题 |
| `POST` | `/api/topics/:id/unarchive` | 撤销归档 |
| `GET/POST` | `/api/topics/:id/participants` | 查看名单或报名 |
| `DELETE` | `/api/topics/:id/participants/:participantId` | 取消报名 |
| `GET` | `/api/topics/:id/meeting-access` | 获取受保护的真实会议入口 |
| `GET` | `/api/stats` | 首页统计与最近排期 |

## 生产部署

仓库内提供了 systemd 服务文件：

```bash
sudo cp ops/fireside.service /etc/systemd/system/fireside.service
sudo systemctl daemon-reload
sudo systemctl enable --now fireside
```

服务监听 `0.0.0.0:80`，更新代码后运行 `npm ci && npm run build && sudo systemctl restart fireside`。
