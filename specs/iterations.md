# 迭代日志

## Iteration 001：核心平台（已验收）

- 规格：SPEC-001
- 实现：创建、认领、排期、归档、筛选搜索、统计看板、响应式炉火视觉。
- 验证：4 项 API 测试、类型检查、生产构建、桌面/移动截图、0 漏洞。
- 提交：`80df708`

## Iteration 002：站点身份（已验收）

- 规格：SPEC-001 FR-CORE-007（追补）
- 实现：SVG favicon 与 Web App manifest。
- 验证：静态资源 Content-Type、manifest 解析、GitHub CI。
- 提交：`c294e4b`

## Iteration 003：生产端口（已验收）

- 规格：SPEC-001 FR-CORE-008（追补）
- 决策：最终按用户要求运行在 `0.0.0.0:80`。
- 验证：443 释放、80 监听、健康检查、GitHub CI。
- 提交：`99cd4d7`

## Iteration 004：CRUD、排序与日历（已验收）

- 规格：SPEC-002
- 计划：完整 CRUD、手动/自动排序、月历、周历、本周导航语义修复。
- 验证：11 项单元/API 测试，桌面 5 项 E2E、移动 3 项 E2E，人工全页截图与 0 漏洞审计。
- 状态：Accepted，提交 `c3555c4`。

## Iteration 005：质量收敛循环（进行中）

- 规格：SPEC-003
- 第 1 轮：3 个独立 agent 已完成只读审查。
- 第 1 轮：日历语义、排序可访问性和生命周期并发竞态均已解决。
- 停止门槛：至少连续两轮独立审查无新增 P0/P1/合理高价值 P2，且端到端操作、页面承诺、规格覆盖和生产验证全部闭环；发现新候选或闭环缺口时连续计数归零。
- 下一步：部署 Iteration 004，启动第 2 轮。

## Iteration 006：PATCH 并发数据完整性（已验收）

- 规格：SPEC-003 BUG-CONC-003
- 第 2 轮选中项：PATCH 只更新请求提交列，防止覆盖并发排期/归档数据。
- 验证：可控双实例交错测试通过；全套 12 项测试和 8 项跨端 E2E 回归通过。
- 状态：Accepted，提交 `33baec0`。

## Iteration 007：排序版本 CAS 与单飞保存（已验收）

- 规格：SPEC-003 BUG-CONC-004
- 第 3 轮三方一致选中项：防止多客户端陈旧写和单页面请求乱序造成顺序分叉。
- 验证：双实例版本竞争、创建/删除版本失效、位置连续性和浏览器单飞锁定均通过。
- 状态：Accepted，提交 `9a7d72c`。

## Iteration 008：演示数据一次性初始化（已验收）

- 规格：SPEC-003 BUG-DATA-005
- 第 4 轮选中项：删除全部议题后重启不得复活演示数据。
- 验证：删除全部后关闭/重开仍为空；首次禁用 seed 的决定永久保留；全部回归通过。
- 状态：Accepted，提交 `4f6cdf1`。

## Iteration 009：排序读取快照端到端一致性（已验收）

- 规格：SPEC-003 BUG-CONC-006、BUG-UI-007。
- 第 5 轮选中项：服务端原子返回列表与版本，客户端只接纳最新且来源匹配的排序响应。
- 验证：双实例 WAL 确定性交错测试；浏览器延迟旧排序响应测试；16 项单元/API、12 项跨端 E2E、生产构建和 0 漏洞审计全部通过。
- 状态：Accepted；实现提交 `8596c06`。

## Iteration 010：重复位置旧库无损迁移（已验收）

- 规格：SPEC-003 BUG-MIG-008。
- 第 6 轮选中项：历史库存在重复非零 `position` 时，启动阶段稳定归一化后再建立唯一索引。
- 验证：重复位置与同名非唯一索引夹具、业务字段无损、幂等重启、唯一约束、18 项单元/API 和 12 项跨端 E2E 全部通过。
- 状态：Accepted；实现提交 `4c60f5a`。

## Iteration 011：发布意图与双向生命周期（已验收）

- 规格：SPEC-004 FR-FLOW-001～004。
- 实现范围：征集/自荐发布、退出认领、取消排期、撤销归档及冲突后的权威同步。
- 验证：19 项单元/API、14 项跨端 E2E、生产构建和 0 漏洞审计通过。
- 状态：Accepted；实现提交 `f2de328`。

## Iteration 012：参会与页面承诺闭环（已验收）

- 规格：SPEC-004 FR-JOIN-001～002、FR-AFF-001。
- 实现范围：独立会议链接、报名/取消报名、参与人数、五步与统计入口、月历溢出、标签限制和死链接清理。
- 验证：20 项单元/API、20 项跨端 E2E 通过（另 2 项按设备设计跳过），生产构建和 0 漏洞审计通过。
- 状态：Accepted；实现提交 `6ad13fe`。

## Iteration 013：一键宣讲海报与弹窗可访问性（已验收）

- 规格：SPEC-004 FR-POSTER-001、交互和失败恢复。
- 实现范围：已排期议题本地生成 1080×1440 PNG、隐私脱敏、长文换行、预览下载/移动分享，以及全站弹窗的 Esc、焦点圈与触发点焦点恢复。
- 验收：纯函数覆盖未来资格、北京时间、文件名、所有可绘制字段的线上凭证脱敏、混合活动地点和极端长文本；桌面/移动 E2E 覆盖入口资格、PNG 图片预览尺寸、下载/分享回退、失败重试与焦点恢复；全量回归和漏洞审计。
- 验证：26 项单元/API/海报模型测试、22 项跨端 E2E 通过（另 2 项按设备设计跳过），手机海报重复 3 次稳定通过；生产构建、人工桌面/移动视觉检查和 0 漏洞审计通过。
- 状态：Accepted；实现提交 `c701824`。

## Iteration 014：公网协作边界与敏感参会信息（已验收）

- 规格：SPEC-004 FR-ACCESS-001、FR-JOIN-001～002 的隐私修订。
- 实现范围：共享围炉口令、公开只读、全写请求鉴权、会议入口/参与名单按需授权、匿名响应脱敏、会话解锁弹窗、401 表单保留与排序回滚、报名冲突稳定错误码、生产密钥和日志脱敏。
- 验收：逐项覆盖全部写端点；匿名列表/HTML 不含会议 secret 与报名姓名；正确/错误/轮换口令、敏感 GET、排序、弹窗叠加和重新提交均有 API/E2E；生产缺密钥拒绝启动，部署后匿名读 200/写 401/授权写成功，日志与 Git 无口令。
- 验证：30 项单元/API、安全与并发测试、26 项跨端 E2E 通过（另 2 项按设备设计跳过），生产构建、密钥工作区泄露检查和 0 漏洞审计通过。
- 状态：Accepted；实现提交 `0a7c3b7`。

## Iteration 015：状态相关编辑 CAS（已验收）

- 规格：SPEC-003 BUG-CONC-009。
- 目标：状态相关 PATCH 在写入时匹配读取状态，阻止退出认领、取消排期和撤销归档后被陈旧表单恢复已清空字段；基础字段继续支持与生命周期转换合并。
- 验收：三组双实例确定性交错、并发删除 404、基础字段合并回归，以及桌面/移动陈旧编辑冲突后的权威同步。
- 验证：32 项单元/API/安全/并发测试、28 项跨端 E2E 通过（另 2 项按设备设计跳过），生产构建和 0 漏洞审计通过。
- 状态：Accepted；实现提交 `1620fdd`。

## Iteration 016：会议地点隐私边界（已验收）

- 规格：SPEC-004 FR-JOIN-003、SPEC-003 第 8 轮。
- 目标：阻止新地点误填会议链接/凭证；匿名脱敏历史混合地点，并把其中可点击 URL 仅经受保护入口提供。
- 验收：新写入敏感输入/false-positive 矩阵、历史库混合 URL/纯凭证兼容、全部 Topic 响应脱敏，以及桌面/移动纠错与授权加入链路。
- 验证：37 项单元/API/安全/并发测试、28 项跨端 E2E 通过（另 2 项按设备设计跳过），生产构建和 0 漏洞审计通过。
- 状态：Accepted；实现提交 `b80cab1`。

## Iteration 017：议题聚合版本与陈旧操作保护（已验收）

- 规格：SPEC-005、SPEC-003 第 9 轮。
- 目标：Topic revision + If-Match 覆盖内容、生命周期和删除；报名变化推进父版本，排序版本独立；编辑草稿可显式恢复，陈旧删除必须重新确认。
- 验收：迁移、错误优先级、完整 mutation 递增矩阵、双实例编辑/删除/取消排期竞态，以及桌面/移动草稿保留与拒删恢复。
- 跨端场景：桌面 Chrome 与 Pixel 7 均须验证陈旧编辑保留本地草稿、用户显式基于最新版重交 dirty 字段、关闭后放弃草稿且即时同步远端卡片，以及删除确认期间新增报名后拒绝陈旧删除并保留报名。
- E2E 验证：显式重试、关闭放弃草稿和陈旧删除三条并发恢复场景在桌面/Pixel 7 分项 6/6 通过；完整套件 34 项通过，另 2 项按设备设计跳过。
- 验证：40 项单元/API/安全/并发测试、TypeScript、生产构建、差异检查与 0 漏洞审计全部通过。
- 状态：Accepted；实现提交 `fdb6085`。

## Iteration 018：宣讲海报隐私、极限布局与最新快照（已验收）

- 规格：SPEC-006、SPEC-003 第 10 轮。
- 目标：统一识别中文/英文、Unicode 与分段会议凭证；保证全部可绘制字段和文件名不泄漏；让最大合法内容在 1080×1440 画布内完整分区；生成前读取最新 Topic。
- 隐私范围：`title`、`summary`、`presenter`、五个 `tags`、原始历史 `room` 和文件名；独立 `meetingUrl` 继续不得进入模型。覆盖会议号/会议码、入会码/密码、密码/口令、Meeting ID/Code、passcode/password/pwd/pin、平台分段编号及 URL，并保留 SPEC-006 的 false-positive 矩阵。
- 布局范围：80 字标题、三行简介、30 字分享人、五个各 20 字标签、信息卡和页脚均在安全区内且互不重叠；五个标签全部出现，文本在自身胶囊内省略，不得静默丢弃。
- 新鲜度范围：点击“生成海报”后先 `GET /api/topics/:id`；改期使用新快照，取消排期/归档/删除拒绝生成旧海报，读取失败可显式重新获取并同步列表。
- 跨端验收：桌面 Chrome 与 Pixel 7 均验证本地 Blob 预览、Canvas 绘制文本脱敏、1080×1440 PNG IHDR、无秘密文件名、下载/分享回退、失败重试、Blob 释放、焦点恢复、44px 操作目标和无横向滚动。
- 发布审计补充：Pixel 7 海报弹窗右上角关闭按钮也属于操作目标，宽高均须至少 44px，且不得遮挡标题；关闭后仍须把焦点归还对应列表/周历入口。审计发现旧值为 35×35px，成熟度连续计数因此保持为 0。
- 回归要求：历史敏感 `room`/`meetingUrl` 隔离、FR-POSTER-001 既有资格/北京时间/下载流程、全部单元/API/E2E、TypeScript、生产构建和漏洞审计继续通过。
- 验证：50 项单元/API/安全/并发/海报测试，40 项桌面与 Pixel 7 E2E 通过（另 2 项按设备设计跳过）；TypeScript、生产构建、差异检查、独立发布审计和依赖漏洞审计（0 项）全部通过。
- 部署：systemd 已重启并保持 `0.0.0.0:80`；本机与局域网健康检查均为 200，生产 API 拒绝括号式会议凭证并清理临时数据，公开响应与日志均未出现验证 secret。对本机公网地址 `166.108.239.81:80` 的回环验证仍超时（HTTP 000），继续受 SPEC-001 §9 所述云安全组/公网回环边界约束，不能据此宣称外网已可达。
- 状态：Accepted；括号凭证、成对括号 URL、中等长度标题布局与 44×44px 关闭触控目标均在发布审计发现后完成修复并重跑全套验收；实现提交 `f4f5f7d`。

## Iteration 019：活动阶段与权威动作准入（已验收）

- 规格：SPEC-007、SPEC-003 第 11 轮。
- 目标：从排期与时长派生 UPCOMING / LIVE / ENDED，不新增持久状态；统一报名、会议入口、海报、改期、取消排期与归档的前后端准入。
- 安全边界：结束或归档后不得返回真实会议 URL，不得新增或取消历史报名；拒绝路径不推进 revision、不改变名单。
- 用户逻辑：未来可宣传/报名/改期，进行中可迟到报名和入会，结束后只读名单并归档；未举行活动通过明确动作清空旧参与信息后回到准备中。
- 验收：注入时钟覆盖 start/end 毫秒边界、错误优先级与数据不变式；桌面 Chrome 与 Pixel 7 覆盖四种阶段、无刷新开始切换和冲突同步；全量回归、生产构建与 80 端口生产验证。
- 实现：共享纯函数精确派生 UPCOMING / LIVE / ENDED；服务端注入权威时钟并封闭全部阶段动作；前端四阶段徽标、动作、编辑锁定、“未举行 / 重新排期”和最近边界定时刷新全部落地。
- 验证：54 项单元/API/安全/并发/海报测试全部通过；44 项桌面 Chrome 与 Pixel 7 E2E 在 `--retries=0` 下通过（另 2 项按设备设计跳过）；TypeScript、生产构建、差异检查、依赖漏洞审计（0 项）和两份独立发布审计全部通过。
- 发布审计：阶段范围无 P0/P1/高价值 P2；另确认周历报名、Pixel 7 普通弹窗/卡片/月历触控热区为后续 P2，叠层 AccessModal Esc 丢草稿仍为后续 P1，因此成熟度连续计数保持 0。
- 部署：systemd 已重启并保持 `0.0.0.0:80`；生产受控议题验证过去/当前排期 400、未来提前归档 409 UPCOMING、报名 201、会议入口 200、取消排期后名单归零且会议入口 409，公开响应和日志无验证 secret，临时数据已完全删除。首次清理请求因验证脚本误给空 DELETE 添加 JSON Content-Type 暴露错误处理 P2，改用正确请求后 204；业务阶段验证复跑全部通过。
- 状态：Accepted；实现提交 `49bf117`，生产验证通过。

## Iteration 020：叠层弹窗所有权与草稿保护（已验收）

- 规格：SPEC-008、SPEC-003 第 12 轮。
- 目标：统一 dialog 栈、键盘顶层所有权、底层 inert、共享 body 滚动锁与逐层焦点恢复。
- 核心场景：业务表单提交遇到 401 后，Esc / X / backdrop 只关闭 AccessModal；底层草稿原样保留，正确解锁不自动重放失败写请求，用户再次提交才写入。
- 验收：桌面 Chrome 与 Pixel 7 覆盖双层 Esc/X/backdrop/Tab、草稿/校验状态、body overflow、逐层焦点与正确/错误口令；全部单层弹窗、API/E2E和生产构建回归。
- 实现：唯一 token 的共享弹窗栈集中处理注册、顶层判断和滚动锁；五类弹窗只允许栈顶处理 Esc/Tab/初始焦点和 backdrop，底层统一 inert；逐层恢复焦点并保护 StrictMode 重放。
- 验证：60 项单元/API/安全/并发/海报/弹窗栈测试全部通过；50 项桌面 Chrome 与 Pixel 7 E2E 在 `--retries=0` 下通过（另 2 项按设备设计跳过）；TypeScript、生产构建、差异检查和依赖漏洞审计（0 项）全部通过。
- 部署：systemd 已重启并监听 `0.0.0.0:80`，健康页与首页 200；生产浏览器以无效 session key 触发真实 401，验证叠层 2→1→0、草稿和逐层焦点、inert 与原始 overflow 恢复，未写入生产数据。公网 IP 回环仍超时，外部安全组边界未改变。
- 状态：Accepted；实现提交 `d0d41b1`。本轮修复 P1，但仍有周历报名入口、移动触控热区与请求解析错误语义候选，成熟度连续无发现计数保持 0。

## Iteration 021：认证抗猜测、短期协作会话与生产密钥强度（已验收）

- 规格：SPEC-009、SPEC-003 第 13 轮。
- 目标：原始口令只进入唯一限流的 `/api/access/verify`；成功后换取 8 小时高熵签名协作令牌，全部业务写、参与名单与会议入口不再接受或存储原始口令。
- 会话协议：`X-Fireside-Session` + 当前 tab `sessionStorage`，不使用 cookie/URL/localStorage；`GET /api/access/session` 校验但不续期，口令轮换使旧 token 全部失效，退出清理 token 与已展示敏感数据。
- 限流语义：以直连 TCP `request.ip` 为可信来源，不信任客户端转发头；`verify` 使用单来源 60 秒 10 次、全局 60 秒 200 次失败窗口，阻断期不比较候选，正确口令也稳定 `429`。无 token 的业务请求只返回 `401` 且不计入口令桶。
- 安全响应：错误口令为 `401 ACCESS_REQUIRED`，阻断为 `429 ACCESS_RATE_LIMITED` + 整数 `Retry-After`，无效会话为 `401 ACCESS_SESSION_REQUIRED`；响应、状态和日志不得泄露口令/令牌或业务敏感数据。
- 资源边界：来源 Map 上限 10,000、每来源最多 10 个时间戳、全局最多 200 个时间戳；每 256 次失败最多续扫 256 个来源，确定性 LRU 淘汰，无常驻定时器；会话采用 HKDF + HMAC-SHA-256 无状态签名，不建立 token Map。
- 生产边界：生产口令必须无首尾空白、长度 32..256、非占位/单字重复；不满足时在监听端口和打开数据库前失败，部署前先做不输出值的强度预检和必要轮换。
- 错误优先级：业务入口在 body 解析前只验会话，失败不能被 malformed body、If-Match、404、revision 或阶段信息覆盖；有效会话继续既有业务顺序。`verify` 先查桶，阻断时不比较口令。
- 迁移：新前端删除旧 `fireside-write-key` 且不自动交换；旧客户端向业务路由发送正确原始口令仍为 `401 ACCESS_SESSION_REQUIRED`，必须重新显式解锁，不留猜测兼容旁路。
- 验收：令牌签名/过期/篡改/轮换、窗口/并发/清理/内存与强密钥纯逻辑测试；全部保护入口和拒绝数据不变式 API 测试；桌面 Chrome/Pixel 7 的恢复/退出、叠层草稿、阻断期、不重放与共享 NAT 隔离；生产受控 401→429、伪造转发头、弱密钥失败关闭、缓存/日志脱敏和全量回归。
- 非目标：多实例共享限流、单 token 服务端撤销、代理信任、账号/cookie/CAPTCHA/永久封禁、纯 HTTP、systemd root/DB 文件权限、Fastify 解析错误映射、周历报名和移动触控热区。
- 状态：Accepted；规格提交 `45cda52`、发布审查增补 `b248e8e`、实现提交 `9b68fd6`。79 项单元/API、56 项双端 E2E 通过（另 2 项按设备设计跳过），生产受控 `401 → 429`、已有会话隔离、编码/HEAD 守卫、快照不变与日志脱敏均通过。
- 发布前审查补充：曾确定性发现原始 URL 正则可被百分号编码的敏感 GET 绕过、HEAD 未守卫，以及退出后迟到会议响应可重新暴露链接；另确认启动时不能仅凭 storage 乐观解锁。上述发现已并入 SPEC-009 并由实现与回归关闭；由于下一轮仍有已知 P1/P2，连续成熟度计数保持 0。

## Iteration 022：生产最小权限、私有状态与可恢复发布（Ready）

- 规格：SPEC-010、SPEC-003 第 14 轮。
- 选中原因：生产 Node/tsx/esbuild 当前均为 UID 0 且拥有近完整 capability，`systemd-analyze security` 为 9.6 UNSAFE；DB/WAL/SHM 为 0644，普通本地用户可读取报名姓名和真实会议入口；无一致备份或回滚链路，均为独立 P1。
- 目标：systemd socket 持有 80，应用以固定 `fireside` 用户、零 capability 直跑预编译 Node；发布、状态、密钥、备份分离；SQLite 在线一致备份、保留和隔离恢复可验证。
- 非目标：容器、多实例、外部负载均衡、远端对象存储、TLS/443 与云安全组。
- 后续候选：请求解析 4xx→500、周历报名闭环、月历动作面板和 Pixel 7 的 44px 触控目标均为高价值 P2；本轮 P1 完成后继续，成熟度连续无发现计数为 0。
- 状态：Ready；生产迁移、回滚副本、权限矩阵、socket 重启连续性与备份恢复未完成前禁止验收。
- 首次沙箱启动发现：Fastify 监听日志通过 `os.networkInterfaces()` 读取接口，需要 `AF_NETLINK`；原三地址族白名单导致 `uv_interface_addresses` errno 97 并退出。PID 1 socket 始终持有 80、数据未损坏；SPEC-010 已先记录最小放宽，修正后必须重跑真实权限矩阵。
- 首次真实备份检查发现：`better-sqlite3` 在线 backup 本身成功且内容指纹一致，但对 WAL 模式临时副本做只读完整性检查会留下 `.tmp-wal/.tmp-shm`；直接在备份目录读取旧快照也会创建最终同名边车。该残留不对普通用户可读，但会逐日累积且破坏单文件备份契约；SPEC-010 已先补充 DELETE journal 与边车清理验收，修复前禁止验收。

## Iteration 023：发布产物身份、候选门禁与崩溃安全备份（Implementing）

- 规格：SPEC-010 FR-OPS-006、FR-OPS-010、FR-OPS-008，SPEC-003 第 15 轮。
- 独立审计发现：`server-build/` 被 Git 忽略，旧安装脚本仅核对 HEAD/dirty/文件存在后直接复制，因此旧或篡改产物可冒充新 commit；脚本还以 root 执行依赖 lifecycle。优先级 P1。
- 独立审计发现：旧安装脚本在候选语法、依赖、隔离迁移和健康检查前切换 `current`，没有 previous 指针、显式回滚工具或启动失败自动回退；已存在权限不正确的历史 release 证明“目录存在”不能充当健康标记。优先级 P1。
- 备份审计发现：临时文件到最终文件的 rename、目录项和 prune 没有 fsync 持久化顺序；SIGKILL/断电可能留下随机孤儿且后续任务不回收。优先级高价值 P2，与同一生产可恢复性边界一并修复。
- 方案：从完整 commit 导出源码，以隔离的 `fireside-build` 用户安装、测试、构建和预检；root 生成 commit + SHA-256 manifest、固化只读 release。候选在最新一致备份副本上通过应用预检后才可原子提升；提升失败自动恢复原版本，维护已确认健康的 `previous`，并提供同门禁显式回滚。
- 发布设计复核补充：生产只执行预装的 root-owned 控制器，commit 必须属于授权 `origin/main`；测试/构建/含真实副本预检在无外网独立 cgroup，候选迁移后的副本还须由旧 current 读取。双指针切换使用 fsync 的 root-only 事务日志，下一次命令和开机 unit 都能把 SIGKILL/断电中的未完成操作恢复到调用前版本。
- 备份顺序：临时主文件 sync → rename → 目录 sync → prune → 目录 sync；发布服务互斥，下一轮只回收严格匹配、root 所有、非链接且超过安全年龄的孤儿。
- 验收：发布/回滚故障注入、manifest 篡改/陈旧/链接拒绝、root lifecycle 禁止、备份逐阶段故障与孤儿恢复；全量 check、无重试桌面/Pixel E2E、依赖审计、生产备份/恢复、真实自动回退、权限矩阵和 80 端口连续性。
- 状态：Implementing。任一验收未完成不得接受 SPEC-010；成熟度连续无发现计数为 0。
- 紧随项：页面承诺的周/月历参与闭环和 Pixel 当前日期定位；请求解析稳定 400/413/415。两者均已由独立证据确认，Iteration 023 完成后继续，不能停止循环。
- 实现中独立审计阻断 A：生产 `systemd-run` 预检曾把 stdout 重定向到 `/dev/null`，而调用方用 command substitution 取得三次业务指纹，导致生产变量均为空且错误地“比较相等”；测试 hook 有输出所以未复现。修复必须让生产分支取得并解析非空 JSON 指纹，空/畸形输出直接拒绝，并以候选篡改指纹夹具证明不能切换。
- 实现中独立审计阻断 B：recovery oneshot 曾由 app service 以 `Wants+After` 拉起且没有 `RemainAfterExit`；正常 promote 写 journal 后重启 app 会再次启动 recovery、撤销刚完成的切换，而 recovery 失败又不能阻止 app。修复必须使用失败可阻断的依赖与“本次开机只执行一次并保持 active-exited”的语义，真实 systemd restart 不得重跑 recovery；新 boot / 手动 recover 仍须恢复未完成 journal。
- 修复复审阻断 C：开机 recovery 最初仍对共同维护锁使用非阻塞 `flock`；Persistent backup timer 若先取得共享锁，recovery 会立即 75，app 因 Requires 也无法启动且不会靠 `Restart=on-failure` 自动重试。开机 recovery 必须在有界时间等待既有维护任务，且 backup unit 本身也必须 `Requires+After` 同一个 active-exited recovery，保证应用与补跑备份两条启动路径都先完成恢复。
- 修复复审阻断 D：预装生产控制器若仍信任 `FIRESIDE_RELEASE_TEST_MODE`、测试路径或 build/preflight/restart/health/sync hook，受限 sudo/SETENV 调用者就可能让 root 访问调用者路径或执行调用者程序。dispatcher 与所有可直接调用的子脚本必须在读取覆盖值前识别生产模式并以 2 拒绝；验收必须复制完整控制器、附加生产模式标记并用恶意 hook 哨兵做回归，不能只证明工作树入口被拒绝。
- 阻断 D 的解释器复审：`/usr/bin/env bash` 会先按调用者 PATH 选择解释器，Bash 还会在脚本正文前处理 `BASH_ENV`；子脚本原先又在固定 PATH 前调用 `readlink`。所有生产可执行脚本必须使用绝对的特权模式解释器、在首个外部命令前固定 PATH，并由直接 exec（不是 `bash file`）的夹具注入假 bash/readlink 与 startup 文件证明哨兵不执行。
- 修复复审阻断 E：root Git 仍会读取调用者 `HOME/.gitconfig`、`XDG_CONFIG_HOME/git/config` 和开发用户可写仓库 `.git/config`；`core.fsmonitor` 足以在 `git status` 前执行外部程序。所有 Git 命令必须使用空 global/system config、清除 HOME/XDG/Git 执行变量并显式禁用本地 fsmonitor/hooks；三种来源的恶意配置均须由哨兵回归覆盖。
- 阻断 E 的相邻环境面：无模板 `mktemp` 仍继承攻击者 `TMPDIR`；回环 curl 可被 `http_proxy`/`ALL_PROXY` 导向伪造健康代理；systemctl/systemd-run 可受 DBus/SYSTEMD 环境影响。统一净化必须覆盖这些变量，生产临时文件只落 root 私有目录，curl 显式禁代理，并以代理零请求和真实失败仍回退验收。
- 修复复审阻断 F：`systemctl is-active socket service` 的多单元退出码是“至少一个 active”，不能证明 socket 与 app 同时健康。生产门禁必须分别检查两个 unit；socket-only 和 service-only 两种组合都须拒绝，只有双 active 才进入 PID/cwd/UID/HTTP 稳定窗。
- 修复复审阻断 G：promote 未检查 preflight `mktemp/chmod/install/chown`；stage 为空会把生产备份目标拼成 `/fireside.db`。每步必须 guard，目标在复制前验证为固定 root 的非空子路径。恢复 previous=none 时删除失败也不能被后续 sync 掩盖，必须返回 4 并保留 transaction。
- 阻断 G 的同类状态掩蔽：healthy marker 直接在 `printf` 参数中计算 manifest digest，内部 hash 失败会被外层成功吞掉并写空 digest。实现必须先独立计算并验证 digest；失败触发自动恢复，不能留下未来不可回滚的“健康”版本。
- manifest 复算也不能用丢失 producer 状态的 process substitution：若尾部路径含换行/Tab 或 stat/hash 失败，`cmp` 可能只比较已输出的合法前缀并误判相等。必须让生成器和比较器状态共同受 `pipefail` 门禁，并加入非法尾部路径回归。
- 发布流程补强：按 SSH URL push 不更新 `refs/remotes/origin/main`，README 必须显式 fetch 后再验证；生产 controller 不能信任开发用户可改写的本地 tracking ref，须从固定 HTTPS GitHub 权威 main 核对精确 commit。
- 本地主动审计阻断 H：GitHub 精确 SHA 授权后，本地 `refs/replace/<commit>` 仍可让默认 rev/tree/archive 采用攻击者替换对象。所有 release Git 命令必须禁用 replacement refs，并用恶意替换 commit 证明候选仍来自原始树。
- 修复复审阻断 I：三次数据库 preflight 成功后，删除已 chown 给 build 用户的敏感副本 stage 若失败，旧脚本仍取消 trap 并切换版本。只有显式清理成功且路径消失才可写 transaction；清理故障必须返回 2、保持双指针/journal 不变并保留可见错误。
- 修复复审阻断 J：当前生产 origin 的旧 backup CLI 没有 fsync/互斥/孤儿恢复，首次 promote 若用 origin 备份就无法自举安全链。正常提升改用已校验 target runner，rollback 使用调用前 current runner；夹具记录实际 runner，沙箱同时隐藏 `/etc/fireside.env`。
- 修复复审阻断 K：固定维护锁若由 root umask022 首次创建成0644，普通用户可只读打开并取得排他 flock，阻断发布/备份。控制器统一把固定锁创建/修权/验证为 root:root 0600 普通单链接文件；nobody 无法打开，backup 仍复用同一 inode。
- 修复复审阻断 L：开发仓库 local `url.*.insteadOf` 可把权威 GitHub 查询劫持到假 remote，`core.attributesFile`/info attributes 可改变 archive。生产改为在 root-owned 空 bare repo 中从固定 HTTPS main fetch，并只从该 repo 授权/tree/archive；开发 repo 不再是信任根。
- 修复复审阻断 M：迁移门禁只有计数、revision 和字段 presence，无法发现同 revision 标题/摘要损坏或非空会议链接替换。新增排除 schema、固定序列化既有业务列的 `businessDataSha256`；内容改写拒绝，单纯 ADD COLUMN/default/index 通过。
- 端到端部署阻断 N：README 把新机流程写成 install→promote→安装 unit，但 promote 必须先有健康 current，干净主机确定性退出 2，且 recovery 的 `/var/lib/fireside-release` 未创建。新增显式 `bootstrap`：只接受无 current/previous/journal 的首次状态；空库失败恢复为无库，已有业务库先一致备份且任何失败/中断恢复原指纹；成功才留下首个 current、健康服务和空 previous。README 从零到 80 健康、重复拒绝与 boot recovery 都要自动化和真实生产验证。
- 同一 boot 恢复阻断 O：`RemainAfterExit=yes` 使 recovery 第一次完成后不再被 service/backup 的 Requires 重跑；控制器在 switched 等阶段被 SIGKILL 后，自动/人工 restart 会直接启动未验收 target，timer 还会从 target 执行 root backup runner。service 与 backup 每次启动前必须有不依赖 active-exited 状态的 root transaction gate；orphan journal 在 Node/backup 前恢复，正常 promote 持锁同步 restart 不能死锁，未验收 target runner 不能参与备份。
