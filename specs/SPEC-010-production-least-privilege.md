# SPEC-010：生产最小权限、私有状态与可恢复发布

- 状态：`Implementing`
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
- 发布工具必须从请求的完整 40 位 Git commit 导出干净源码后重新安装依赖、测试和构建，不能复制被 `.gitignore` 隐藏的工作树 `server-build/`；commit、源码树和实际产物必须由 root 生成的 SHA-256 manifest 绑定。
- npm lifecycle、测试、构建和候选应用代码不得以 root 或 `fireside` 生产身份执行；使用无登录、无生产状态/密钥/备份权限的固定 `fireside-build` 身份。root 只负责导出源码、固化所有权、校验 manifest 和原子维护 release 指针。
- `server-build/server/index.js`、`backup-cli.js`、预检入口、客户端 `index.html`、`package.json`、`package-lock.json` 与 manifest 必须是 release 内普通文件，不能是符号链接；manifest 校验失败、产物陈旧或被篡改时拒绝安装。
- 生产依赖安装在 release 内；release 建成、依赖安装和最小自检成功后才允许进入提升阶段。
- 每个 release 以 Git commit 标识且不可就地修改；至少保留当前与上一健康 release。回滚只切换链接并重启 service，不触碰状态目录。

### FR-OPS-010 候选门禁、原子提升与失败回滚

- 生产发布唯一入口是预装到 `/usr/local/sbin` 与 `/usr/local/libexec` 的 `root:root`、开发用户不可写控制器；禁止通过 `sudo` 直接执行可写 Git 工作树中的脚本。生产路径固定，不接受调用者用环境变量覆盖 release、状态、备份、仓库或服务名。
- 预装控制器及其任一子脚本必须在解析测试模式、降权用户、路径或 hook 之前识别生产控制器身份；只要调用环境包含 `FIRESIDE_RELEASE_*` 或其他已定义的测试路径/用户覆盖变量，就必须以退出码 2 拒绝，不能仅忽略。该边界也必须由随生产标记复制到隔离目录的控制器夹具验证，不能只测试工作树入口。
- 控制器不得让 root Git 继承调用者的 `HOME`、XDG、全局/系统配置、`core.fsmonitor`、hooks 或其他可执行配置。所有 Git 读取都必须使用固定 PATH、空的 global/system config，并在命令行禁用 repository-local fsmonitor 与 hooks；隔离生产夹具须注入恶意 HOME/XDG 与仓库本地 fsmonitor 哨兵，证明 status/archive/授权检查前后均不会执行。
- 本地 Git replace/graft 语义不能改写已由 GitHub 授权的对象身份；所有 rev-parse/tree/archive/dirty 命令必须禁用 replacement refs。开发用户创建 `refs/replace/<authorized-commit>` 后，候选归档仍必须来自原始 commit/tree，不能采用替换对象。
- root 工具的临时目录、代理和 systemd/DBus 目标同样不能由调用者决定：控制器固定 root-only `TMPDIR`，清除大小写代理、`NO_PROXY`、DBus/SYSTEMD 变量；健康 curl 还必须显式 `--noproxy '*'`。manifest 校验不得在调用者目录创建随后按路径重新打开的 root 临时文件，systemctl/systemd-run 只能连接本机系统 manager。
- 完整 40 位 commit 还必须属于授权的 `refs/remotes/origin/main`。安装记录 Git tree OID、唯一源码归档 SHA-256、锁文件 SHA-256、Node/npm 版本及全量文件 manifest；完整 SHA 只解决歧义，不能代替发布授权。
- 生产授权不能信任开发用户可改写的本地 remote-tracking ref；控制器必须从固定 HTTPS GitHub 仓库在隔离 Git 环境中读取权威 `refs/heads/main`，并只安装当时精确的远端 main commit。文档的 443 SSH push 后须显式更新/验证 tracking ref，不能假设“向 URL push”等价于命名 remote fetch。
- 安装候选和提升为 `current` 是两个明确阶段。候选至少通过 JavaScript 语法、生产依赖加载、完整自动化/构建，以及在最新一致备份的隔离副本上完成数据库启动迁移、`/api/health`、公开 Topic 读取和关闭；任一失败时 `current` 完全不变。
- `npm ci` 可在无凭据的构建身份下临时访问依赖仓库；测试、构建以及含生产备份副本的预检必须在独立 cgroup 和无外网网络命名空间执行。构建 cgroup 完全结束后 root 才能复制与生成 manifest，防止残留进程在 hash 后修改工件。
- 候选迁移隔离副本后，原 `current` 还必须在同一个已迁移副本上通过健康、公开读取和关闭，证明 schema 对上一健康版本向后兼容；否则不得切换。
- 提升前必须成功生成一份新的在线一致备份。发布全过程使用互斥锁，防止两个发布者同时改写 `current` / `previous`。
- 提升时先解析并保存当前健康 release，再原子切换 `current`、重启服务并在有界时间内检查 HTTP 健康和 MainPID 实际运行目录。两项都成功后才原子更新 `previous` 为原健康 release并报告成功。
- 新服务启动、健康或运行目录验证失败时，工具必须自动把 `current` 原子切回原健康 release、重启并验证恢复；返回非零且不得自动恢复数据库。若回退服务也不健康，必须返回独立的致命错误，保留 socket、状态、备份和两个 release 供人工处置。
- 提供确定性的显式回滚工具：只接受 `/opt/fireside/releases/<40位commit>` 下已校验、服务用户可读的 release；回滚前备份，切换后执行同样的健康/运行目录门禁，失败则回到调用前版本。
- 候选目录存在不等于健康。构建失败、预检失败或曾提升失败的 release 不能被 `current`、`previous` 或备份 timer 隐式采用。
- `current` 与 `previous` 不能原子双写，因此切换前把 `{from,to,originalPrevious,phase}` 以 0600 文件和目录 fsync 写入 root-only 事务日志；切换、restart/health、previous 更新各阶段都持久化。任一未完成事务在下一次变更前一律安全恢复 `from + originalPrevious`，并由开机 recovery unit 在应用启动前执行相同恢复，不能依赖操作者恰好再次发布。
- 所有 `mktemp`、权限设置、备份复制/所有权变更和目标拼接都必须逐步检查；临时目录为空、创建失败或不在固定 root 下时必须在接触备份前退出。禁止空 stage 退化为 `/fireside.db` 或任何 fixed root 外路径。恢复 previous 为 `none` 时删除旧链接失败也必须返回致命恢复失败并保留 transaction，不能在 sync 成功后误报恢复完成。
- 含生产备份副本且已授权给 `fireside-build` 的 preflight stage 必须确认递归删除成功且路径消失后，才能取消 EXIT trap、写 transaction 或切换 `current`。显式清理失败必须以 2 停在切换前并记录稳定错误；trap 的兜底清理失败也必须可见，不能静默把敏感副本当作已删除。
- healthy marker 的 manifest digest 必须先独立计算、检查命令状态并验证为 64 位 SHA-256（仅显式 legacy current 可用固定标记），再写 marker；禁止让 command substitution 失败被外层 `printf` 成功掩盖。marker 生成/持久化失败属于提升失败，必须回到调用前版本。
- manifest 复算器的退出状态必须与内容比较一起成功；process substitution 生产者失败不能被 `cmp` 的前缀相等吞掉。额外的换行/Tab 路径、尾部 stat/hash 失败或任意生成器异常都必须拒绝整个 release。
- 健康门禁不是单次 200：socket 与 service active，MainPID UID 为 `fireside`、cwd 精确指向目标 release，PID 在稳定观察窗不变化，且多个新连接健康请求连续成功。previous 更新或其持久化失败也视为提升失败并恢复原版本。
- socket 与 service 的 active 状态必须分别检查并同时成立；禁止依赖 `systemctl is-active unitA unitB` 的“任一 active 即成功”聚合退出语义。任一 inactive/failed/not-found 都必须拒绝健康版本或触发自动恢复。

### FR-OPS-007 数据库迁移兼容

- 发布前先对一致备份副本运行新版本启动/迁移和完整性检查。
- 不可逆 schema 变化必须使用 expand/migrate/contract 分阶段策略，保证当前和上一 release 都能读取回滚期数据库。
- 健康检查失败不得删除上一 release、旧数据库副本或最新备份。

## 5. 一致备份与恢复

### FR-OPS-008 在线一致备份

- 使用 `better-sqlite3` backup API 从活动 WAL 数据库生成单文件一致备份，禁止 `cp fireside.db` 作为备份实现。
- 写入同目录 root-only 临时文件；在线 backup 完成后先把独立副本转换为 `DELETE` journal，再执行 `integrity_check`，确保最终发布物是无需 WAL/SHM 的单文件快照。校验通过后依次同步临时主文件、原子改名并同步备份目录；只有目录项持久化后才能报告发布成功或清理旧份。
- 清理超额旧份后再次同步备份目录，保证“新快照已持久化 → 旧份删除已持久化”的顺序。同步失败必须返回失败且不得继续 prune；不得声称一个只存在于页缓存的目录项已成功备份。
- 每次运行在创建新临时文件前，扫描并只清理严格匹配本应用临时命名、属于 root、不是符号链接/目录、且早于安全阈值的孤儿主文件与 `-wal/-shm`；新鲜文件视为其他可能在途的备份而保留。发布服务的互斥锁必须阻止同一目录的并发任务。
- 正常成功或可捕获失败都清理本次明确命名的临时主文件、`-wal` 与 `-shm`，不影响既有备份；SIGKILL/断电残留必须能由下一次运行按上述严格条件恢复，而不能无限累积。
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
3. 在线 backup 覆盖 WAL 中未 checkpoint 数据；备份 `journal_mode=delete`、`integrity_check=ok`，Topic/revision/order/参与人数一致，目录中没有本次 `.tmp`、`.tmp-wal`、`.tmp-shm` 或最终同名边车。
4. 备份失败不留下最终文件；保留策略不删除非匹配文件，且仅在成功后保留最新 14 份。
5. TypeScript、全部单元/API、生产构建、依赖审计和桌面/Pixel 7 E2E 回归。
6. 发布测试从提交导出而非复制 ignored build；陈旧/篡改 manifest、必需文件符号链接、非完整 commit 和 root lifecycle 均被拒绝。
7. 候选语法/依赖/隔离数据库预检任一失败时 `current` 不变；提升后健康失败自动恢复原链接和服务；`previous` 只记录已确认健康版本；显式回滚具有同样门禁。
8. 备份故障注入覆盖 file sync、首次 directory sync、prune 与末次 directory sync；未持久化新份时不删除旧份。模拟上次崩溃的旧孤儿会被清除，新鲜/非匹配/非 root/符号链接目标不会被触碰。
9. commit 不属于授权远端 main、root 控制器可写、manifest 外新增文件、构建残留进程、旧版本不能读取候选迁移副本均在切换前拒绝；测试/预检证明无外网且不能读取生产 state/env/backup 原件。
10. 对 journal、current 切换、restart、health 和 previous 更新逐点模拟 SIGKILL；`recover` 与开机 recovery 均恢复调用前两个指针，不采用故障候选、不恢复数据库，重复执行幂等。
11. 把完整控制器复制为带生产模式标记的隔离夹具，分别从 dispatcher 和子脚本注入测试模式、路径、build/preflight/restart/health/sync hook；所有调用必须在 hook 执行、路径访问或 root 写入之前以 2 拒绝。无测试变量时仍固定使用真实生产路径，不能回退到夹具相对路径。
12. 为 install 的 Git fixture 分别在恶意 `HOME/.gitconfig`、`XDG_CONFIG_HOME/git/config` 与仓库 `.git/config` 配置 `core.fsmonitor` 外部程序；控制器必须继续给出预期业务结果且所有哨兵均不存在。调用环境中的 Git config/exec/SSH 变量不得改变 commit、授权 ref、归档或 dirty 判定。
13. 注入攻击者 `TMPDIR`、`GIT_CONFIG_PARAMETERS`、`GIT_EXEC_PATH`、`GIT_TRACE*`、大小写代理与 `DBUS_SYSTEM_BUS_ADDRESS`/SYSTEMD 变量；manifest 比较只能使用 root 私有临时对象，本机健康请求不得到达假代理，systemd 操作不得连接调用者总线。真实候选 health 失败时仍须回退，不能被代理的伪造 200 判健康。
14. 生产等价 health hook 分别返回“socket inactive + service active”“socket active + service inactive”，两种都必须失败；只有两者各自 active 才继续 PID/cwd/UID、稳定窗和 HTTP 校验。
15. 让 preflight root 不存在、不可写或让 `mktemp/chmod/install/chown` 逐点失败；不得创建 `/fireside.db` 或 fixed preflight root 外文件，指针/业务指纹不变。把待删除 previous 链接替换为不可删除项时，recover/rollback 必须返回 4、保留 transaction，不能报告成功或 3。
16. 临时 bare remote 流程证明“按 443 URL push → 显式 fetch tracking ref → 精确校验”可复现；生产 install 另以固定 HTTPS `refs/heads/main` 为权威，开发用户篡改本地 `refs/remotes/origin/main` 不能授权未推送 commit。
17. 注入 manifest digest 读取/hash 失败；不得生成空 digest healthy marker，不得把目标记为 previous/healthy，提升必须按事务语义自动恢复。
18. 在合法 manifest 后增加排序位于尾部且含换行/Tab 的路径，或让尾部 stat/hash 失败；即使生成器已输出的前缀与磁盘 manifest 完全相等，验证仍必须失败。
19. 为已授权 commit 创建指向恶意 commit 的本地 `refs/replace`；controller 的 tree、archive 和最终 marker 必须仍对应原对象，替换内容不得进入候选。
20. 在三次业务指纹均一致后注入 preflight stage 删除失败；命令必须返回 2，current/previous/journal 不变且明确报告待人工清理的路径状态。恢复清理能力后，同一门禁可正常完成且不残留 stage。

### 7.2 生产

1. 迁移前后公开 Topic/统计摘要、全部 revision、order version 和参与人数指纹一致；旧 DB 留存且改为 root-only。
2. socket 与 service 均 active，`0.0.0.0:80` 由 systemd PID 1 持有；MainPID 为 UID/GID `fireside` 的直接 Node，子进程不含 npm/tsx/esbuild。
3. `/proc/<pid>/status` 的 CapInh/Prm/Eff/Amb/Bnd 全零，NoNewPrivs=1；服务用户不能写 release/unit/env/backup，也不能直接读 env/backup。
4. `/var/lib/fireside` 为 0700，DB/WAL/SHM 为 0600；`nobody` 不能读取任何状态或备份文件。
5. 连续重启期间从本机并发探测 80：socket 始终 LISTEN，无 connection refused；重启后健康页、首页、公开 API、有效协作会话与业务数据正常。
6. 手动触发一次在线备份并完成隔离恢复演练；生产业务指纹不变，备份日志无敏感字段。
7. `systemd-analyze security` 不再报告 root、完整 capability、开放 home、共享 tmp 或可写系统目录；记录最终 exposure 分数但以真实功能/权限验证为准。
8. 用故意无法启动的隔离候选执行生产等价提升测试，验证自动回退后公网 socket、本机健康、原 MainPID release 和业务指纹恢复；测试不得把故障候选留作 `previous`。
9. `/usr/local` 的生产控制器和 recovery unit 为 root-owned、不可由 `dsj`/`fireside-build`/`fireside` 修改；日常发布不执行工作树脚本。完成一次持久 journal 故障恢复演练并证明开机顺序在应用之前。

## 8. 完成条件

- 应用以非 root、零 capability、预编译 Node 在 socket activation 下提供 80 服务。
- 生产状态私有且只有应用可写，密钥和备份对应用不可读写，普通用户不能读取任何数据库工件。
- 一致备份、完整性检查、保留和隔离恢复演练成立；版本化 release 可回到上一版本且不覆盖数据。
- 构建产物可追溯到唯一 Git commit，root 不执行仓库 lifecycle；候选在切换前通过隔离门禁，切换失败能自动回到调用前健康版本。
- 全量自动化、生产迁移、重启连续性、权限矩阵、日志脱敏与独立发布审计通过后，状态方可改为 `Accepted`。

## 9. 发布审计补充（2026-09-02）

首次生产迁移证明非 root 运行、权限分离、socket 连续性和一致备份主体成立，但独立审计发现两个 P1：ignored `server-build/` 可被旧产物冒充当前 commit，且 root 执行依赖 lifecycle；旧安装脚本还会在任何候选健康检查前直接切换 `current`，没有可执行的 previous 指针或自动回退。另发现备份 rename / prune 缺少 file 与 directory fsync，崩溃残留不会在后续运行回收。

这些发现使本规格保持 `Implementing`，成熟度连续通过计数归零。FR-OPS-006、010 和 FR-OPS-008 的新增门禁必须在 Iteration 023 完成后重新执行发布失败注入、备份崩溃恢复、全量自动化和生产验证，才能验收 SPEC-010。

实现复审又确认一个生产控制器信任边界 P1：测试模式和测试 hook 原本由调用环境决定；如果预装入口或其子脚本接受这些变量，具备受限 sudo/SETENV 权限的调用者即可让 root 使用调用者路径或执行 hook。修复必须让预装路径及带生产标记的等价夹具在读取任何覆盖值之前拒绝全部发布测试变量，并用“恶意 hook 会留下哨兵文件”的红测证明 hook 从未执行。该发现再次把成熟度连续计数归零。

同一复审进一步发现 root Git 的配置面仍继承调用者 HOME/XDG，而工作仓库自己的 `.git/config` 也由开发用户控制；`git status` 可由 `core.fsmonitor` 执行任意外部程序。生产发布必须使用完全隔离的 Git 配置环境并显式关闭 repository-local fsmonitor/hooks，测试以三种配置来源的恶意哨兵验证。修复和部署后仍须重新开始独立审查，不能把本次修复计为“无新增有效轮次”。

环境复审还确认 `TMPDIR` 可把 root manifest 临时文件引到攻击者父目录，代理可劫持回环 health，DBus/SYSTEMD 环境可改写 systemctl 目标。上述变量必须由统一净化层清除，生产临时目录必须 root-only，curl 还需主动禁用代理；故障回归须证明假代理无请求且候选真实 health 失败仍自动回退。

健康门禁复审还复现：单条 `systemctl is-active fireside.socket fireside.service` 在任一单元 active 时即可返回 0，不能证明两者同时 active。实现必须拆成两个独立断言，并覆盖两种单边 active 组合；该 P1 继续使成熟度计数为 0。

失败路径复审进一步发现，promote 没有检查 preflight `mktemp/chmod/install/chown`：stage 为空时目标会退化为 `/fireside.db`，造成 root 把完整生产备份遗留在错误路径；`restore_previous_pointer none` 也可能忽略删除失败、清 journal 后误报恢复完成。所有路径构造必须先证明非空且位于固定父目录，每个文件操作都要失败即停，恢复不完整必须返回 4 并保留证据。

同类状态掩蔽还存在于 healthy marker：`printf "$(release_manifest_digest)"` 会吞掉内部 hash 失败并写出空 digest。digest 必须先独立取得且验证格式；失败时不得把不可验证 release 标记为健康，必须进入自动恢复。

移除不可信 TMPDIR 时使用 process substitution 又暴露了 producer 状态丢失：`cmp` 只看到合法前缀即可成功，无法得知 manifest 复算器在尾部非法路径/stat/hash 上已经失败。实现必须用 `pipefail` 覆盖的完整 pipeline 或 root 私有临时文件同时检查生成和比较状态。

发布文档和授权链也存在闭环缺口：直接向 SSH URL push 不会更新命名 remote 的 tracking ref，而本地 ref 本身又可由开发用户改写。文档必须显式 fetch/验证；生产控制器则从固定 HTTPS GitHub `refs/heads/main` 读取权威 commit，不能把开发者仓库元数据当授权根。

主动复核补充：即使 commit SHA 由 GitHub 精确授权，本地 `refs/replace/<commit>` 仍可让默认 `git archive` 读取另一对象。隔离 Git 命令必须统一设置 no-replace 语义，并以恶意替换树证明归档身份没有被本地元数据改写。

敏感副本清理复审发现：三次 preflight 成功后的显式 `rm -rf` 状态原先未检查，脚本会取消 trap 并继续发布，可能把 build 用户可读的生产数据库副本留在 `/run`。清理成功和路径消失是写发布事务前的硬门禁；失败不得切换版本或误报完成。
