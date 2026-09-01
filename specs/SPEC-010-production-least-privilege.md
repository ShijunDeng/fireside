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
- immutable release 的目标不存在检查必须在取得共同维护锁后执行，并在最终发布前再次确认；最终目录移动必须使用不把既有目标当目录的 `mv -T` 或等强 no-replace语义。两个相同 SHA 并发 install 时只有一个可成功，另一个明确拒绝且不能把 publish stage 嵌入、修改文件集合或让既有 manifest失配。

### FR-OPS-010 候选门禁、原子提升与失败回滚

- 生产发布唯一入口是预装到 `/usr/local/sbin` 与 `/usr/local/libexec` 的 `root:root`、开发用户不可写控制器；禁止通过 `sudo` 直接执行可写 Git 工作树中的脚本。生产路径固定，不接受调用者用环境变量覆盖 release、状态、备份、仓库或服务名。
- 预装控制器及其任一子脚本必须在解析测试模式、降权用户、路径或 hook 之前识别生产控制器身份；只要调用环境包含 `FIRESIDE_RELEASE_*` 或其他已定义的测试路径/用户覆盖变量，就必须以退出码 2 拒绝，不能仅忽略。该边界也必须由随生产标记复制到隔离目录的控制器夹具验证，不能只测试工作树入口。
- 控制器不得让 root Git 继承调用者的 `HOME`、XDG、全局/系统配置、`core.fsmonitor`、hooks 或其他可执行配置。所有 Git 读取都必须使用固定 PATH、空的 global/system config，并在命令行禁用 repository-local fsmonitor 与 hooks；隔离生产夹具须注入恶意 HOME/XDG 与仓库本地 fsmonitor 哨兵，证明 status/archive/授权检查前后均不会执行。
- 本地 Git replace/graft 语义不能改写已由 GitHub 授权的对象身份；所有 rev-parse/tree/archive/dirty 命令必须禁用 replacement refs。开发用户创建 `refs/replace/<authorized-commit>` 后，候选归档仍必须来自原始 commit/tree，不能采用替换对象。
- 禁止从开发用户仓库执行权威 `ls-remote` 或生成发布 archive：repository-local `url.*.insteadOf`、`core.attributesFile`、`.git/info/attributes` 等仍可改写远端和归档。生产必须把固定 HTTPS GitHub main fetch 到 root-owned、空配置的临时 bare 仓库，commit 授权、tree 与 archive 全部来自该仓库；开发工作树只参与 HEAD/dirty 的非授权性前置检查。
- root 工具的临时目录、代理和 systemd/DBus 目标同样不能由调用者决定：控制器固定 root-only `TMPDIR`，清除大小写代理、`NO_PROXY`、DBus/SYSTEMD 变量；健康 curl 还必须显式 `--noproxy '*'`。manifest 校验不得在调用者目录创建随后按路径重新打开的 root 临时文件，systemctl/systemd-run 只能连接本机系统 manager。
- 完整 40 位 commit 还必须属于授权的 `refs/remotes/origin/main`。安装记录 Git tree OID、唯一源码归档 SHA-256、锁文件 SHA-256、Node/npm 版本及全量文件 manifest；完整 SHA 只解决歧义，不能代替发布授权。
- 生产授权不能信任开发用户可改写的本地 remote-tracking ref；控制器必须从固定 HTTPS GitHub 仓库在隔离 Git 环境中读取权威 `refs/heads/main`，并只安装当时精确的远端 main commit。文档的 443 SSH push 后须显式更新/验证 tracking ref，不能假设“向 URL push”等价于命名 remote fetch。
- 安装候选和提升为 `current` 是两个明确阶段。候选至少通过 JavaScript 语法、生产依赖加载、完整自动化/构建，以及在最新一致备份的隔离副本上完成数据库启动迁移、`/api/health`、公开 Topic 读取和关闭；任一失败时 `current` 完全不变。
- `npm ci` 可在无凭据的构建身份下临时访问依赖仓库；测试、构建以及含生产备份副本的预检必须在独立 cgroup 和无外网网络命名空间执行。构建 cgroup 完全结束后 root 才能复制与生成 manifest，防止残留进程在 hash 后修改工件。
- 候选迁移隔离副本后，原 `current` 还必须在同一个已迁移副本上通过健康、公开读取和关闭，证明 schema 对上一健康版本向后兼容；否则不得切换。
- 迁移前后还必须比较不含 schema 的 `businessDataSha256`：按主键稳定序列化既有 topics 全业务列、participant 姓名/规范名/时间和 order 行。它必须检测同 revision 的标题/摘要改写及非空到非空会议链接替换，同时允许只新增 schema/索引/带默认值的新列；候选自身 before/after 和 origin 对迁移前后副本均须一致。
- 提升前必须成功生成一份新的在线一致备份。发布全过程使用互斥锁，防止两个发布者同时改写 `current` / `previous`。
- 共同维护锁 `/run/fireside-release.lock` 必须由 root 以 0600 创建，并在每次控制器操作前验证为 `root:root`、普通文件、单链接、非符号链接；不能依赖调用者 umask。普通用户不得只读打开后用排他 flock 制造本地发布/备份 DoS，backup 与 controller 必须继续锁住同一 inode。
- 首次从历史版本提升时不能调用缺少本规格 fsync/互斥/孤儿恢复的旧 current backup CLI：正常 promote 使用已通过 manifest 与权威 main 授权的 target backup runner；rollback 使用调用前 current 的已健康 runner。runner 任一失败仍在切换前退出，且备份 transient sandbox 必须显式隐藏 `/etc/fireside.env`。
- 提升时先解析并保存当前健康 release，再原子切换 `current`、重启服务并在有界时间内检查 HTTP 健康和 MainPID 实际运行目录。两项都成功后才原子更新 `previous` 为原健康 release并报告成功。
- 新服务启动、健康或运行目录验证失败时，工具必须自动把 `current` 原子切回原健康 release、重启并验证恢复；返回非零且不得自动恢复数据库。若回退服务也不健康，必须返回独立的致命错误，保留 socket、状态、备份和两个 release 供人工处置。
- 提供确定性的显式回滚工具：只接受 `/opt/fireside/releases/<40位commit>` 下已校验、服务用户可读的 release；回滚前备份，切换后执行同样的健康/运行目录门禁，失败则回到调用前版本。
- `rollback --previous` 表达的是取得维护锁时刻的上一健康版本，wrapper不得先在锁外解析成 SHA。该意图必须原样传入主锁监督下的控制器，再解析/验证 previous；并发 promote更新 previous 时，要么采用锁内新值，要么因基线变化明确拒绝，不能静默回到陈旧的上上版。显式40位commit语义不变。
- 候选目录存在不等于健康。构建失败、预检失败或曾提升失败的 release 不能被 `current`、`previous` 或备份 timer 隐式采用。
- `current` 与 `previous` 不能原子双写，因此切换前把 `{from,to,originalPrevious,phase}` 以 0600 文件和目录 fsync 写入 root-only 事务日志；切换、restart/health、previous 更新各阶段都持久化。任一未完成事务在下一次变更前一律安全恢复 `from + originalPrevious`，并由开机 recovery unit 在应用启动前执行相同恢复，不能依赖操作者恰好再次发布。
- `RemainAfterExit` 的开机 recovery 只能作为本次开机的第一道门，不能代替每次启动门禁。`fireside.service` 每次自动/显式启动和 `fireside-backup.service` 每次 timer/人工启动都必须先执行 root-owned transaction gate：有 journal 且发布锁空闲表示控制器已成为 orphan，必须在 Node 或 backup runner 执行前恢复；有 journal且锁被当前受控 promote 持有时，只允许与已校验 journal 阶段、current 指针和目标完全一致的那次受控服务重启，不能让普通并发启动猜测放行。
- 无 journal 也不是可以直接放行：`/run` 跨重启会消失，gate 必须从受信 `current` 重新校验 release manifest 与 healthy marker，在同一把锁内原子重建 root-owned selector 和与 commit 精确匹配的写许可。坏类型、悬空/越界 current、缺失或错误 healthy marker 必须失败关闭，Node 与 backup runner 都不能启动；只有显式记录的 legacy current 可以走兼容标记。
- 每次启动门禁不能与持排他锁同步等待 `systemctl restart` 的正常 promote 自锁死，也不能把调用者环境、可写 marker 或“lock 正忙”本身当作授权。受控 restart 与 orphan 的区分必须绑定 root-owned事务、当前指针和活跃控制器所有权；控制器在放行点前后异常退出时，下一次 service/backup 入口仍须先恢复，且 backup 绝不能从未验收 target 执行或 prune。
- 新事务必须有至少 128-bit 随机 txid，并把 owner boot id、PID/starttime、固定控制器身份和锁 inode 作为附加证据。每次受控 service restart 使用 journal 内原子 fsync 的单次许可，绑定 txid、phase、expected commit、purpose 和递增 generation；gate 原子消费，旧许可、第二次 restart、错误 current/phase/owner/lock 一律拒绝。PID 或 lock-busy 单独都不是授权。
- service gate 在同一锁内把已验证 commit 固化为 root-owned 不可变运行 selector，MainPID 的 WorkingDirectory/ExecStart 必须引用 selector 而不是可变 `current`，关闭 pre-gate→exec 的 current TOCTOU。gate 拿到锁时直接在同一 worker 内恢复，不得再次调用会重复 flock 的入口。
- runtime tree 可读校验必须覆盖完整绝对路径的每一级父目录，而不只 commit目录内部。生产 `/opt`、`/opt/fireside`、`releases` 与commit目录均须真实目录、root所有、非group/world writable且other可遍历；任一级0700、错误owner、链接或异常类型都在发布selector/permit前失败关闭。测试根使用等价可注入路径检查。
- 主发布锁忙时 service gate 的许可消费也必须与 watchdog 原子互斥：使用第二个 root:root 0600、普通单链接 gate mutex，service gate 在 owner校验→消费journal→selector 固化全程持有；watchdog 取得主锁后再按统一锁序取得 gate mutex 才恢复。正常 controller 不持 gate mutex。恢复者持主锁和 mutex 写好 `reverting + pending recovery permit` 后，必须临时释放 mutex 让本次 service gate 消费，随后重新取得 mutex，并在仍持主锁下复核相同 txid/generation 已 consumed 与 MainPID/cwd/health后继续，不能持 mutex 同步等待 restart 形成自锁。owner 校验后 controller 死亡时，watchdog要么先阻断旧 gate，要么等待它完成后恢复，旧 gate 不能在 journal 清理后复活 target 事务。
- 控制器在主锁内先持久化仅含 `prepared`、尚未改指针/数据/写许可的 owner journal，再启动独立 root-owned watchdog。这使监督锁在两步之间丢失时，任一gate/recover都能从journal识别并终止孤儿worker；不得出现watchdog先因“无journal”退出、旧worker再无锁继续的窗口。watchdog 就绪前禁止 active marker、revoke、数据或指针副作用；启动失败时须在仍持锁下安全清理该 prepared journal，清理失败则返回4保留证据。
- “systemd-run 成功 exec”不等于 watchdog 已就绪。watchdog 必须使用 txid 绑定的 `Type=notify`（或同强度握手），在验证固定生产控制器、txid、已存在且匹配的 prepared journal、锁 owner/mode/link/inode且已准备阻塞等待该锁后才向 PID 1 发 READY；controller 有界等待 READY 并复查 unit active 后才能继续 active/revoke。exec 后立即退出、坏参数/锁/journal、未 READY、超时或 unit 被杀均在切换前失败关闭；异常退出由 PID 1 重启，正常看到 journal 已清后成功退出。
- watchdog 的 systemd sandbox 只保留恢复主库和所有权所需的最小 `CAP_DAC_OVERRIDE/CAP_CHOWN/CAP_FOWNER`，不保留完整 root capability、网络或生产密钥访问；工作路径固定且不能被调用环境覆盖。
- fd 9 等发布锁描述符不得被 systemctl/systemd-run/curl/Node 或任意子进程继承。外部命令执行前显式关闭该 fd；“杀 controller 但保留子进程”时锁必须立即释放给 watchdog，不能形成 owner 已死而 lock 仍忙的不可恢复状态。
- 主维护锁优先由 `flock --close` 监督进程持有，controller 本身及其全部后代从未拥有该 fd；不能只在已知 systemctl/curl 调用点关闭，因为 sync/stat/hash 等任一存活子进程都可能继承。测试让持久化子进程在父 controller 被杀后继续存活，watchdog必须立即取得同一 inode。
- `flock --close` 监督者与唯一 mutating worker 必须有死亡耦合：worker在独立 session/process group运行。恢复者取得空闲主锁后若 journal owner仍活跃，视为监督者失联；须校验固定controller身份、PID/starttime/boot/session/PGID后终止并reap整个受信进程组，再接管恢复。不能一边恢复一边让旧worker/后代复活journal；身份无法证明时返回4保留证据。
- 进程组终止的成功条件是原 PGID/session 内已无任何存活成员，不是 journal 记录的 leader PID 已退出。TERM 后必须枚举 `/proc` 证明整组为空；超时则对原组无条件 KILL 并再次证明为空。任意忽略 TERM 或晚于 leader 退出的后代仍存活时，恢复者必须返回4并保留journal，不得改写指针。
- leader 在恢复者进入前已消失也不等于进程组为空。恢复者先校验 root-only journal、boot id和lock inode，再按记录的 `PGID=session=owner_pid` 枚举；若leader仍在则还校验starttime/固定controller身份，若leader已不在但同session后代存活，仍必须TERM/KILL并证明整组为空。只有“leader不活跃”就直接return的实现禁止。
- install 也是发布状态变更命令。它获得主锁后的第一个状态动作必须检查 root-only transaction 与 active marker；任一存在时都不得进入 Git fetch、构建、preflight 或创建 release stage。最小可接受行为是立即以锁冲突语义失败并保留证据，让 watchdog/recover 立即取锁；不得用长时间 candidate build 阻断公网版本恢复。
- backup 不得与 root recovery 共用一个扩大写权限的 sandbox。使用独立 root-owned gate/recovery unit，再进入保持现有最小权限的 runner unit；runner 在取得共享锁后再次只读确认没有 journal并解析已健康 selector，防止 gate→runner 间竞态。任意 active transaction 都不得执行 target backup CLI 或 prune。
- service gate 与 backup gate 的 orphan 语义不同：service gate 仅在旧 MainPID 已停止的 `ExecStartPre` 中允许无 restart 恢复，随后本次启动 origin；backup gate 若先于 watchdog 取得孤儿锁，必须执行完整的授权 restart、验证 origin MainPID/cwd/health、重建 selector/许可并清 journal后才能进入 runner，不能只回指针后让仍运行的 target 留在公网。也可以不清 journal并让本次 backup 失败等待 watchdog，但绝不能从 target 备份。
- `fireside-runtime-gate.service` 可被单独启动，因此不能仅根据 `--service-gate` 意图假定旧 MainPID 已停止。no-restart 恢复在触碰journal/current前必须从固定 systemd 接口证明 `fireside.service` 无活跃 MainPID；若 target 仍在运行，必须执行完整 restart/cwd/health 恢复，或返回4并保留journal等待watchdog。绝不允许清journal后留下进程target、指针/selector/permit=origin的裂脑。
- 最小权限 backup runner 不得写 `/run`。root gate 负责创建和严格验证维护锁；runner 仅以只读 fd 对同一 inode 取得共享 flock，并在整个 `/run` 只读的 sandbox 中复查 transaction/active/selector/permit。候选 backup CLI 尝试 unlink/replace lock、selector或permit必须得到 EPERM，发布控制器只能在该共享锁释放后取得独占锁。
- root gate 必须是没有 `EnvironmentFile=/etc/fireside.env` 的独立 unit，不能把 root `ExecStartPre` 直接放进应用 unit 而继承业务写入口口令。gate、watchdog、recovery 与 backup 的环境必须在日志和首个子进程前显式移除 `FIRESIDE_WRITE_KEY` 及会话密钥；只有非 root Node MainPID 可继承应用所需密钥。
- 所有 `mktemp`、权限设置、备份复制/所有权变更和目标拼接都必须逐步检查；临时目录为空、创建失败或不在固定 root 下时必须在接触备份前退出。禁止空 stage 退化为 `/fireside.db` 或任何 fixed root 外路径。恢复 previous 为 `none` 时删除旧链接失败也必须返回致命恢复失败并保留 transaction，不能在 sync 成功后误报恢复完成。
- 事务清理必须先同时验证 journal 和 release-active 的固定类型、owner/mode/link count（active 还必须绑定当前 txid），再按可幂等的 fsync 顺序清理。active 为目录、链接、错误所有者或内容时，不得先删唯一 journal 证据；必须返回4，保留两者供人工修正。
- 含生产备份副本且已授权给 `fireside-build` 的 preflight stage 必须确认递归删除成功且路径消失后，才能取消 EXIT trap、写 transaction 或切换 `current`。显式清理失败必须以 2 停在切换前并记录稳定错误；trap 的兜底清理失败也必须可见，不能静默把敏感副本当作已删除。
- SIGKILL 不会执行 EXIT trap，因此敏感 preflight 不得直接放在可被同一 `fireside-build` UID 枚举的 `/run`。所有真实业务副本位于 root:root0700 固定父目录，stage 只绑定暴露给本次无网 preflight unit；带网的 `npm ci` build unit 还必须显式 `InaccessiblePaths` 该父目录。每个获得主锁的入口在新操作前必须先停止/等待固定前缀的旧 preflight transient unit，再严格验证并清理孤儿stage。不得边运行旧unit边删副本，也不得让下一次有网lifecycle读取。
- healthy marker 的 manifest digest 必须先独立计算、检查命令状态并验证为 64 位 SHA-256（仅显式 legacy current 可用固定标记），再写 marker；禁止让 command substitution 失败被外层 `printf` 成功掩盖。marker 生成/持久化失败属于提升失败，必须回到调用前版本。
- manifest 复算器的退出状态必须与内容比较一起成功；process substitution 生产者失败不能被 `cmp` 的前缀相等吞掉。额外的换行/Tab 路径、尾部 stat/hash 失败或任意生成器异常都必须拒绝整个 release。
- 健康门禁不是单次 200：socket 与 service active，MainPID UID 为 `fireside`、cwd 精确指向目标 release，PID 在稳定观察窗不变化，且多个新连接健康请求连续成功。previous 更新或其持久化失败也视为提升失败并恢复原版本。
- gate/watchdog 的最小 capability 不包含 `CAP_SYS_PTRACE`，不得为读 MainPID cwd 而扩权，否则 root gate 可读 Node environ 中的业务口令。新 release 必须在 `/api/health` 返回从受信 `RELEASE_COMMIT` 读取的精确 commit；恢复门禁结合双 unit active、稳定 MainPID、`/proc/status` UID 与连续新连接上的 expected commit 验证实际版本。只有无 release metadata 的明确旧版本可用固定 root-owned、`env -i`、User=fireside、只执行 `/usr/bin/readlink` 的极窄 transient helper 读 cwd；不得运行 shell、访问env文件或输出任何环境。
- socket 与 service 的 active 状态必须分别检查并同时成立；禁止依赖 `systemctl is-active unitA unitB` 的“任一 active 即成功”聚合退出语义。任一 inactive/failed/not-found 都必须拒绝健康版本或触发自动恢复。

### FR-OPS-007 数据库迁移兼容

- 发布前先对一致备份副本运行新版本启动/迁移和完整性检查。
- 不可逆 schema 变化必须使用 expand/migrate/contract 分阶段策略，保证当前和上一 release 都能读取回滚期数据库。
- 健康检查失败不得删除上一 release、旧数据库副本或最新备份。

### FR-OPS-011 新主机首次自举

- 文档中的“首次准备”必须能在没有 `current`、`previous` 和运行中 Fireside 服务的新主机上从零完成，不能把已有健康 `current` 当作隐含前置条件。控制器提供显式 `bootstrap <commit>`；普通 `promote` 继续只处理已有健康版本升级，两种语义不得自动猜测。
- bootstrap 只在 `current`、`previous`、发布事务三者均不存在时运行；任一已存在（包括错误类型、悬空链接或半完成状态）都拒绝。目标 release 仍须通过完整 commit、manifest、运行树和预检门禁。第二次 bootstrap 必须拒绝且不改变 current、数据库、备份或服务。
- systemd 单元、`fireside`/`fireside-build` 身份、root-only 密钥、`/var/lib/fireside-release`、生产状态和备份目录是 bootstrap 的显式前置条件。README 必须先安装/加载单元并让 recovery 进入本次开机的 active-exited 状态，再执行 install/bootstrap；不能先 promote、后安装单元。
- 新机准备命令必须显式创建并立即验证 `/var/lib/fireside-release` 为 root:root 0700，与 release root、业务数据和备份目录一并形成完整四目录前置。不能依赖 controller 在 systemd sandbox 外隐式创建；`ReadWritePaths` 的固定目标在 recovery 启动前必须存在，缺失时文档前置验收应明确失败。
- 无主库时，候选在 root-only 临时目录创建 `seed=false` 的空业务库并通过健康、公开读取、关闭和业务指纹检查，再以 `fireside:fireside 0600` 安装为生产库；不得在预检前建立 `current`。失败恢复后不得遗留 current/previous、空主库、WAL/SHM 或健康标记。
- SQLite 边车必须完整覆盖 `-wal`、`-shm` 和 rollback `-journal`。无主库而任一同名边车以普通文件、链接、目录或其他类型存在时，bootstrap 在触碰指针/数据库前拒绝并原样保留证据；不能把 hot journal 当作无关文件。workload 已停止后的安装/恢复须安全清理三类旧边车并同步目录，再原子替换主库并再次同步；原本无库的失败恢复不遗留本次任何主库或边车。
- 已有主库但没有 current 时，bootstrap 必须先停止 socket/service、防止新写入，再用目标 release 的崩溃安全 backup runner 创建并持久化一致备份，在副本上迁移和校验 `businessDataSha256`，最后才安装迁移后的独立副本。失败或中断必须从记录的原始备份恢复主库，保留该 root-only 备份，不得把空库或半迁移库当成成功状态。
- bootstrap 数据库临时文件在原子 rename 前始终保持 root:root 0600；不能提前降权给未来应用 UID。使用单一固定父目录内的 pending 名，recovery 只在验证它是 root 所有、0600、普通单链接文件后删除并同步目录；rename 后才给最终主库设置 `fireside:fireside 0600` 并再次同步。任意 SIGKILL/失败恢复后都不能残留 `.bootstrap.*` 或应用用户可读的完整业务副本。
- bootstrap 在首次数据库替换和 `current` 切换前写入可 fsync 的 root-only 事务日志，记录目标 commit、原主库是 absent 还是对应的严格备份文件，并绑定备份 SHA-256 与字节数，以及阶段。恢复在触碰 current/主库前重新验证固定目录、root:root 0600、普通单链接文件及精确大小/hash；任何不符都返回 4并保留 journal与现有主库。复制到 root-only pending 后再次校验、file fsync再原子rename。开机/手动 recovery 对可信 bootstrap 的确定性结果是：停止服务、移除首次 current/previous、恢复原主库或删除本次新建主库及边车，然后清日志；恢复任一步失败返回 4并保留证据。
- 首次 current 切换后必须启动 socket/service并通过与 promote 相同的双 unit、稳定 PID、UID、cwd 和连续 HTTP 健康门禁；成功后写健康标记、持久化并清事务，`previous` 保持不存在。健康失败应完整回到“未 bootstrap”状态并返回 3；恢复失败返回 4。
- bootstrap 或其他发布事务开始切换前必须关闭 root-owned 运行时写许可。候选可以在公网 80 完成只读 live health，但从首次启动到所有可回退步骤持久化完成之间，创建、编辑、删除、排序、认领、排期、报名、归档等业务写必须稳定返回 `503 RELEASE_IN_PROGRESS` 且没有数据库副作用；页面保留草稿并提示稍后重试。认证换取短期会话和公开读取不修改业务数据，可以继续。
- 写许可必须绑定当前 release commit，不能使用可被旧版本/旧事务重放的固定布尔文件。只有健康 marker、previous 语义、业务指纹和事务“向前提交”状态均已 fsync 后，控制器才原子发布目标 commit 的写许可。一旦许可发布，任何后续清理失败或控制器退出都不得恢复启动前数据库或让已返回 2xx 的业务写丢失；recovery 必须识别 committed 阶段并向前完成 current/marker/清理。
- `publish` 的 temp fsync、rename 和目录 fsync 有不同可见性，但调用者在进入已 fsync 的 committed phase 后不得再走回退分支；即使 rename 后目录 fsync 报错且并发请求已读到许可，recovery 也只能重试发布并向前完成。事务前 revoke 若 unlink 已可见但目录 fsync 失败，必须恢复 origin commit 的许可或留下可恢复 journal，不能在无事务状态静默永久 503。
- 为消除 revoke 的无日志窗口，控制器必须先持久化可恢复 journal 与 active marker，再撤销 origin 写许可；journal/marker/revoke 任一步失败均按 journal 恢复 origin。journal 清理发生在许可持久化之后；若 active marker 的最终清理失败，watchdog/gate 仍须清除该过期标记，不能让备份永久拒绝。
- transaction、healthy marker、release-active 与 writes-enabled 等固定文件路径在原子替换前必须拒绝目录、链接和非预期类型，并使用不把目标当目录的 `mv -T` 语义。异常类型原样保留人工证据，临时文件不能被移入其中；命令不得误报成功或先清 journal。
- 普通无事务启动也必须让服务进程的 release commit 与 root-owned 写许可一致；缺失、错误 commit、错误类型/权限/链接时读取仍可服务但业务写失败关闭。首次部署文档和生产验收必须在成功 bootstrap 后确认许可已发布，重启后仍匹配 current。
- 含业务数据的预检目录必须遵守既有敏感副本清理门禁。bootstrap 与 promote/rollback/backup 共用同一个 root-only 维护锁，任何失败均不得误报成功。

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
21. 用“旧 origin runner 写旧哨兵、target runner 写安全哨兵”的夹具证明首次 promote 只执行 target backup CLI；成功后 rollback 使用调用前 current 的安全 runner。安全 runner 的 file/dir sync 故障仍须保持双指针/journal不变且不 prune，备份进程不可读取密钥文件。
22. 在 umask 022 且锁不存在时执行 install/promote/recover 的锁准备逻辑，结果必须为 root:root 0600 普通单链接文件；预置 0644 时安全修权，预置 symlink/目录/非 root/多链接时拒绝。`nobody` 无法打开或持锁，backup 与 controller 的共享/排他互斥仍成立。
23. 在开发仓库 local config 设置 `url.*.insteadOf` 指向攻击者 bare main，并用 `core.attributesFile`/`.git/info/attributes` 对 tracked 文件设置 `export-ignore`；生产授权、tree 和归档仍只能来自固定 GitHub fetch 的 root-owned bare 仓库，假 main 与被隐藏文件均不能进入结果。
24. 候选迁移分别在不递增 revision 时改写 title/summary、把一个非空 meeting URL 替换为另一非空 secret；计数、revision、presence 与 order 均保持不变，`businessDataSha256` 必须变化并在切换前退出 2。只 ADD COLUMN/default/index 的 schema 扩展必须保持该 hash 并通过。
25. 干净 fixture 按 README 从创建目录、安装/加载 unit、install 到 `bootstrap` 后在 80 端口健康；初始没有 current/previous/DB，成功后 current 指向目标、previous 仍不存在、主库私有且 status 为 clean。
26. 无 current 但已有业务库时，bootstrap 必须先生成一致备份；预检、数据库安装、指针、restart、health、marker 和清 journal 各阶段失败/中断都恢复原业务指纹与“无 current”状态。恢复失败返回 4 并保留 journal；成功恢复返回 3，重复 recovery 幂等。
27. current、previous、journal、悬空指针或非链接路径任一已存在时 bootstrap 都拒绝；第二次 bootstrap 不改变健康 current、DB、备份数量和服务。无主库失败不得遗留新 DB/WAL/SHM。
28. 同一 boot 先让 recovery 达到 active-exited，再在 promote 的 prepared/switched/healthy/previous 各阶段模拟控制器 SIGKILL；随后分别触发 `Restart=on-failure`、显式 service restart、timer 和人工 backup。每次启动门禁必须在业务 Node/backup runner 前恢复 orphan transaction，最终 current/previous/cwd 回到 from/originalPrevious，target runner 从未被 backup 调用。
29. 正常 promote 持排他锁执行受控 restart 不与每次启动门禁死锁，只有 journal 中目标可被启动并完成健康门禁；伪造/陈旧授权、错误 phase/current、锁由非对应操作占用或控制器在放行边界退出都不能让未验收 target 成为持久运行版本。
30. 在 bootstrap 的 target 已启动后分别阻塞 live health、healthy journal、marker/state sync、写许可和 clear journal；用真实会话提交创建/编辑/删除/排序/认领/排期/报名/归档。提交点前全部返回 503、revision/order/名单不变且页面草稿可重试；写许可发布后的任意 2xx 在控制器死亡和 recovery 后仍存在，禁止用启动前备份覆盖。
31. 写许可缺失、commit 不匹配、普通/符号/多链接或权限异常时全部业务写失败关闭，公开 GET、health 和 access verify 可用；正常 bootstrap/promote/rollback 完成后许可精确匹配 current，服务重启继续允许写。
32. gate 拒绝旧 txid/旧 generation/第二次消费、错误 owner PID starttime/boot id、错误锁 inode/phase/current/commit 和非 root/错误权限/链接许可；运行 selector 只能由 gate 在锁内原子更新，controller 在 gate 返回到 Node exec 间切 current 也不能改变本次实际启动 release。
33. prepared journal 在 watchdog 前已成功持久化；分别在 watchdog READY前、许可写前、消费前、消费后、Node exec 前后和 health 中杀 controller，最终都自动停止 target、恢复 origin 并清理许可。正常流程 watchdog 无副作用退出；watchdog启动失败则在任何active/revoke前安全清prepared journal并退出 2，清理失败返回4。
34. controller 持锁时启动一个会存活的 systemctl 等子进程并杀 controller，子进程不得继续持有锁；watchdog能立即获得锁并恢复。backup gate 与最小权限 runner 分离，恢复权限不会进入候选 backup CLI 的 unit namespace。
35. 用 DELETE journal、FULL 同步和 cache spill 建立真实 hot `fireside.db-journal` 后移走旧 main；bootstrap 必须退出 2，journal 类型/字节/hash 不变且不创建 current/DB/备份。另让 target 启动生成 journal 后在健康门禁失败，恢复结果严格等于初始 absent 或原备份，目录无 main/wal/shm/journal 残留。
36. watchdog dispatcher exec 后立即退出、参数/锁 inode 错误、不发 READY、READY 超时、READY 后被 kill 等场景均不得形成无恢复者的 current 切换；只有 PID 1 收到对应 txid worker 的 READY 且 unit active 才继续。正常结束不重启，异常退出自动重启并恢复同 txid journal。
37. 写许可 temp fsync、rename 前、rename 后目录 fsync 分别故障：rename 前业务写保持503；许可一旦可见后的任意2xx在命令失败/SIGKILL/recovery后仍存在。origin revoke 的 unlink 后 fsync 失败不得留下无journal的永久503。
38. 删除整个 `/run/fireside-runtime` 模拟冷启动；分别让 service 与 persistent backup 先到达 gate，最终都须从受信 current 重建 selector/permit，MainPID/cwd/current/selector/permit一致且业务写成功。current 或 marker 为错误类型、悬空或摘要不匹配时，Node 与 backup runner 均不得执行。
39. target 已启动后杀死 controller，并强制 backup gate 先于 watchdog 取得锁；恢复后必须是 origin MainPID/cwd/current/selector/permit全一致，target runner 未执行、无备份/prune副作用。若 backup gate选择交给 watchdog，则本次任务明确失败且 journal 保留到 watchdog 完整恢复。
40. 从 `/proc/<pid>/environ` 和测试哨兵证明 service/backup gate、recovery、watchdog及其子进程均不含业务写口令或会话密钥；应用 Node 仍可完成合法认证。unit 不得因应用 `EnvironmentFile` 把密钥传给 root gate。
41. 分别在 bootstrap 临时数据库 copy、file sync、rename、最终 chown 后杀死 controller；recovery 后原业务指纹不变（原本无库则仍无库），状态目录无 `.bootstrap.*`，失败状态下 `fireside`/`nobody` 均不能读取任何孤儿副本。错误类型、链接或非 root pending 文件必须拒绝自动删除并保留人工证据。
42. 在 bootstrap 的 switched/healthy 阶段分别截断、翻转备份一字节，或改变其 mode/owner/link/type；recovery 必须返回4，主库 hash 不变、current 与 journal 证据保留，不能先删指针或覆盖数据库。只有 filename+size+SHA-256与严格元数据全部匹配的备份才能恢复并清 journal。
43. 在 service gate 已确认 transaction owner 活跃后阻塞它，杀 controller 并让 watchdog进入恢复，再释放 gate；最终必须是 origin MainPID/cwd/current/selector/permit一致、journal 不复活且 target 写/runner不持续运行。gate mutex 类型、owner、mode、link count任一错误均失败关闭。
44. switched orphan 分别由 watchdog、人工 recover、backup gate 先取得；三条恢复都必须在明显小于 gate mutex 120秒超时内释放 mutex供 service gate 消费恢复许可，再重新取得并完成 origin health，不能死锁。backup 只能在完整恢复后执行 origin runner。
45. 让 controller 的 sync 等子进程在父进程被杀后持续存活，逐一检查其 `/proc/<pid>/fd` 不含主锁/gate锁；watchdog立即取得同一inode恢复。backup CLI尝试unlink/replace lock、selector与permit均EPERM，且并发controller直到runner共享锁释放后才能进入。
46. 分别把 transaction、release-active、writes-enabled、healthy marker预置为目录或链接；原子发布必须失败且不把temp移入目标、不清journal、不输出成功，原异常类型保留。恢复证据缺失时Node/backup继续失败关闭而不是误报健康。
47. 两个同 SHA install 在第一次“目标 absent”后用 barrier交错；最终仅一个成功，另一个拒绝或锁冲突，既有 release 的字节、manifest和子项集合完全不变，无嵌套publish目录，失败者不得输出installed成功。
48. 让`rollback --previous`在旧previous可见时与一个完成更新previous的promote交错；回滚取得锁后必须采用当时的新previous或明确拒绝，不能成功落到锁外解析的旧commit。
49. 在switched阶段阻塞独立worker，仅SIGKILL flock监督PID；watchdog取得锁后必须先杀死并reap该worker完整进程组再恢复。即使随后释放旧阻塞点，也不得复活journal或target，最终origin运行态一致。
50. 把 releases root或其父目录改为0700/错误owner/链接，service与backup gate必须在写selector/permit前失败；恢复为root:root0755后冷启动重建成功且应用UID可读取完整入口路径。
51. 构造 switched orphan：worker leader 收到 TERM 退出，同 PGID/session 子进程忽略 TERM 并准备迟到改写哨兵/journal。恢复必须在改指针前 KILL 且证明整组为空；子进程不存在、哨兵永不出现、journal不复活，最终 current/previous/selector/permit/MainPID 全为 origin。
52. 预置 switched orphan transaction/active 后启动带阻塞 build hook 的 install；install 获锁后必须在 hook、Git 授权和 stage/release 创建前立即失败，不改任何证据。随后recover/watchdog能立即取锁并恢复origin。
53. target MainPID 在线且 switched orphan 时直接启动 `fireside-runtime-gate.service`；最终只允许两种结果：origin MainPID/cwd/current/selector/permit 一致且journal已清，或gate失败且journal保留。不得出现旧target PID存活但journal消失。正常 app restart 的旧MainPID=0路径仍须无死锁通过。
54. 构造合法 committed journal/current/previous/healthy，再把 release-active 换成目录、链接、错误元数据或错误txid。recover/gate 必须返回4且journal与异常active均原样保留；修正active后重试才能清理两者、重建运行态并恢复写入。
55. 在无 `/var/lib/fireside-release` 的干净主机根按 README 逐条执行；准备阶段必须先创建 root:root0700 状态目录，recovery 首次 start 返回0并 active(exited)，随后 install/bootstrap/80 健康。删除该目录后，前置验收必须明确失败，不得对缺失 namespace 路径宣称可部署。
56. 在与backup gate/watchdog unit完全相同的 bounding set 下恢复 origin；新版本健康响应commit精确匹配时成功，commit错误、缺失（非显式legacy）或稳定窗PID变化均拒绝。gate进程实测无法读 `/proc/<MainPID>/environ`，legacy helper仅输出cwd；最终MainPID/健康commit/current/selector/permit一致。
57. 在 prepared journal 落盘后、watchdog READY 前仅 SIGKILL `flock --close` 监督PID，并强watchdog/gate先于旧worker继续；恢复者必须根据journal owner清空旧进程组，旧worker不得再写journal/切current，并发布命令不得入锁。watchdog启动故障下 current/previous/DB/permit/active均不变，prepared journal要么安全清理要么保留并返回4。
58. 在敏感preflight stage已chown后 SIGKILL controller，等待或保留旧transient，再用与生产`npm ci`完全相同的UID/网络/sandbox哨兵扫描独特业务值；必须EACCES且无出网。下一个main-lock入口必须先同步停止旧unit、再清理只位于root-only固定父目录的孤儿stage；清理期间不存在活跃写者，异常类型/名称/所有者保留证据并失败关闭。
59. 构造 switched v2 journal和独立session worker，让leader活着时派生忽略TERM、准备迟到写journal/current的同组子进程，然后在watchdog取锁前直接SIGKILL leader。恢复在原PGID/session为空前不得触指针；释放旧阻塞点后哨兵/journal/current均不复活，最终origin运行态一致。

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

首次生产提升还存在备份自举缺口：线上历史 current 的 backup CLI 本身没有本轮新增的崩溃安全顺序，若仍用 origin runner，第一份发布备份不满足 FR-OPS-008。正常 promote 必须使用已校验 target 的安全 runner；rollback 使用调用前 current runner，并在 transient sandbox 隐藏生产密钥。

维护锁审计确认首次 root 控制器可在 umask 022 下创建 0644 lock；Linux flock 允许普通用户对只读 fd 取得排他锁，因此可永久阻断发布和备份。生产控制器必须统一创建/修权/验证固定锁，recovery 先行后 backup 复用该受保护 inode。

Git 配置复审又确定性证明 repository-local `url.*.insteadOf` 能把固定 GitHub URL 改到攻击者 bare remote，`core.attributesFile`/info attributes 还能让 archive 丢文件。授权与产物不能再复用开发仓库配置：固定远端 fetch、commit/tree/archive 必须全部在 root-owned 临时 bare 仓库完成。

数据门禁复审构造出同 revision 内容破坏反例：现有计数、revision 与敏感字段 presence 都无法区分标题/摘要被改写，或一个非空会议链接被换成另一个。新增 hash 必须只覆盖既有业务值而排除 schema，从而同时拒绝静默数据变化并允许 expand-only schema 迁移。

首次部署旅程复审确认 README 的命令顺序在干净主机上确定失败：文档先执行 `promote`，控制器却要求解析并验证已有健康 `current`，systemd 单元又在其后才安装；首次目录也漏建 recovery 所需的 `/var/lib/fireside-release`。新增显式 bootstrap 状态机和从零验收，普通 promote 不再承担含糊的首次安装语义；该 P1 再次把成熟度连续计数归零。

同一 boot 恢复复审确认 `RemainAfterExit=yes` 会让 recovery 首次成功后一直保持 active，后续 `Requires+After` 不再执行其 `ExecStart`。控制器若在 switched 等 journal 阶段被 SIGKILL，服务自动重启、显式 restart 或备份 timer 会直接采用未验收 target。新增每次 service/backup 启动的 transaction gate；同时保留正常 promote 持锁同步 restart 的无死锁路径。该 P1 使连续计数继续为 0。

bootstrap 数据复审发现 live health 窗口已经由 socket 向公网开放业务写，而后续 healthy/marker/sync/clear 任一步失败仍会用启动前备份覆盖主库，形成“用户收到 2xx 后数据消失”。采用按 release commit 绑定的 root-owned 写许可：可回退阶段业务写统一 503；许可发布是不可逆提交点，之后 recovery 只能向前完成，不能恢复旧数据库。该数据丢失 P1 再次把成熟度计数归零。

启动门禁设计复审确认纯 ExecStartPre 仍有 current TOCTOU、许可消费后 owner 死亡窗口与重复 flock 死锁；发布锁还可能被 systemctl 子进程继承，backup 若共用恢复 sandbox 会扩大 root 候选 runner 权限。采用 txid/单次许可、不可变 runtime selector、独立 watchdog、子进程关闭锁 fd和 gate/runner 分离；这些相邻 P1 继续保持成熟度计数为 0。

SQLite 恢复复审还构造出真实 hot rollback journal：无 main 时若遗漏 `fireside.db-journal`，安装的新库会在首次打开时被旧 journal 回放成损坏页，失败恢复又留下 journal 导致永久重试循环。边车边界扩展到 wal/shm/journal，并要求拒绝孤儿、停止 workload 后清理与目录 fsync。该 P1 继续保持成熟度计数为 0。

watchdog 就绪复审确认异步 `systemd-run` 只证明 dispatcher 被 exec，不能证明守护者仍活着并在等待锁；若随后 controller 死亡，原 P1 仍存在。增加 Type=notify 的 txid 就绪握手、active 复查、异常自动重启和最小 capability 沙箱。该 P1 继续保持成熟度计数为 0。

易失运行态与 gate 竞态复审确认两条 P1：无 journal 冷启动会丢失 selector/permit；target 已启动后的 orphan 若由 backup gate 用 no-restart 语义恢复，会留下 MainPID 与 current/permit 裂脑。无事务 gate 改为从健康 current 重建运行态；backup orphan 必须完整 restart+health 或失败交给 watchdog。写许可 revoke 还必须后移到 journal/active marker 持久化之后，消除无日志永久 503。成熟度连续计数保持 0。

bootstrap 敏感副本复审发现原子 rename 前已把完整迁移库 chown 给应用 UID，SIGKILL 会遗留不受备份策略管理的 `.bootstrap.<pid>`。临时库改为 root-only 固定 pending 名并纳入严格恢复清理，最终 rename 后才降权；该高价值 P2 继续使成熟度计数为 0。

bootstrap 恢复完整性复审确认事务只记录备份文件名时，截断或位腐坏的备份会覆盖最后一份有效迁移主库并在清 journal 后误报恢复成功。事务必须绑定备份大小/hash，恢复在任何主库或指针变更前校验内容与严格元数据，复制后再次校验再 rename；该数据毁损 P1 使成熟度计数保持 0。

service gate 许可消费复审确认 owner 瞬时校验与 journal/selector 写入之间可被 controller SIGKILL 切开；watchdog恢复清理后，旧 gate 能再次复活 target 事务。新增独立 root-only gate mutex：gate消费全程持有，watchdog取得主锁后再持有才恢复，controller从不持有；该一致性 P1 使成熟度计数保持 0。

gate mutex 实现复审确认恢复者若持 mutex 同步 `systemctl restart`，本次 service gate 会等待同一锁并与父恢复者必然自锁。恢复者必须在持主锁写好绑定许可后释放 mutex，restart 返回后重新取得并复核同一事务消费与运行态；watchdog/人工/backup 三条路径都要真实验收。该 P1 使成熟度计数保持 0。

锁 fd 复审确认仅在 systemctl 等少数调用点关闭 fd 不足：持久化 sync 子进程可在 controller 死亡后继续占主锁，永久阻止 watchdog。主锁改由 `flock --close` 监督者持有，controller 全后代从未获得 fd；gate 锁路径同样必须证明无继承。该恢复可用性 P1 使成熟度计数保持 0。

backup runner 权限复审确认 UID0 加 `ReadWritePaths=/run` 可替换维护锁或运行许可，绕过互斥与写屏障。root gate 负责锁准备，runner 只读 open + shared flock 并把 `/run` 设为只读；候选 CLI 破坏尝试必须 EPERM。该高价值 P2 使成熟度计数保持 0。

固定文件原子替换复审确认 `mv -f temp fixedPath` 遇到目录会把 temp 移入并返回成功，可能清 journal却让写许可永久失效。transaction、healthy、active和permit统一先拒绝异常类型并使用`mv -Tf`；四类目标目录/链接回归必须保留证据且无假成功。该高价值P2使成熟度计数保持0。

候选安装并发复审确认 release目标 absent检查在取锁前、最终`mv`又会把stage移入已有目录；同SHA双install可污染immutable tree并误报成功。目标检查移入锁内并在发布前复核，最终使用`mv -T`/no-replace语义；并发barrier证明既有release零变化。该P1使成熟度计数保持0。

`rollback --previous`复审确认wrapper在锁外解析previous会与并发promote交错并静默选择上上版。`--previous`意图必须原样进入主锁后再解析；并发测试只允许采用锁时刻值或明确拒绝。该合理P2使成熟度计数保持0。

`flock --close`监督者复审确认单独SIGKILL监督PID会提前释放锁而留下活跃mutating worker，watchdog可与旧worker并发并被复活journal。worker改为独立进程组；接管者发现锁空闲但owner仍活跃时必须验证并终止/reap整组后才恢复。该一致性P1使成熟度计数保持0。

runtime可读性复审确认只检查release子树会漏掉`/opt/fireside/releases`等父目录0700漂移，root gate成功但应用启动EACCES循环。固定绝对父链须逐级校验root所有、不可写和other+x；该高价值P2使成熟度计数保持0。
