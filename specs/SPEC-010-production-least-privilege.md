# SPEC-010：生产最小权限、私有状态与可恢复发布

- 状态：`Ready`
- 创建：2026-09-02
- 优先级：P1
- 关联：SPEC-001 部署、SPEC-003 第 14 轮、SPEC-009 生产认证边界

## 1. 问题与目标

当前生产进程由 systemd 以 root 启动，npm、tsx、Node 和 esbuild 均为 UID 0，保留近完整 capability；`NoNewPrivileges`、文件系统保护、私有临时目录等均关闭，`systemd-analyze security` 暴露分为 9.6 `UNSAFE`。一旦公网 Node 进程被利用，攻击者直接得到主机 root 权限。

SQLite 主库、WAL、SHM 为 `root:root 0644`，数据目录为 0755，普通本地用户已被确定性证明可读取。主库含报名姓名和真实会议 URL；当前大部分新数据仍可能在 WAL，复制单个 `fireside.db` 既泄密又不是一致备份。系统没有 Fireside 专用备份、恢复演练或版本化回滚链路。

本规格目标：让公网应用以零 capability 的固定非 root 身份运行；由 PID 1 持有 80 端口；把只读发布、可写状态、root-only 密钥和应用不可删除的备份分离；使用 SQLite 在线 backup API 生成一致备份；发布失败可回到上一版本且不覆盖生产状态。

## 2. 运行身份与 80 端口

### FR-OPS-001 固定服务身份

- 生产使用系统账户和系统组 `fireside:fireside`；无登录 shell、无可登录 home、无额外组。
- `fireside.service` 必须显式 `User=fireside`、`Group=fireside`。MainPID 是直接执行的预编译 Node，不经过 npm、shell、tsx 或 esbuild。
- Node 的有效、许可、继承、环境和边界 capability 均为空；`NoNewPrivileges=true`。

### FR-OPS-002 systemd socket activation

- `fireside.socket` 由 systemd 监听 `0.0.0.0:80`，`Accept=no`，只向 `fireside.service` 传递一个名为 `fireside` 的监听文件描述符。
- 应用只在 `LISTEN_PID` 等于自身 PID、`LISTEN_FDS=1` 且描述符名正确时接受 fd 3；伪造、数量异常或 PID 不匹配时忽略继承变量并按显式 HOST/PORT 启动。
- socket 模式不得为应用授予 `CAP_NET_BIND_SERVICE`；直接开发/测试启动仍支持 HOST/PORT。
- 首次从旧进程直接占用 80 切换到 socket activation 允许一次受控的短监听窗口；完成切换后，服务重启期间 socket 必须持续监听，连接可短暂排队但不得出现 connection refused。

### FR-OPS-003 优雅停止

- SIGTERM/SIGINT 只触发一次关闭流程：停止接受新连接、等待 Fastify 在途请求、执行 `app.close()` 和数据库 close hook，再以成功状态退出。
- 重复信号不重复关闭或制造未处理 Promise；systemd 正常停止不得依赖 SIGKILL。

## 3. 路径、所有权与沙箱

### FR-OPS-004 代码/状态/密钥/备份四分离

| 类型 | 路径 | 所有权与权限 | 应用权限 |
| --- | --- | --- | --- |
| 版本发布 | `/opt/fireside/releases/<commit>` | `root:root`，目录 0755，文件不可由服务用户修改 | 只读/执行 |
| 当前版本 | `/opt/fireside/current` | root 原子维护的符号链接 | 只读/执行 |
| 生产状态 | `/var/lib/fireside` | `fireside:fireside 0700` | 唯一持久可写路径 |
| SQLite 文件 | `/var/lib/fireside/fireside.db*` | `fireside:fireside 0600` | 读写 |
| 密钥环境 | `/etc/fireside.env` | `root:root 0600` | systemd manager 可读，服务身份不可直接打开 |
| 一致备份 | `/var/backups/fireside` | `root:root 0700`，备份 0600 | 应用不可读写/删除 |

- 不从活工作树运行生产，不在仓库内继续写生产数据库。
- `UMask=0077` 保证新 DB/WAL/SHM 与临时状态不向组或其他用户开放。
- 首次迁移在旧服务优雅停止后进行，必须保留 root-only 的原数据库作为回滚副本，不删除或覆盖；目标库存在时不得再从旧路径覆盖。

### FR-OPS-005 systemd 沙箱

生产 service 至少启用并真实启动验证：

- `ProtectSystem=strict`、`ProtectHome=true`、`PrivateTmp=true`、`PrivateDevices=true`；
- `ProtectKernelTunables=true`、`ProtectKernelModules=true`、`ProtectControlGroups=true`、`ProtectClock=true`、`ProtectHostname=true`；
- `RestrictSUIDSGID=true`、`LockPersonality=true`、`RestrictRealtime=true`、`RestrictNamespaces=true`；
- `ProtectProc=invisible`、`ProcSubset=pid`、`SystemCallArchitectures=native`；
- `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`；其中 `AF_NETLINK` 仅用于 Fastify 启动日志调用 Node `os.networkInterfaces()` 读取接口地址，应用仍无任何网络管理 capability；
- 空 `CapabilityBoundingSet` 与 `AmbientCapabilities`。

若某项与 Node/Fastify/SQLite 的实际运行冲突，只能在记录确定性失败证据后做最小放宽，并回写本规格；不得为追求评分加入未经运行验证的指令。

首次真实 systemd 启动已确定性证明：只允许 UNIX/IPv4/IPv6 时，Fastify 的监听日志在 `uv_interface_addresses` 以 errno 97 失败并使进程退出；加入 `AF_NETLINK` 是维持现有启动日志所需的最小放宽，不恢复 root、capability、写系统目录或其他地址族。

## 4. 构建与版本化发布

### FR-OPS-006 预编译服务端

- `npm run build` 同时生成 Vite 客户端和 TypeScript 服务端 JavaScript；生产入口为编译后的 `server/index.js`。
- 生产依赖安装在 release 内；release 建成、依赖安装和最小自检成功后才允许原子切换 `current`。
- 每个 release 以 Git commit 标识且不可就地修改；至少保留当前与上一健康 release。回滚只切换链接并重启 service，不触碰状态目录。

### FR-OPS-007 数据库迁移兼容

- 发布前先对一致备份副本运行新版本启动/迁移和完整性检查。
- 不可逆 schema 变化必须使用 expand/migrate/contract 分阶段策略，保证当前和上一 release 都能读取回滚期数据库。
- 健康检查失败不得删除上一 release、旧数据库副本或最新备份。

## 5. 一致备份与恢复

### FR-OPS-008 在线一致备份

- 使用 `better-sqlite3` backup API 从活动 WAL 数据库生成单文件一致备份，禁止 `cp fireside.db` 作为备份实现。
- 写入同目录 root-only 临时文件，`integrity_check=ok` 后原子改名；失败清理本次明确命名的临时文件，不影响既有备份。
- 成功记录时间、文件名、字节数、SHA-256、Topic 数、参与人数与 order version；不得记录标题、姓名、会议链接、口令或 token。
- systemd timer 每日运行并支持错过后补跑；默认保留最近 14 份。只有新备份成功且校验通过后，才删除严格匹配命名规则的超额旧备份。
- 备份服务可为读取 0600 源库拥有唯一必要的只读 DAC 能力，但不得拥有写生产状态、网络或其他 capability；应用服务自身永远不能访问备份目录。

### FR-OPS-009 恢复演练

- 从最新备份复制到 root-only 临时目录，以只读方式执行 `integrity_check`，比较 Topic 数、全部 revision、order version、参与人数和敏感字段存在性摘要；不得输出原始敏感字段。
- 恢复演练不得连接生产端口、修改生产库或改变当前 release；临时恢复目标完成后可明确删除。

## 6. 非目标与边界

- 本轮不引入容器、反向代理、多实例、外部负载均衡、远端对象存储或自动数据库故障切换。
- 本机备份不能替代加密异地备份；异地凭证和存储尚未提供，保留为部署边界，不能宣称主机级灾难恢复完成。
- 首次 socket 切换无法在单实例同端口上数学保证零 SYN 丢失；后续重启必须由 socket 保持监听。
- 公网 IP 入站超时和 HTTP 明文传输仍属于云网络/域名证书边界，不因本轮最小权限完成而关闭。

## 7. 验收矩阵

### 7.1 自动化

1. systemd fd 环境覆盖正确、PID 不匹配、0/2 个 fd、名称不匹配与普通 HOST/PORT 回退。
2. SIGTERM/SIGINT 幂等关闭；服务器关闭后 DB 可再次独占打开，无强杀或未处理 rejection。
3. 在线 backup 覆盖 WAL 中未 checkpoint 数据；备份 `integrity_check=ok`，Topic/revision/order/参与人数一致。
4. 备份失败不留下最终文件；保留策略不删除非匹配文件，且仅在成功后保留最新 14 份。
5. TypeScript、全部单元/API、生产构建、依赖审计和桌面/Pixel 7 E2E 回归。

### 7.2 生产

1. 迁移前后公开 Topic/统计摘要、全部 revision、order version 和参与人数指纹一致；旧 DB 留存且改为 root-only。
2. socket 与 service 均 active，`0.0.0.0:80` 由 systemd PID 1 持有；MainPID 为 UID/GID `fireside` 的直接 Node，子进程不含 npm/tsx/esbuild。
3. `/proc/<pid>/status` 的 CapInh/Prm/Eff/Amb/Bnd 全零，NoNewPrivs=1；服务用户不能写 release/unit/env/backup，也不能直接读 env/backup。
4. `/var/lib/fireside` 为 0700，DB/WAL/SHM 为 0600；`nobody` 不能读取任何状态或备份文件。
5. 连续重启期间从本机并发探测 80：socket 始终 LISTEN，无 connection refused；重启后健康页、首页、公开 API、有效协作会话与业务数据正常。
6. 手动触发一次在线备份并完成隔离恢复演练；生产业务指纹不变，备份日志无敏感字段。
7. `systemd-analyze security` 不再报告 root、完整 capability、开放 home、共享 tmp 或可写系统目录；记录最终 exposure 分数但以真实功能/权限验证为准。

## 8. 完成条件

- 应用以非 root、零 capability、预编译 Node 在 socket activation 下提供 80 服务。
- 生产状态私有且只有应用可写，密钥和备份对应用不可读写，普通用户不能读取任何数据库工件。
- 一致备份、完整性检查、保留和隔离恢复演练成立；版本化 release 可回到上一版本且不覆盖数据。
- 全量自动化、生产迁移、重启连续性、权限矩阵、日志脱敏与独立发布审计通过后，状态方可改为 `Accepted`。
