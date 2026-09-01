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

生产环境不从 Git 工作树运行，也不使用 npm、tsx 或 esbuild 启动服务。构建产物安装到版本化的只读 release，Node 由固定的 `fireside` 系统账户直接运行；`fireside.socket` 由 systemd 持有公网 80 端口并把名为 `fireside` 的 fd 3 交给应用。

### 首次准备

创建无登录权限的固定账户和四个相互隔离的目录：

```bash
sudo groupadd --system fireside
sudo useradd --system --gid fireside --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin fireside
sudo install -d -o root -g root -m 0755 /opt/fireside/releases
sudo install -d -o fireside -g fireside -m 0700 /var/lib/fireside
sudo install -d -o root -g root -m 0700 /var/backups/fireside
```

如果账户或目录已存在，应先核对而不是删除重建。生产共享口令只写入 `/etc/fireside.env`：

```dotenv
FIRESIDE_WRITE_KEY=<由安全随机源生成的 32 至 256 字符值>
```

使用 `sudoedit /etc/fireside.env` 编辑，并确认：

```bash
sudo chown root:root /etc/fireside.env
sudo chmod 0600 /etc/fireside.env
```

不要把真实口令放入仓库、命令参数、URL、聊天记录或 systemd unit。systemd manager 会在降权前读取环境文件；`fireside` 服务账户不需要、也不应能直接打开它。

### 构建并安装版本化 release

在普通构建目录完成依赖安装和质量检查；`npm run build` 会生成前端及预编译服务端到 `server-build/`。提交并推送自测成功的代码后，由安装脚本在临时目录安装生产依赖、固化 root-only release，并原子切换 `current`。不要在 `/opt/fireside/current` 中执行安装或构建。

```bash
npm ci
npm run check
git commit
git push
sudo ops/install-release.sh "$(git rev-parse HEAD)"
```

安装后的结构必须类似：

```text
/opt/fireside/releases/<commit>/
├── server-build/
│   ├── dist/
│   └── server/
│       ├── index.js
│       └── backup-cli.js
├── node_modules/
├── package.json
└── package-lock.json
```

安装脚本拒绝脏工作树、commit 不匹配、缺少构建产物和覆盖已有 release；release 及其中所有文件归 `root:root` 所有，服务账户不可写。脚本只在新目录准备完成后原子更新 `/opt/fireside/current`；运维人员至少保留当前和上一个健康 release。

### 安装 systemd 单元

```bash
sudo install -o root -g root -m 0644 ops/fireside.service /etc/systemd/system/fireside.service
sudo install -o root -g root -m 0644 ops/fireside.socket /etc/systemd/system/fireside.socket
sudo install -o root -g root -m 0644 ops/fireside-backup.service /etc/systemd/system/fireside-backup.service
sudo install -o root -g root -m 0644 ops/fireside-backup.timer /etc/systemd/system/fireside-backup.timer
sudo systemctl daemon-reload
sudo systemctl disable fireside.service
sudo systemctl enable fireside.socket fireside-backup.timer
sudo systemctl start fireside.socket fireside.service fireside-backup.timer
```

只启用 socket 和 timer；服务由 socket 激活，也可以在发布完成后显式启动。应用没有 `CAP_NET_BIND_SERVICE` 或其他 capability。后续重启时 socket 继续监听 80，连接可以短暂排队。首次从旧 Node 进程直接占用 80 切换到 socket activation 时，单机仍有一次不可完全消除的短切换窗口；要求绝对零丢包时必须先提供外部负载均衡或第二实例。

### 从旧工作树迁移生产数据库

首次迁移必须在受控窗口完成，且目标 `/var/lib/fireside/fireside.db` 不存在时才允许执行：

1. 安装并验证新 release，但暂不启动新服务。
2. 停止旧服务，阻止新的业务写入。
3. 使用新 release 的 `backup-cli.js` 和 `better-sqlite3` 在线 backup API，从旧数据库生成 root-only 的一致单文件备份；禁止把 `cp fireside.db` 当作备份，因为 WAL 可能包含尚未 checkpoint 的数据。
4. 对备份执行 `integrity_check` 并核对非敏感业务指纹后，把该备份安装为 `/var/lib/fireside/fireside.db`，所有者为 `fireside:fireside`、模式为 `0600`。
5. 把旧路径的数据库、WAL 和 SHM 改为 `root:root 0600`，旧数据目录改为 `0700` 并保留为回滚证据，不删除或覆盖。
6. 启动 socket 和新服务，核对健康页、公开数据指纹、全部 revision、order version 与参与人数。

迁移失败时不得用空库覆盖目标，不得删除旧数据库或最近备份。

### 日常发布与回滚

发布前先手动生成一次一致备份，并在隔离副本上运行新 release 的启动迁移与完整性检查。不可逆 schema 变化必须采用 expand / migrate / contract 分阶段方式，保证当前与上一个 release 在回滚期都能读取数据库。

确认后原子切换 `current` 链接并重启服务：

```bash
sudo systemctl start fireside-backup.service
sudo systemctl restart fireside.service
```

socket 在服务优雅停止和新进程启动期间保持 80 监听。健康检查失败时，把 `current` 链接切回上一 release 并再次重启；不要覆盖状态目录。只有完成兼容迁移且确需恢复数据时，才在服务停止后从已校验备份恢复。

### 一致备份与恢复演练

`fireside-backup.timer` 每天 03:15 进入计划，并加入最多 15 分钟随机延迟分散系统负载；`Persistent=true` 会在主机错过计划后补跑。备份 CLI 从以下环境读取配置：

```text
DATABASE_PATH=/var/lib/fireside/fireside.db
BACKUP_DIRECTORY=/var/backups/fireside
BACKUP_RETENTION=14
```

备份服务以 root 启动，但 capability 边界只保留读取私有生产库所需的 `CAP_DAC_READ_SEARCH`；挂载沙箱把生产状态设为只读，唯一持久可写路径是 `/var/backups/fireside`，并禁止网络及访问 `/etc/fireside.env`。应用服务不能读取、修改或删除备份。手动验收：

```bash
sudo systemctl start fireside-backup.service
sudo systemctl status fireside-backup.service --no-pager
sudo journalctl -u fireside-backup.service -n 20 --no-pager
sudo systemctl list-timers fireside-backup.timer --no-pager
```

成功日志只包含时间、备份文件名、字节数、SHA-256、Topic 数、参与人数和 order version，不得包含标题、姓名、会议链接、口令或 token。只有新备份成功并通过完整性检查后，CLI 才会删除严格匹配命名规则的超额旧备份，默认保留 14 份。

恢复演练在 root-only 临时目录中复制最新备份，以只读方式执行 `integrity_check`，并比较 Topic 数、全部 revision、order version、参与人数和敏感字段存在性摘要。演练不得监听生产端口、修改生产库或改变 `current`；完成后只删除本次明确创建的临时目录。本机备份不等于主机级灾难恢复，仍需另行提供加密异地备份。

### 发布后权限与连续性检查

```bash
systemctl is-active fireside.socket fireside.service fireside-backup.timer
systemctl show fireside.service -p User -p Group -p MainPID -p NoNewPrivileges -p CapabilityBoundingSet -p AmbientCapabilities
stat -c '%A %a %U:%G %n' /var/lib/fireside /var/lib/fireside/fireside.db /var/lib/fireside/fireside.db-wal /var/lib/fireside/fireside.db-shm /etc/fireside.env /var/backups/fireside
ss -ltnp '( sport = :80 )'
systemd-analyze security fireside.service
```

MainPID 必须是 UID/GID `fireside` 的直接 Node 进程，不能出现 npm、shell、tsx 或 esbuild 子进程；`CapInh/CapPrm/CapEff/CapAmb/CapBnd` 全为零且 `NoNewPrivs=1`。`/var/lib/fireside` 必须是 `0700`，DB/WAL/SHM 必须是 `0600`，普通用户不可读；服务账户只能写状态目录，不能写 release、unit、环境文件或备份目录。
