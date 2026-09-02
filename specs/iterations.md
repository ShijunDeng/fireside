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

## Iteration 022：生产最小权限、私有状态与可恢复发布（Accepted）

- 规格：SPEC-010、SPEC-003 第 14 轮。
- 选中原因：生产 Node/tsx/esbuild 当前均为 UID 0 且拥有近完整 capability，`systemd-analyze security` 为 9.6 UNSAFE；DB/WAL/SHM 为 0644，普通本地用户可读取报名姓名和真实会议入口；无一致备份或回滚链路，均为独立 P1。
- 目标：systemd socket 持有 80，应用以固定 `fireside` 用户、零 capability 直跑预编译 Node；发布、状态、密钥、备份分离；SQLite 在线一致备份、保留和隔离恢复可验证。
- 非目标：容器、多实例、外部负载均衡、远端对象存储、TLS/443 与云安全组。
- 后续候选：请求解析 4xx→500、周历报名闭环、月历动作面板和 Pixel 7 的 44px 触控目标均为高价值 P2；本轮 P1 完成后继续，成熟度连续无发现计数为 0。
- 状态：Accepted；生产迁移、回滚副本、权限矩阵、socket 重启连续性与备份恢复均已由后续发布门禁、故障注入与真实生产提升验收关闭。
- 首次沙箱启动发现：Fastify 监听日志通过 `os.networkInterfaces()` 读取接口，需要 `AF_NETLINK`；原三地址族白名单导致 `uv_interface_addresses` errno 97 并退出。PID 1 socket 始终持有 80、数据未损坏；SPEC-010 已先记录最小放宽，修正后必须重跑真实权限矩阵。
- 首次真实备份检查发现：`better-sqlite3` 在线 backup 本身成功且内容指纹一致，但对 WAL 模式临时副本做只读完整性检查会留下 `.tmp-wal/.tmp-shm`；直接在备份目录读取旧快照也会创建最终同名边车。该残留不对普通用户可读，但会逐日累积且破坏单文件备份契约；SPEC-010 已先补充 DELETE journal 与边车清理验收，修复前禁止验收。

## Iteration 023：发布产物身份、候选门禁与崩溃安全备份（Accepted）

- 规格：SPEC-010 FR-OPS-006、FR-OPS-010、FR-OPS-008，SPEC-003 第 15 轮。
- 独立审计发现：`server-build/` 被 Git 忽略，旧安装脚本仅核对 HEAD/dirty/文件存在后直接复制，因此旧或篡改产物可冒充新 commit；脚本还以 root 执行依赖 lifecycle。优先级 P1。
- 独立审计发现：旧安装脚本在候选语法、依赖、隔离迁移和健康检查前切换 `current`，没有 previous 指针、显式回滚工具或启动失败自动回退；已存在权限不正确的历史 release 证明“目录存在”不能充当健康标记。优先级 P1。
- 备份审计发现：临时文件到最终文件的 rename、目录项和 prune 没有 fsync 持久化顺序；SIGKILL/断电可能留下随机孤儿且后续任务不回收。优先级高价值 P2，与同一生产可恢复性边界一并修复。
- 方案：从完整 commit 导出源码，以隔离的 `fireside-build` 用户安装、测试、构建和预检；root 生成 commit + SHA-256 manifest、固化只读 release。候选在最新一致备份副本上通过应用预检后才可原子提升；提升失败自动恢复原版本，维护已确认健康的 `previous`，并提供同门禁显式回滚。
- 发布设计复核补充：生产只执行预装的 root-owned 控制器，commit 必须属于授权 `origin/main`；测试/构建/含真实副本预检在无外网独立 cgroup，候选迁移后的副本还须由旧 current 读取。双指针切换使用 fsync 的 root-only 事务日志，下一次命令和开机 unit 都能把 SIGKILL/断电中的未完成操作恢复到调用前版本。
- 备份顺序：临时主文件 sync → rename → 目录 sync → prune → 目录 sync；发布服务互斥，下一轮只回收严格匹配、root 所有、非链接且超过安全年龄的孤儿。
- 验收：发布/回滚故障注入、manifest 篡改/陈旧/链接拒绝、root lifecycle 禁止、备份逐阶段故障与孤儿恢复；全量 check、无重试桌面/Pixel E2E、依赖审计、生产备份/恢复、真实自动回退、权限矩阵和 80 端口连续性。
- 状态：Accepted。manifest、不可变候选、真实副本预检、备份、事务恢复、回滚、冷启动门禁与生产提升均已通过自动化和生产验收；最终证据见 SPEC-003 第 49、50 轮。
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
- bootstrap 数据阻断 P：target live health 时 80 已可接受业务写，随后 marker/sync/clear 失败却会从启动前备份恢复，造成已返回 2xx 的数据永久丢失。所有发布在可回退窗口使用按 commit 绑定的 root-owned 写屏障，业务写返回 503且零副作用；写许可发布是不可逆提交点，此后的 recovery 只能向前完成，任何成功写都不得再被旧备份覆盖。
- 启动门禁设计阻断 Q：纯 ExecStartPre 存在 current TOCTOU、一次许可消费后 controller 死亡窗口和重复 flock 自锁；fd 9 还可能被 systemctl 子进程继承，backup 共用恢复 sandbox 会扩大候选 runner 权限。journal 加随机 txid/owner/锁 inode/单次 generation许可；gate 固化不可变 runtime selector，独立 watchdog 在 owner 死亡后接管；所有子进程关闭锁 fd；backup root gate 与最小权限 runner 拆分并在共享锁后复查无 journal。
- SQLite 边车阻断 R：bootstrap 仅识别 wal/shm，遗漏真实 hot `fireside.db-journal`；无 main 时安装新DB会被旧 rollback journal 回放并损坏，恢复后 journal 仍在导致永久循环。无 main+任一三类边车必须先拒绝并保留证据；停止 workload 后安装/恢复清理 wal/shm/journal 并按目录 fsync 顺序持久化。
- watchdog 就绪阻断 S：异步 systemd-run exec成功不证明watchdog仍活着并已等待锁，controller可在没有恢复者时切换。使用txid绑定的Type=notify握手；固定控制器/锁验证完成且即将等待才READY，controller有界等待并复查active，异常退出自动重启；watchdog capability收敛到恢复DB所需最小集合。
- 运行态重建阻断 T：selector 与 write permit 都位于易失 `/run`，无 journal 冷启动若直接放行会令 Node 无工作目录或全部写永久 503。service/backup gate 必须从通过 manifest 与 healthy marker 校验的 current 原子重建两者；错误类型、悬空或不健康 current 失败关闭。冷启动由 backup 先触发和 service 先触发都要验证读写闭环。
- gate 竞态阻断 U：target 已启动后 controller 死亡，backup gate 可能先于 watchdog 得锁；若套用 service 的 no-restart 恢复，会出现运行 target、指针/许可却为 origin 的裂脑。service gate 只在旧进程已停时 no-restart；backup gate 必须完整授权 restart+health 后才清 journal并运行 runner，或保留 journal并让本次备份失败等待 watchdog。确定性故障注入必须同时核对 MainPID/cwd/current/selector/permit与实际 runner。
- 写屏障时序阻断 V：先 revoke 再创建 journal 时，unlink 已可见而目录 fsync 失败会留下无 journal 永久 503。先持久化 journal/active marker再 revoke，失败统一恢复 origin；journal 后的陈旧 active marker由 gate/watchdog幂等清理。
- 密钥隔离阻断 W：把 root gate 直接写进含 `EnvironmentFile=/etc/fireside.env` 的 app unit，会让 controller 及其子进程继承业务写口令。service gate 改为无 EnvironmentFile 的独立 root unit，controller入口先清除应用密钥；`/proc` 与哨兵验证 gate/watchdog/recovery/backup 均不继承，只有非 root Node 持有所需密钥。
- 敏感 pending DB 阻断 X：bootstrap 原子替换前的完整数据库副本曾已 chown 给应用 UID，SIGKILL 会永久遗留 `.bootstrap.<pid>` 且 recovery 不清理。固定 root-only pending 名并纳入类型/所有者/链接数严格恢复清理；rename 后才降权最终主库，逐阶段崩溃注入证明无应用可读孤儿。
- bootstrap 恢复身份阻断 Y：journal 只记录备份名时，截断/位腐坏备份可覆盖最后一份有效主库并清 journal误报成功。事务绑定备份 size+SHA-256；恢复在触碰指针/主库前验证固定目录、root:root0600、单链接普通文件与内容身份，pending复制后再次校验，失败保留现有主库和全部证据。
- gate/watchdog 互斥阻断 Z：service gate 在 owner 校验后无锁写 journal/selector，controller SIGKILL 后可与 watchdog恢复并发并复活已清事务。增加独立 root-only gate mutex；许可消费全程持有，watchdog取得主锁后再持有才恢复，controller不持该锁且所有路径统一锁序。确定性阻塞注入验证 journal 不复活、最终运行态全为origin。
- mutex 恢复自锁阻断 AA：恢复者持 gate mutex 同步 restart 会等待同样需要该 mutex 的 service gate。恢复者持主锁写好 reverting/pending许可后临时释放 mutex，restart后重新取得并复核同一txid/generation/consumed及健康；watchdog、人工 recover、backup gate 的 switched orphan 均须无120秒超时并完整恢复origin。
- 锁fd继承阻断 AB：仅关闭systemctl/curl仍让sync/stat/hash等子进程继承主锁，controller死亡后watchdog可永久等待。主锁由`flock --close`监督者持有，controller及全部后代从未拥有fd；gate锁也须以存活子进程故障注入证明不会延长owner生命周期。
- backup运行态写权阻断 AC：UID0 runner曾可写整个`/run`并替换维护锁/selector/permit。root gate预建严格锁，runner只读open同inode取得共享flock，sandbox内`/run`只读；候选CLI破坏尝试EPERM且controller严格等待共享锁释放。
- 固定文件替换阻断 AD：`mv -f temp fixedPath` 遇目标目录会把temp移入并返回0，可能清journal后留下永久503。transaction/healthy/release-active/writes-enabled统一拒绝异常类型并使用`mv -Tf`；目录/链接夹具验证不误报、不清证据、不把temp移入。
- 同SHA安装竞态阻断 AE：release absent检查在取锁前且最终`mv`会嵌入已存在目录，两个install可污染immutable tree并误报。锁内检查并在发布前复核，最终`mv -T`或no-replace；并发barrier验证失败者不改变既有文件/manifest/子项集合。
- previous回滚意图阻断 AF：wrapper锁外解析`--previous`可与并发promote交错并静默回到上上版。原样传入主锁监督下的promote再解析；锁时值变化时只允许采用新previous或明确拒绝。
- supervisor死亡耦合阻断 AG：仅杀`flock --close`父会释放锁但留下旧mutating worker。worker置于独立session/process group；接管者若见journal owner仍活跃，验证固定身份后终止/reap整组再恢复，无法证明则返回4。故障注入不得复活journal/target。
- release父链可读阻断 AH：静态检查只覆盖commit子树会漏`/opt/fireside/releases`等父目录0700，root gate误放而应用EACCES循环。完整父链逐级验证真实目录、root owner、非可写、other+x，失败不发布selector/permit。
- 进程组清空阻断 AI：原实现 TERM 整组后只轮询 journal leader；leader先退出会误报恢复可安全继续，忽略 TERM 的同组后代可迟到复活journal/current。必须按原PGID/session枚举证明整组为空，超时KILL后再证明；只有leader消失不是成功。
- install恢复优先级阻断 AJ：install拿到主锁后若不先查未完成事务，可用20–40分钟构建阻塞watchdog，让未验target继公网运行且写全部503。锁内第一个状态动作必须fail closed检查transaction/active，在任何fetch/build/stage前让出锁交由恢复者。
- 独立service gate裂脑阻断 AK：`fireside-runtime-gate.service`可直接启动，不能假定旧MainPID已停。target仍在线时的no-restart恢复会清journal却留下进程target/指针origin裂脑。gate必须先证明MainPID=0，否则做完整restart+health或保留journal失败。
- 事务证据清理阻断 AL：原`clear_transaction`先删journal再清active；active为目录/异常类型时会丢失唯一事务证据并陷入无journal永久503。清理前同时验证两个固定目标及active txid；任一异常时两者均保留。
- 新机状态目录阻断 AM：README声称准备四个目录却遗漏`/var/lib/fireside-release`；recovery unit 的`ReadWritePaths`会因目标不存在在ExecStart前以226/NAMESPACE失败。新机流程必须显式创建并stat验证root:root0700，再启动recovery。
- 最小权限健康身份阻断 AN：backup gate/watchdog无`CAP_SYS_PTRACE`时不能`readlink /proc/MainPID/cwd`，完整恢复会在已restart origin后失败并留下reverting/503。不为此扩权读取Node环境；新版本以受信health commit证明身份，显式legacy才允许无shell/无环境的同UID固定helper只读cwd。
- watchdog无journal窗口阻断 AO：原顺序先启动watchdog后写prepared；两步间监督锁被杀时，watchdog先见无journal成功退出，孤儿worker可再无锁/无守护切换。顺序改为锁内先持久化无副作用prepared，再启动并确认watchdog；启动失败在active/revoke前安全清理或保留证据。
- 敏感preflight孤儿阻断 AP：随机`/run/fireside-promote.*`在chown后被SIGKILL会跨命令遗留，下一次同UID且带网的npm lifecycle可扫描并外传生产DB。改为root-only固定父目录+仅当次无网unit绑定暴露；有网build明确隐藏父目录，每次主锁入口先停旧transient再清孤儿。
- leader先死进程组阻断 AQ：AI首修仍以`transaction_owner_is_active || return 0`开头；worker leader在watchdog进入前被SIGKILL时会跳过同session后代枚举，迟到子进程仍可复活指针/journal。恢复必须在leader缺失时仍按记录PGID/session清空后代。
- 私有仓库认证阻断 AR：真实生产 install 使用固定 HTTPS 权威远端，私有 GitHub 在无凭证隔离环境中必然失败，已通过 SSH 443 推送与回读的 commit 仍无法部署。控制器改为固定 GitHub SSH 443，且只使用 root-owned 0600 单链接的专用只读 deploy key/known_hosts；先清空默认 identities，并禁用 SSH config、agent、证书、代理、密码、交互和调用环境覆盖，host key 或凭证元数据异常均在候选创建前失败关闭。
- 非 root 候选自测阻断 AS：controller 故障注入夹具要求 root owner/chown/进程组能力，而生产候选 `npm run check` 正确由隔离 `fireside-build` 执行，导致本机 root 通过、真实 install 32 项失败。提交前可信工作区必须跑完全部 controller 套件；候选构建中该 root-only suite 以明确原因整套 skip，其余单元/API/typecheck/build仍为硬门禁。禁止放宽生产 root-only断言或让 root执行候选测试代码。
- 嵌套 npm bin 阻断 AT：真实 prune 后 Fastify 与 node-abi 的嵌套依赖各自包含 `.bin/semver`，原逻辑只删顶层 `.bin` 后把合法命令链接误报为越界。固化改为递归删除所有真实 `.bin` 目录，再对其余树保持零 symlink 门禁；测试同时覆盖嵌套清理和 `.bin` 外链接拒绝。
- legacy npm bin 阻断 AU：候选安装成功后的首次 promote 被历史 current 的顶层/嵌套 `.bin` 命令链接拒绝。只有完全缺少 commit/metadata/manifest 且链接全集位于真实 `node_modules/**/.bin/` 的显式 legacy，才允许在主锁内先全量预检、再删除 `.bin`并fsync；其他链接或 manifested release 均零修改拒绝。
- watchdog READY 归属阻断 AV：真实 transient `Type=notify` 中，短生命周期 `systemd-notify` 的自身PID不被 `NotifyAccess=main`接受；systemd-run等待READY、watchdog随后等待controller主锁，确定性死锁。dispatcher必须用 `--pid=parent` 把READY显式归属父脚本main PID（不依赖可能被 transient 参数展开改写的 shell PID 字面量），并以真实持锁systemd握手及杀监督恢复验证。
- watchdog helper 凭据阻断 AW：AV 的直接 bash 探针绕过了生产 capability sandbox；真实 dispatcher链中 helper 没有权限伪装父PID，会退回自身凭据并继续被 `NotifyAccess=main`拒绝。固定root控制器、无网络且隔离业务密钥的 unit 改为 `NotifyAccess=all`，保留 `--pid=parent` 载荷和同步确认，不增加 `CAP_SYS_ADMIN`；验收必须复现生产进程链和最小bounding set。
- watchdog 网络/部署密钥隔离阻断 AX：规格要求恢复者不接触公网和生产密钥，但 transient unit 仍可任意出站并读取 `/etc/fireside-release` 的 GitHub deploy key。恢复健康检查只需宿主 loopback，故 unit 用 `IPAddressDeny=any` + `IPAddressAllow=localhost` 仅放行回环，并把业务口令与整个deploy-key目录都加入 `InaccessiblePaths`；真实unit必须验证回环健康仍通、公网与两类密钥均不可达。

本轮新增 AI/AJ/AK/AM/AN/AO/AP/AQ/AR/AS/AT/AU/AV/AW/AX 十五个 P1 与 AL 高价值 P2，即使基线全量 `check` 已通过，成熟度连续计数仍为 0。只有这些缺口修复、生产验收、页面全部功能与端到端操作逻辑闭环后，再完成连续两轮无新 P0/P1/合理高价值 P2 的独立审计，循环才允许停止。任何新发现都立即归零。

## Iteration 024：产品操作逻辑、日历活动详情与参与闭环（Accepted）

- 规格：SPEC-011、SPEC-003 第 16 轮业务候选。
- 三路业务审计一致证据：“报名围炉”承诺报名/入会却只进入缺少报名入口的周历；月历事件只打开受保护编辑；既有 E2E 只验证导航，不完成报名。该缺口违反 SPEC-007 已接受的日历阶段矩阵。
- 产品逻辑：发布显式选择“征集分享人→OPEN”或“我来分享→CLAIMED”；认领、退出、排期、取消、报名、结束归档、未举行重排和撤销误归档都有唯一正向/纠错路径。公开活动发现、参与报名和协作管理分层，事件点击不再等同管理编辑。
- 目标：统一活动详情和四阶段动作矩阵；月/周历直接完成报名/取消、入会、海报、归档/重排及资料查看；人数同步列表与日历；“沉淀归档”进入待归档任务；移动周历定位今天，核心触控目标至少44px。
- 验收：桌面 Chrome 与 Pixel 7 从“报名围炉”开始完成详情→解锁→报名→跨视图人数同步→月历取消；覆盖 UPCOMING/LIVE/ENDED/ARCHIVED、冲突、叠层焦点、无本周活动、待归档和页面承诺。
- 实现：公开活动详情与协作编辑分层；月/周历参与入口和人数同步；阶段动作矩阵；待归档任务；上下文空状态；桌面吸顶任务导航、移动菜单、Footer 导航；卡片维护层级、移动今天定位、紧凑五步流程与触控/字号基线。
- 验证：`npm run check` 的 145 项测试、类型检查和生产构建通过；`npx playwright test --retries=0` 在桌面 Chrome 与 Pixel 7 为 59 通过、3 项按设备职责跳过，并覆盖 820×1180 平板视口。
- 状态：Accepted。规格先于实现并已回写证据；该轮存在并修复有效业务/布局问题，成熟度连续计数仍为 0，下一轮必须重新独立审计。

## Iteration 025：生产运行态门禁目录校验（Accepted）

- 规格：SPEC-012。
- 生产证据：候选 `11c5c35` 安装成功后，promote 的写屏障回退触发 service gate；合法的 `/run/fireside-runtime` 为 `root:root 0755` 且目录链接数为 `2`，旧门禁错误要求 `root:root:755:1`，确定性返回 4 并阻断服务启动。
- 目标：目录只校验真实目录、owner/group/mode，不把文件专用的单链接约束套到目录；保留固定许可文件的单链接校验；完成真实恢复、重新提升和 80 端口验证。
- 成熟度：发现 P0，连续无新增有效轮次归零。
- 实现与验证：目录按真实类型、`root:root 0755` 校验，不再固定链接数；49 项发布控制器测试与 145 项全量 check 通过。真实 `reverting` 事务恢复成功，提交 `7582f3c` 正常提升；current/cwd/health commit 一致，非 root 服务和 `0.0.0.0:80` 健康，公开转发地址返回 200。

## Iteration 026：有报名活动的改期通知确认（Accepted）

- 规格：SPEC-014；来自第 18 轮独立端到端业务审计。
- 三路候选：有报名活动改期无通知提醒、任务导航落点被吸顶栏遮挡、客户端解析错误被误报为 500，均为高价值 P2。
- 本轮决策：先处理改期通知确认。它在完全正常的业务操作下让已报名伙伴错过活动，影响高于可通过继续滚动恢复的导航遮挡和只影响异常请求的错误语义；后两项必须进入紧随轮次，不能据此停止循环。
- 目标：未来活动已有报名且活动安排变化时，保存前展示人数、脱敏旧/新值和“不自动通知”责任；取消零请求并保留草稿，确认保留名单，412 后重新确认。
- 成熟度：三路均发现合理高价值 P2，连续无新增有效轮次保持 0。
- 实现：同一编辑弹窗内完成影响确认、人数与脱敏变更对照、线下通知责任、返回保留草稿和成功人数反馈；412 使旧确认失效。冲突重试使用三方合并，只保留本地实际修改，未触碰字段采用服务器最新版。
- 验证中补获并修复移动端延迟初始焦点抢占输入的问题。`npm run check` 145 项全部通过；桌面 Chrome 与 Pixel 7 无重试 E2E 为 61 通过、3 项按设备职责跳过。
- 状态：Accepted。导航落点遮挡和 SPEC-013 仍未完成，下一轮继续；连续无新增有效轮次为 0。

## Iteration 027：任务导航落点与合理排版（已验收）

- 规格：SPEC-015；来自第 18 轮独立响应式与页面承诺审计，并在第 19 轮继续独立复核。
- 已复现：1440×1000、820×1180 和 Pixel 7 的导航标题均落到吸顶栏后；“如何参与”不聚焦且仍把议题广场标为当前项，移动菜单关闭焦点与目的地焦点存在竞争。
- 目标：五个任务入口共用状态模型和导航命令；目标标题始终露出至少 8px、最终获得焦点，并且桌面/移动菜单只有正确入口具有当前态；页脚入口保持同构。
- 实现：桌面导航、移动菜单和页脚统一目的地命令与当前态；标题滚动边距避让吸顶栏，菜单卸载后稳定聚焦；搜索、筛选和流程快捷动作清理过期当前态；减少动态效果时禁用平滑滚动。
- 验证：`npm run check` 的 145 项单元/API/运维测试、TypeScript 和生产构建全部通过；桌面 Chrome 与 Pixel 7 在 `--retries=0` 下 66 项 E2E 通过、4 项按设备职责跳过；独立审计实测 1440×1000、820×1180 与 Pixel 7 标题均满足吸顶栏下至少 8px 间距。
- 状态：Accepted。第 19 轮继续发现成熟状态议题可直接删除的高价值业务 P2，连续无新增有效轮次保持 0；下一轮先保护已排期/已归档数据，再处理 SPEC-013。

## Iteration 028：UTF-8 围炉口令与六字符门槛（已验收）

- 规格：SPEC-016；用户明确要求生产最少 6 个字符，当前生产值按最后指令改为指定的 8 字符值。
- 独立三路审计一致复现：浏览器 Fetch 不能把中文直接写入 ByteString 请求头，旧前端会在网络请求前失败；只轮换环境变量将造成所有网页协作者无法解锁。
- 决策：页面透明发送 UTF-8 base64url 的 ASCII 值并用独立 encoding 头标记版本，服务端严格解码并暂时兼容旧 ASCII；保留唯一限流入口、8 小时会话和业务路由隔离。生产规则收口为显式配置、无首尾空白、6..256 Unicode code point。
- 部署顺序：先发布兼容代码，再把 Git 外生产环境文件轮换为新值并重启验证，禁止反序导致生产锁死。
- 成熟度：该阻断是用户新需求下的 P1，连续无新增有效轮次保持 0；完成后继续成熟状态删除保护与 SPEC-013，不停止主循环。
- 实现：生产门禁改为 6..256 Unicode code point；浏览器以带版本标记的 canonical UTF-8 base64url 请求头验证，服务端严格解码并兼容旧 ASCII；页面增加中文说明、5 字符反馈和移动输入属性，原始口令仍不进入 storage。
- 验证：146 项 `npm run check` 全部通过；桌面 Chrome 与 Pixel 7 使用中文测试口令完成 66 项无重试 E2E，4 项按设备职责跳过，覆盖验证头、短口令、限流、会话、完整生命周期和全部既有业务。
- 状态：Accepted；提交 `33fc1bf` 已受控提升，previous=`d6fd306`、journal clean。Git 外生产值按用户指令轮换，环境文件 `root:root 0600`；本机与公网 health、版本化口令验证均为 200。成熟状态删除保护仍为下一轮首要业务项，连续无新增有效轮次为 0。

## Iteration 029：成熟议题永久删除保护（Accepted）

- 规格：SPEC-017；来自第 19 轮发现并经第 21 轮生命周期、API、UX 三路独立复核。
- 已复现：服务端允许直接删除所有状态并由 SQLite 级联清除报名；页面向已排期和已归档卡片展示同一个永久删除按钮。
- 决策：删除只用于误建/重复议题，仅 `OPEN / CLAIMED` 可执行；`SCHEDULED / ARCHIVED` 先按真实活动结果走取消排期、未举行或撤销归档，`LIVE` 不得消失。
- 并发契约：鉴权和 If-Match 语法后，按 `404 missing → 412 stale revision → 409 mature state` 判定；所有拒绝零副作用，成功只推进一次 orderVersion。
- 页面目标：成熟状态不展示删除；确认默认聚焦取消，文案区分 OPEN / CLAIMED，提交明确为“确认永久删除”；成功和冲突后焦点落在稳定的新页面状态。
- 成熟度：三路确认高价值 P2，连续无新增有效轮次保持 0；完成后继续 SPEC-013 与新一轮独立业务审查。
- 实现：后端只允许无成熟依赖的 `OPEN / CLAIMED` 删除，在同一立即事务内完成 404/412/409 判定、删除、位置压实和精确 orderVersion；页面收口入口，并补安全默认确认、412/409/404 同步与稳定焦点。测试清理统一沿 `unarchive → unschedule → DELETE`，不保留测试后门。
- 复审修复：合法极限连续标题/分享人不再撑宽 Pixel 弹窗；远端先删除的 404 会关闭陈旧确认、移除卡片并聚焦议题广场；异常早期依赖不展示不可执行入口。
- 验证：150 项 `npm run check` 全绿；桌面 Chrome 与 Pixel 7 无重试 E2E 为 76 通过、4 项按设备职责跳过；三路独立终审 clean。
- 状态：Accepted；实现提交 `4480475` 已通过不可变候选安装并受控提升，生产 `current=4480475`、`previous=33fc1bf`、journal clean，socket/service active 并监听 `0.0.0.0:80`。本机与公网 health、首页和版本化 `fireside` 口令验证均为 200，服务日志无 warning。下一轮继续已 Ready 的 SPEC-013，并重新启动独立业务审查；连续无新增有效轮次仍为 0。

## Iteration 030：请求错误契约与页面可恢复提交（已验收）

- 规格：SPEC-013；第 22 轮 API、生命周期和 UX 三路独立审查复核后从 Ready 进入 Implementing。
- 已复现：空/畸形 JSON、XML、超过默认 1 MiB 的 body 与可解析 Content-Length 不一致全部被通用 handler 改写为 500；`/verify` 的限流 preflight 晚于 body parser，坏 body 可绕过来源失败桶；Pixel 7 的有报名改期二次确认收到 413 后退出确认层、焦点落到 body 且错误位于首屏之外。
- 服务端决策：显式固定 1 MiB 上限，只 allowlist 五个 Fastify parser code；固定 `401 → 503 → parser → If-Match → 业务` 顺序，并把 verify 的 no-store/限流 preflight 提到 parser 前；预期 4xx 不记 error，未知异常仍安全 500 并记录。
- 页面决策：可重试错误保留当前弹窗和全部草稿；改期二次确认保留报名人数、变更对照与 pending payload，在确认层显示并聚焦错误，一次点击一次请求。412/409/401 继续各自的并发和叠层契约。
- 成熟度：本轮有已证实 P2，连续无新增有效轮次保持 0。独立审查还确认取消排期前通知名单、NEXT FIRESIDE 跨开始边界、移动月历“今天”定位和条件性撞期保护等后续业务候选，完成本轮后必须继续。
- 实现与验收：五类 parser 错误、固定 1 MiB 上限、真实 HTTP/raw EOF、verify 前置限流、错误优先级、未知 500 和页面草稿/改期确认恢复全部自动化；三路终审 clean。154 项 `check`、80 项无重试跨端 E2E 通过，4 项按设备职责跳过，审计 0 漏洞。
- 状态：Accepted；实现提交 `b3aacd2` 已受控提升，生产 `current=b3aacd2`、`previous=4480475`、journal clean，本机/公网首页与健康检查、版本化 `fireside` 验证均为 200，无 warning。

## Iteration 031：发起议题与解锁协作入口分离（已验收）

- 规格：SPEC-018；由用户直接指出两个入口点击后页面相同。
- 已复现：锁定状态的“解锁协作”和“发起议题”都先执行 `requireAccess`，显示相同“解锁围炉协作”弹窗；发起人无法先查看创建字段或整理草稿。
- 决策：“解锁协作”只处理会话；“发起议题”立即打开公开创建表单。锁定用户可以先填草稿，首次发布只叠加 AccessModal 且零写入；解锁后不自动提交，必须再次确认发布。
- 验收：桌面/Pixel 覆盖两个入口分离、草稿、双层 dialog、Esc/X/遮罩/错误口令、正确解锁后零自动写入、显式发布一次请求和真实 401 回归。
- 成熟度：这是新的明确业务 UX 缺口，连续无新增有效轮次继续为 0；修复后仍继续取消排期通知、NEXT 时间边界与移动月历候选。
- 实现与验收：锁定创建先写草稿、首次发布零 POST、kind-aware 重锁、真实 401 与 429 的已知锁定预检、标签/“我来分享”保留与最终 `CLAIMED` 全部通过；三路终审 clean，全量证据同 Iteration 030。
- 状态：Accepted；实现提交 `b3aacd2` 已受控提升。公网无写入浏览器实测两个入口分别只打开创建表单与口令弹窗，其余生产证据同 Iteration 030。

## Iteration 032：同日多场日程编排与海报上下文（Accepted）

- 规格：SPEC-019；来自用户对“同一天有多个议题”的直接业务追问，并由 API、生命周期和 UX 三路独立审查。
- 已复现：同时排期可成功双写；同时事件排序不稳定；月历展开和周历在 10 场时无界增高；日头无总场次、快捷动作无法区分对象；海报无当日场次，同日同名文件会覆盖。
- 产品决策：当前是单轨围炉，允许同日串行联场；`[start,end)` 首尾相接允许，任何区间重叠拒绝。未来引入正式 track/resource 模型后才讨论并行。
- 页面决策：月/周历每日最多三条预览，更多进入完整“当日日程” dialog；日头显示场次，日程按北京时间和 ID 稳定排序，可逐场进入详情。海报保持一题一张，增加“当日第 N/M 场”、精确时间和 Topic ID。
- 成熟度：本轮发现有效 P2，连续无新增有效轮次保持 0；完成后必须继续独立业务循环。

## Iteration 033：独立 HTTPS 测试入口（Implementing）

- 规格：SPEC-020；作为业务循环不停止的并行部署任务，保留现有公网 HTTP/80，并用独立 Nginx main config 与 systemd unit 增加 443。
- 证书处理：获授权的临时证书链与规范化私钥复制到 `/etc/fireside-tls/fullchain.pem`（0644）和 `/etc/fireside-tls/privkey.pem`（0600），通过 systemd credential 提供给非 root Nginx；仓库不含证书或私钥。
- 本机验收：80/443 同时监听，主页和健康检查经本机域名解析为 200，错误 Host 为 421，证书链/主机名验证成功，TLS 1.2/1.3 接受、1.0/1.1 拒绝。首次启动发现 private `/dev` 下 `/dev/stdout` 不可打开，已关闭边缘访问日志并补回归。
- 当前状态：用户已将生产域名切换为 `firesidechat.cn`、弃用 `fireside.show`；原子轮换安装器、root-only 规范材料与本机 443 已验收，`www` 规范化为 308，旧域名返回 421。DNS 仍把新域名指向 `47.98.209.189` 而非本机 `166.108.239.81`，所以规格保持 Implementing，不宣称公网域名已发布。

## Iteration 034：平板日历右侧内容不可达（Accepted）

- 规格：SPEC-021；SPEC-019 完整回归后的新一轮独立页面审查，在真实 820×1180 Chromium 复现 P1。
- 根因：月/周历最小宽度为 860/980px，直接容器约 770px；横向滚动却只在 ≤720px 启用，外层又裁剪溢出。右侧日期、议题和操作无法查看或触达。
- 决策：所有视口都由月/周历局部容器承接横向溢出，保留七列可读宽度并保持整页无横向滚动；新增 820px 月/周最右列可达回归。
- 成熟度：发现真实 P1，连续无新增有效轮次仍为 0；修复验收后继续新一轮独立业务审查。

## Iteration 035：合法连续标题撑坏卡片与海报（Accepted）

- 规格：SPEC-022；同一轮页面审查用 API 合法的 80 字连续 Latin 标题在桌面和 Pixel 7 真实复现。
- 影响：列表 Grid 由内容最小宽度撑到 4,000px 以上并静默裁切；海报弹窗内部约 1,500px，预览和下载按钮越出视口，正常宣传路径不可用。
- 决策：Grid/Flex 用户内容列允许收缩，所有用户文本安全断词，海报图片约束在列宽内；保持 API 上限和 Canvas 1080×1440 业务契约。
- 成熟度：新增真实 P1，连续无新增有效轮次仍为 0；修复后继续取消排期通知闭环和下一轮审查。

## Iteration 036：取消排期前的报名通知闭环（Accepted）

- 规格：SPEC-023；端到端业务审查把第 22 轮已登记候选复现为 P1：确认后名单永久删除，但确认层没有人数、姓名或通知前置动作。
- 决策：受保护、同一快照读取当前 Topic/revision 与完整名单；有报名时可复制通知文本，必须确认已线下通知。报名并发导致 412 时刷新名单、复位确认并由用户再次显式提交。
- 边界：系统没有联系方式和投递通道，不伪装自动通知；本轮不保留取消后的名单历史。
- 成熟度：真实 P1 使连续无新增有效轮次保持 0；实现验收后继续处理本轮已证实 P2 并重新启动独立审查。

## Iteration 037：页面承诺与筛选恢复一致性（Accepted）

- 规格：SPEC-024；页面与端到端审查复现 4 个同类 P2：34px 清除按钮、搜索无结果被误报为本周无活动、线下活动虚假入会承诺、报名姓名被错误称为公开。
- 决策：页面文案以真实数据能力和权限为准；周历区分业务空态与条件空态，统一清除全部条件并保持视图；恢复入口达到 44px。
- 成熟度：仍有可复现业务偏差，连续无新增有效轮次保持 0；修复后处理发布/认领后的连续转场并重新审查。

## Iteration 038：发布 / 认领后的排期连续转场（Accepted）

- 规格：SPEC-025；第 25 轮端到端旅程审查复现 P2：自荐发布和认领已经进入 `CLAIMED`，页面却只显示短暂 toast，用户必须在长列表中重新找到议题才能排期。
- 决策：两条承担分享责任的成功路径都使用响应中的最新 Topic/revision 直接进入排期表单；明确前一步已经保存、排期可稍后完成。征集发布仍停在 `OPEN`，不越过认领。
- 边界：转场不自动排期、不把排期字段塞回发布/认领表单，关闭也不回滚已保存的责任状态；直接卡片排期不显示伪造的成功上下文。
- 成熟度：本轮仍有可复现业务断点，连续无新增有效轮次保持 0；完成后重新启动独立业务审查。

## Iteration 039：活动详情极端文本边界（Accepted）

- 规格：SPEC-026；第 26 轮页面审查在三种视口复现合法连续文本把详情弹窗撑到 5,000px 以上，核心正文与动作不可达。
- 决策：补齐 SPEC-022 未覆盖的详情 Grid/Flex 收缩与安全断词，并用桌面、820px、Pixel 7 真实周历入口回归。

## Iteration 040：排期并发恢复与转场焦点（Accepted）

- 规格：SPEC-025、SPEC-027；第 26 轮审查确认转场关闭焦点丢失，以及 412 通用处理关闭排期并丢草稿。
- 决策：转场关闭定位到“准备中”的目标卡片；排期 412 保留四类草稿、刷新 revision 并要求用户显式重试。

## Iteration 041：取消影响陈旧状态同步（Accepted）

- 规格：SPEC-028；取消影响首次 GET 的 404/409 是确定性生命周期变化，不得伪装成可无限重试的名单网络失败。
- 决策：关闭失效确认并同步/移除底层 Topic；仅临时读取失败保留重试。

## Iteration 042：完整往期回顾上下文（Accepted）

- 规格：SPEC-029；归档卡片与详情分别缺原排期和必填收获，导致任何单个视图都无法完整回顾。
- 决策：归档卡显示只读活动元信息，归档详情显示本期收获；继续隐藏会议凭证和报名姓名。
- 成熟度：第 26 轮有 1 个 P1 和 4 个 P2，连续无新增有效轮次归零；全部验收后必须继续独立业务审查。

## Iteration 043：跨年度往期日期消歧（Accepted）

- 规格：SPEC-029；第 27 轮领域审查发现归档卡的日期缺少年份，而详情已经显示年份。
- 风险：跨年度归档的同月同日会显示成相同时间，用户无法只从往期列表判断真实举行年份。
- 决策：只在 `ARCHIVED` 卡片采用含四位年份的完整日期；近期 `SCHEDULED` 卡片保持紧凑格式。桌面与 Pixel 7 同时断言年份、地点、时长、收获和隐私边界。
- 成熟度：本轮新增有效 P2，连续无新增有效轮次保持为 0；修复后继续独立业务审查。

## Iteration 044：转场关闭焦点所有权（Accepted）

- 规格：SPEC-025；第 27 轮页面审查在桌面、820px 平板和 Pixel 7 均复现目标卡聚焦约 1 秒后被通用弹窗回焦覆盖。
- 根因：转场排期弹窗捕获了即将卸载的创建/认领按钮；关闭时业务层已经聚焦目标卡，弹窗层仍连续重试旧目标并最终回退到广场标题。
- 决策：转场关闭由业务层独占回焦，弹窗层只负责栈释放；其他普通弹窗继续沿用通用回焦。跨端验收等待至少 1 秒后再断言目标卡仍聚焦。
- 成熟度：本轮新增有效 P2，连续无新增有效轮次保持为 0；修复后继续独立业务审查。

## Iteration 045：征集发布后的可见结果（Accepted）

- 规格：SPEC-025；从非 OPEN 标签、日历或搜索条件发起默认征集后，成功结果仍被原条件隐藏。
- 决策：普通征集也携带服务端创建结果回到业务层；切换 `OPEN + list`、清除临时条件并稳定聚焦新卡，不进入排期、不越过认领。

## Iteration 046：冲突与成功操作的页面上下文同步（Accepted）

- 规格：SPEC-027、SPEC-030；排期 412 的最新版只存在弹窗内，普通成功操作又因刷新卸载旧节点而丢失焦点。
- 决策：412 最新 Topic 合并到页面但保留 DOM 排期草稿；成功 mutation 使用响应快照，并在列表稳定后由业务层聚焦同卡动作或卡片，通用弹窗不得覆盖。

## Iteration 047：历史参与名单的阶段真实文案（Accepted）

- 规格：SPEC-024；结束/归档名单已经只读，却仍承诺报名与代为取消。
- 决策：可参与阶段保留邀请和取消说明；结束/归档阶段明确历史只读，0 人只陈述暂无参与记录。

## Iteration 048：全局导航 44px 命中区（Accepted）

- 规格：SPEC-031；顶部/页脚品牌高度不足 44px，页脚三个短任务链接宽度不足 44px。
- 决策：扩大真实链接命中区，同时保持视觉层级、导航行为和整页宽度边界。
- 成熟度：第 27 轮累计 7 个有效 P2，连续无新增有效轮次保持为 0；完成后必须开始新的独立业务审查。

## Iteration 049：跨年度排期日期消歧（Accepted）

- 规格：SPEC-032；第 28 轮页面审查在 1440px、820px 与 Pixel 7 均复现合法 2027 排期只显示月日。
- 决策：卡片和顶部下一场以北京时间比较活动年与当前年，跨年才显示四位年份；归档始终显示年份，详情等完整业务文档保持原规则。
- 成熟度：新增有效 P2，连续无新增有效轮次保持为 0；完成后重新启动独立业务审查。

## Iteration 050：归档活动历史时序门禁（Accepted）

- 规格：SPEC-033；第 28 轮领域审查确定性复现归档 PATCH 可把活动改到归档之后/未来。
- 决策：保留历史录入纠错，但候选活动结束必须不晚于该次 `archivedAt`；页面说明上界，API 在写事务内按 revision/status 重新校验并保证拒绝零副作用。
- 成熟度：第 28 轮已有 2 个有效 P2，连续无新增有效轮次保持为 0；全部修复后重新启动独立业务审查。

## Iteration 051：叠层冲突与成功后刷新韧性（Accepted）

- 规格：SPEC-030；第 28 轮旅程审查复现叠层 412 焦点穿透，以及 mutation 200 后列表 GET 503 覆盖成功结果。
- 决策：叠层按最新状态留在有效详情或关闭后进入权威卡片；成功响应先稳定合并，后续刷新非阻断，失败只提示同步暂缓，不移除结果或落点。

## Iteration 052：取消排期 / 未举行后的连续下一步（Accepted）

- 规格：SPEC-034；活动详情在成功回到 CLAIMED 后成为无动作死页，“未举行 / 重新排期”文字未兑现后半段。
- 决策：未来取消进入准备中列表并聚焦；结束未举行使用最新 revision 进入可关闭的重新排期转场，不自动提交或恢复旧报名。
- 成熟度：第 28 轮累计 5 个有效 P2，连续无新增有效轮次保持为 0；全部闭环后开始第 29 轮独立审查。

## Iteration 053：活动详情业务关闭的焦点所有权（Accepted）

- 规格：SPEC-030；第 28 轮验收在桌面与 Pixel 7 均复现取消排期后准备中卡片先聚焦，约 1 秒后又被已卸载详情的通用回焦覆盖。
- 决策：区分“用户手动关闭”和“业务结果关闭”；后者在卸载前显式抑制详情回焦，由页面唯一决定目标卡片/标题，前者保留原入口恢复。

## Iteration 054：删除成功后的幽灵卡片防护（Accepted）

- 规格：SPEC-030；非删除 mutation 可从响应合并 Topic，但 DELETE 204 仍依赖后续列表刷新；若该 GET 503，服务端已删除而页面仍显示可操作旧卡。
- 决策：删除完成回传受影响 ID，页面立即从本地权威视图移除并聚焦议题区标题；列表/统计刷新仍为非阻断校正，失败只提示同步暂缓。

## Iteration 055：月历今日定位与平板活动触控（Accepted）

- 规格：SPEC-035；第 29 轮页面审查在周日复现 820px/Pixel 7 点“今天”后今日列仍在月历右侧视口外，并测得 820px 月历活动入口高度只有 34px。
- 决策：月历复用周历局部容器定位思路，在今日进入/重定位后将今日格整体带入可视区；`<=1000px` 月历活动按钮提升到 44px，保持 3 场预览与当日议程。
- 成熟度：第 29 轮领域审查 clean，但页面审查已有 2 个有效 P2，因此本轮不计 clean，连续无新增有效轮次保持 0。

## Iteration 056：完整当日议程的三层回焦所有权（Accepted）

- 规格：SPEC-030、SPEC-034；第 29 轮旅程审查从 4 场周历进入当日议程、活动详情和取消确认，成功后准备中卡先聚焦，1.6 秒后又被外层议程回退到通用标题。
- 决策：当日议程加入同一业务关闭抑制信号；用户手动逐层关闭仍恢复原入口，状态结果卸载整个日历栈时只保留页面决定的单一落点。

## Iteration 057：报名写入成功后的名单同步韧性（Accepted）

- 规格：SPEC-036；POST 201 / DELETE 204 已改变服务端名单，但紧随 GET 503 会让页面保留相反旧名单、把成功误报为失败并丢失焦点。
- 决策：先合并 201 Participant / 移除 204 目标 ID，后台 GET 只校正；校正失败保留已知结果，用可聚焦警告说明写入已成功。
- 成熟度：第 29 轮累计 5 个有效 P2（页面 2、旅程 3，其中删除幽灵卡已在 Iteration 054 处理），连续 clean 轮次为 0。

## Iteration 058：主机安装与部署目录收口（Accepted）

- 规格：SPEC-037；用户要求安装部署具备专用脚本和目录。现状只有 release 控制器，主机身份/目录/controller/systemd/HTTPS 布局仍是分散手工步骤。
- 决策：新增 `ops/host-installer/` 和固定 root-owned 生产入口；base、HTTPS 布局、校验与激活分阶段幂等执行，不自动处理密钥/口令、选择发布路径、改 DNS/防火墙或操作数据库。

## Iteration 059：当日议程的阶段真实承诺（Accepted）

- 规格：SPEC-024；第 30 轮页面审查在 1440/820/Pixel 7 均复现 4 场全归档议程仍声称可报名、入会和生成海报，与详情动作矩阵相反。
- 决策：议程介绍由当日有序 Topic 的阶段、会议入口和重叠状态派生；全历史进入回顾语义，混合议程不承诺任何完全不存在的能力。
- 成熟度：第 30 轮已有有效 P2，本轮不计 clean，连续 clean 仍为 0。

## Iteration 060：周历与当日议程的年份身份（Accepted）

- 规格：SPEC-032；第 30 轮在当前 2026 年、活动 2027 年的三端复现：列表与下一场已显示年份，但进入周历后标题和事件再次省略。
- 决策：周标题始终含年，跨年周的两端分别标年；周事件和当日议程使用完整含年日期，不让跨视图导航丢失时间身份。

## Iteration 061：参与名单未知态与跨视图写入韧性（Accepted）

- 规格：SPEC-036；第 30 轮旅程审查确认名单写入虽已本地合并，但随后 Topic 列表 503 仍会替换整个广场；首次名单 GET 503 还会把未知误报成 0 人且无法原地重试。
- 决策：成功写入立即同步所有 Topic 快照的人数，精确/列表读取仅后台校正且不阻断；首次读取失败显示未知态和 44px 重试入口，不虚构空名单。
- 验证：桌面与 Pixel 7 的写入后 participants/topics 双 503、首次 GET 503 → 重试均通过；第 30 轮仍有有效发现，连续 clean 保持 0，进入第 31 轮独立审查。

## Iteration 062：当日议程回焦抑制的单次生命周期（Accepted）

- 规格：SPEC-030；第 31 轮页面审查复现一次三层取消排期后共享 suppress ref 未重置，第二次正常关闭议程落到 BODY。
- 决策：每次从日历新开当日议程时重置本次回焦所有权；业务关闭仍可抑制正在卸载的整层栈，但不能污染下一次独立打开。
- 成熟度：第 31 轮已有有效 P2，不计 clean，连续 clean 保持 0；修复后进入第 32 轮。

## Iteration 063：报名 mutation 的权威版本与聚合快照（Accepted）

- 规格：SPEC-036、SPEC-038；第 31 轮领域/旅程审查发现未知名单仍可报名、完整名单不校正跨视图人数、报名成功不返回新 revision，以及若干 Topic mutation 把真实报名数响应成 0。
- 决策：未知基数先重试再开放报名；完整 GET 传播人数；报名响应头携带同事务 revision/count；所有 Topic mutation 在事务内重新读取真实聚合快照。
- 成熟度：包含正常旅程阻断 P1，第 31 轮不计 clean，连续 clean 保持 0。

## Iteration 064：沉淀资料链接有界输入（Accepted）

- 规格：SPEC-039；第 31 轮领域审查真实保存 200,021 字符资料 URL，使单条公开列表约 200KB。
- 决策：archive/PATCH 服务端统一 2048 上限，页面同步 maxLength；拒绝零副作用，不在读取时破坏历史数据。

## Iteration 065：全站业务文字可读性（Accepted）

- 规格：SPEC-040；用户指出首页“等待认领 / 准备中 / 已排期 / 知识归档”等关键业务文字过小，系统扫描同时发现多个操作、反馈和活动元信息仍使用 9–11px。
- 决策：按业务信息层级设跨端真实字号下限；优先保证导航、状态、动作、反馈和活动身份，装饰英文可保留较小层级。字号提升后同时验证 1440px、820px、Pixel 7 和 320px 布局，不以缩小关键文字解决密度。
- 成熟度：该有效 P2 使连续 clean 轮次保持 0；完成验收后与第 31 轮一致性修复一起进入第 32 轮独立审查。

## Iteration 066：全量 E2E 隔离与业务落点断言（Accepted）

- 规格：SPEC-003、SPEC-009、SPEC-030；全量 E2E 的真实 429 旅程在第二页面创建征集后，产品会按规格切到“等待认领”，旧测试却直接查找已排期敏感读取卡并等待到通用上限；随后 `finally` 来不及清理，遗留议题并连锁污染同日单轨与海报用例。
- 决策：真实限流旅程在验证新征集可见后显式回到“全部议题”，再检查已有会话的敏感读取；同时使用覆盖短窗口、双页面业务验证和清理的显式预算。创建成功的叠层回归按现行业务规格断言新议题卡，而不是已经完成使命的旧触发按钮。
- 验收：两个根因定向跨端 4/4 通过；随后完整 E2E 123 通过、5 项职责跳过、0 失败/重试，已进入第 32 轮独立审查。

## Iteration 067：陈旧快照冲突夹具确定性（Accepted）

- 规格：SPEC-003、SPEC-023；“取消影响首次读取”用例在 `page.goto` 后立即执行外部取消，可能早于页面首次列表完成，页面从一开始就只看到 `CLAIMED`，从未渲染要点击的旧“取消排期”动作，等待 30 秒后又中断清理。
- 决策：先同时确认两个 SCHEDULED 卡片及其“取消排期”动作已渲染，再由外部请求分别取消/删除；之后点击真实陈旧动作，验收 409/404 恢复，而不是验收加载竞态。
- 验收：该冲突用例桌面/移动 2/2 通过并回收夹具；随后完整 E2E 从干净数据库运行，123 通过、5 项职责跳过、0 失败/重试。

## Iteration 068：最高层业务入口字号（Accepted）

- 规格：SPEC-040；第 32 轮页面审计在 1440、820、393、320 实测 Hero/Closing 四个 CTA 均为 13px，1440 顶部七个任务按钮也为 13px，反而小于已经提升到 14px 的 Tabs 和卡片动作。
- 决策：顶部任务导航、`.primary-button` 与 `.ghost-button` 统一使用 14px action token；保持 44px 命中区、移动纵向布局和 320px 无页面横溢。
- 成熟度：本轮有合理高价值 P2，第 32 轮不计 clean，连续 clean 保持 0；完成后重新启动独立第 33 轮审查。

## Iteration 069：并发同名报名后的权威名单恢复（Accepted）

- 规格：SPEC-036；第 32 轮旅程审计复现页面确认 0 人后，另一协作者先报名同名，当前 POST 正确返回 409，但页面继续显示确定的 0 人、无姓名且无重读入口，服务端实际为 1 人。
- 决策：把 `PARTICIPANT_DUPLICATE` 解释为名单基数已被并发推进；立即进入未知态并读取完整名单，成功同步所有 Topic 快照并聚焦“已在名单中，已刷新”，失败保留未知态与重试，不自动重放 POST。
- 成熟度：第 32 轮已有第二个有效 P2，不计 clean；两项修复闭环后重新启动独立第 33 轮。

## Iteration 070：Topic 投影 revision 单调合并（Accepted）

- 规格：SPEC-038；第 32 轮领域审计复现延迟的 revision 2 精确 GET 在报名 201/ETag 3 后到达，无条件覆盖全部 Topic 快照，使人数回到 0、下一次 If-Match 无意义 412；完整名单 GET 又缺少同快照 revision。
- 决策：所有 Topic 来源按同 ID revision 单调合并；participants GET 在只读事务返回名单正文、ETag 与人数头，客户端严格解析并同时传播 revision/count。迟到旧精确/列表响应只能被忽略。
- 成熟度：第 32 轮共 3 个有效 P2，不计 clean、连续 clean 为 0；三项完成并全量验证后重新启动第 33 轮。

## Iteration 071：既有报名旅程的语义与清理同步（Accepted）

- 规格：SPEC-003、SPEC-036；并发重复报名从普通错误升级为“已在名单中，已刷新”后，既有会议/报名 E2E 仍等待旧“已经报名”文案；失败又因用例没有 `finally` 留下排期，重试受同日单轨影响。
- 决策：既有旅程断言新的权威恢复语义，并捕获创建 ID；无论中途断言是否失败都按最新版清理，正常 UI 删除后取消兜底，防止首错污染重试与后续用例。
- 验收：该完整旅程桌面/移动 2/2 无重试通过；随后全量 E2E 从干净数据库运行，127 通过、5 项职责跳过、0 失败/重试。

## Iteration 072：并发取消报名的幽灵记录恢复（Accepted）

- 规格：SPEC-036；第 33 轮旅程审计复现另一组织者先取消 Alice 后，当前 DELETE 404 仍保留 Alice/1 人且无重读入口。
- 决策：缺失 Participant 返回稳定码；页面对称于重复报名恢复，失效旧基数并重读，成功显示已由他人取消，503 进入未知重试，不重放 DELETE。

## Iteration 073：移动日历周期按钮 44px 边界（Accepted）

- 规格：SPEC-035；第 33 轮页面审计实测 393/320 月周历前后周期按钮被 Flex 压缩到约 39.22px 宽。
- 决策：周期方形按钮禁止收缩并设置 44px 最小宽度；四视口复核标题、今天、月/周工具栏和页面横溢。

## Iteration 074：完整列表的成员集合权威（Accepted）

- 规格：SPEC-038、SPEC-030；第 33 轮领域审计复现 B 删除 X 后，A 成功发布 Y 的完整列表已不含 X，页面却把所有本地缺失项拼回，留下永久幽灵卡。
- 决策：完整列表成功响应决定成员集合，仅共同 ID 做 revision 单调选择；读取失败才保留既有集合，本次 mutation 继续由已知响应和最新完整列表保护。
- 成熟度：第 33 轮三路各有有效 P2，不计 clean、连续 clean 为 0；三项修复并全量验收后从第 34 轮重新计数。

## Iteration 075：搜索与清除操作字号补齐（Accepted）

- 规格：SPEC-040；第 34 轮页面审计实测 1440/820/393/320 搜索输入均为 13px，桌面/平板“清除条件”同为 13px，低于统一 action 层级。
- 决策：搜索输入、placeholder 与清除操作统一使用至少 14px action token；四视口复核 44px 命中区、工具栏换行和页面横溢。
- 成熟度：第 34 轮已有有效 P2，不计 clean、连续 clean 重置为 0。

## Iteration 076：手机页脚导航落点取整边界（Accepted）

- 规格：SPEC-015；完整移动回归首次从页脚进入议题区时，平滑滚动最终仅保留 6px，低于既定 8px 安全间距并造成一次重试。
- 决策：增加手机标题实际滚动余量而不放宽断言；页脚四入口连续执行、焦点/当前态及全量回归必须 0 重试。

## Iteration 077：取消排期后的打开名单失效（Accepted）

- 规格：SPEC-023、SPEC-038；第 34 轮领域审计复现 A 已打开 2 人名单，B 取消排期后 A 的 Topic 已同步为 CLAIMED/revision 5，弹窗却仍展示已被事务删除的两人。
- 决策：名单作为 Topic revision 的派生快照随更高版本失效；取消排期回退到 CLAIMED/OPEN 时关闭弹窗并明确名单已清空，SCHEDULED/ARCHIVED 的更高 revision 则重读真实名单。
- 成熟度：第 34 轮已有多个有效 P2，连续 clean 保持 0；全部修复后进入新一轮。

## Iteration 078：外部版本名单刷新失败先进入未知态（Accepted）

- 规格：SPEC-036、SPEC-038；第 35 轮领域审计复现父 Topic 已到更高 revision、派生名单 GET 503 后，弹窗一边称暂不可用，一边继续展示可操作的旧 2 人子集，遗漏服务端第 3 人。
- 决策：外部更高 revision 重读前先失效完整基数并隐藏旧行/动作；重试成功后原子恢复新 revision 的 3 人名单，自身 mutation revision 不重复触发。

## Iteration 079：外部取消排期关闭名单后的同卡回焦（Accepted）

- 规格：SPEC-030、SPEC-038；第 35 轮旅程审计在桌面/Pixel 复现弹窗和名单虽正确关闭/清空，延迟通用回焦却最终落到广场标题。
- 决策：业务关闭抑制通用回焦，切换到目标真实状态的无条件列表并聚焦同一 Topic 卡；等待 1 秒仍稳定，不重放写入。
- 成熟度：第 35 轮有两个有效 P2，不计 clean、连续 clean 保持 0；修复后从第 36 轮重新计数。

## Iteration 080：合法上限正文的列表渐进披露（Accepted）

- 规格：SPEC-022；第 37 轮 UI 审计以 500 字简介和 1000 字归档收获复现单张卡在 320px 宽时高达约 3745px，超过五个完整视口，其他议题与动作入口难以扫描。
- 决策：列表默认分别限制简介 4 行、炉边余温 5 行；长内容提供独立、语义关联、至少 44px/14px 的展开与收起按钮，全文仍保留且活动详情继续完整显示。展开/收起仅影响当前卡片，焦点稳定并保持四视口无横向溢出。
- 成熟度：第 37 轮领域、旅程 clean，但 UI 有有效 P2，因此该轮不计 clean，连续 clean 从 1 重置为 0；修复后从第 38 轮重新计数。

## Iteration 081：收起长正文后的可视焦点锚定（Accepted）

- 规格：SPEC-022；第 38 轮 UI 审计复现长余温底部点击收起后，按钮虽仍为 `document.activeElement`，却因上方正文骤缩跳到视口之外，320px 下 `top=-1432px`，键盘和低视力用户失去上下文。
- 决策：仅在用户从展开态主动收起后，于新布局帧检查同一按钮；若超出安全区，以即时最小滚动将它校正到吸顶导航下至少 8px或视口底部以上 8px。简介/余温独立处理，不改变筛选、卡片或焦点所有权。
- 成熟度：第 38 轮出现有效 P2，不计 clean、连续 clean 保持 0；闭环后从第 39 轮重新计数。

## Iteration 082：以真实渲染溢出驱动渐进披露（Accepted）

- 规格：SPEC-022；第 38 轮领域审计在 320px 复现恰好 160 字简介约 10 行、220 字余温约 18 行，但固定 `>160/>220` 字符阈值判定为短文，按钮为 0，卡片仍高约 1.73 个视口。
- 决策：所有列表正文默认应用行数边界，以同一 DOM 在当前宽度和字体下的真实 `scrollHeight/clientHeight` 决定控制是否存在；使用 ResizeObserver 覆盖视口/布局变化，展开态测量也不得误删按钮。存储、编辑和详情全文不变。
- 成熟度：该有效 P2 与 Iteration 081 一并闭环后，从第 39 轮重新计数。

## Iteration 083：归档正文展开态的生命周期隔离（Accepted）

- 规格：SPEC-022；第 39 轮领域审计复现长旧余温展开后，撤销归档并再次填写新长余温，同 ID/React key 的卡片保留 `takeawayExpanded=true`，新归档直接显示全文和“收起炉边余温”。
- 决策：以 `ARCHIVED + takeaway` 作为余温语义身份；身份被清除或正文被替换时，在布局提交阶段复位 expanded 与待校正标记。相同正文的刷新、排序和普通 revision 更新保持阅读状态。
- 成熟度：第 39 轮有有效 P2，不计 clean、连续 clean 保持 0；修复后从第 40 轮重新计数。

## Iteration 084：全量 E2E 排期夹具的时钟隔离（Accepted）

- 规格：SPEC-003；第 41 轮三路业务审计 clean 后，最终 `--retries=0` 门禁在北京时间 19 点稳定暴露夹具缺陷：演示活动固定“两天后 19:30”，7 个用例以“当前时刻 + 两天”创建 30/40 分钟活动，正确命中单轨 409；未校验排期响应的用例继续等待不存在的会议/海报按钮并连锁超时。
- 决策：每组测试夹具使用互不重叠、远离演示活动的明确未来日偏移；所有直接 schedule 请求必须立即断言 200 后才能进入页面旅程。失败前已创建的 Topic 必须纳入 `finally` 清理，首错不得污染后续职责。
- 成熟度：质量门禁出现确定性有效问题，第 41 轮不能成为最终第二个 clean，连续 clean 重置为 0；修复并完整 `--retries=0` 通过后重新启动独立审计。

## Iteration 085：共享 E2E 数据库的失败隔离（Accepted）

- 规格：SPEC-003；第 42 轮领域审计确定性复现首轮排期后断言失败、未清理的 Topic 留在共享内存库，几秒后的重试候选落入同一 30 分钟区间并收到正确 409。现有若干直接 schedule 未断言 200，且只在正常尾部清理，会把首错放大成后续串扰。
- 决策：`beforeAll` 记录演示基线 ID，`afterEach` 无条件按最新状态删除本用例产生的全部非基线 Topic，作为局部 finally 之外的最终隔离网；真实 schedule 在解析或进入页面前必须显式断言 200。关键排期旅程继续保留局部 finally，使清理失败直接阻断而不吞错。
- 验收：故意在排期后失败时，afterEach 仍清空非基线 Topic，下一职责/重试同槽排期可得到 200；静态复核不得继续忽略 schedule 响应；完整 `--retries=0` 结束后数据库只剩基线。
- 成熟度：第 42 轮有有效 P2，不计 clean、连续 clean 保持 0；修复后重新开始独立审计。

## Iteration 086：会议入口临时读取失败的原地恢复（Accepted）

- 规格：SPEC-024、SPEC-011；第 43 轮旅程审计在已解锁的未来线上议题中复现首次 `meeting-access` GET 返回 503 后，弹窗只剩错误正文和关闭按钮，用户必须猜测关闭再打开才能恢复。
- 决策：会议入口读取抽成可显式重入的单次请求；失败保留同一弹窗与至少 44px 的“重新读取会议入口”，不自动重试、不自动打开。点击后清错并只发一次 GET，成功显示入口并聚焦链接；关闭、401 解锁、阶段 409 和迟到响应继续遵守现有叠层与隐私边界。
- 验收：桌面与移动端覆盖首次 503、静默等待无第二请求、显式重读第二次 200、正确 `href`/焦点/关闭回焦，并回归 401、阶段失效和关闭后的迟到成功不泄漏。
- 成熟度：第 43 轮有有效 P2，不计 clean，连续 clean 保持 0；修复后从第 44 轮重新开始连续 clean 计数。

## Iteration 087：迟到会议地址的权威版本复核（Accepted）

- 规格：SPEC-024、SPEC-038；第 44 轮领域审计复现会议入口 `200` 已由服务端取得但尚未交付时，另一协作者取消排期到 `CLAIMED`，旧响应放行后页面仍首次写入完整失效地址。
- 决策：服务端为会议入口响应返回读取时 Topic revision；客户端在任何敏感地址进入 DOM 前再精确读取公开 Topic，要求 revision、`SCHEDULED`、`hasMeetingUrl` 与可参加阶段全部一致。变化时丢弃地址、关闭并同步状态；复核失败时只提供显式重读，不得短暂显示。单次请求代次覆盖敏感读取与复核，关闭、登出、重试和阶段变化会让旧代次失效。
- 验收：延迟旧 200→外部取消/归档→放行后正文、`href` 与 DOM 都无 secret；正常相同 revision 可显示；503 的“一次点击一次请求”、401、阶段 409 和关闭迟到回归不变。
- 成熟度：第 44 轮有有效 P2，不计 clean，连续 clean 保持 0；修复后从第 45 轮重新计数。

## Iteration 088：所有敏感会议读取共用权威复核（Accepted）

- 规格：SPEC-024；第 45 轮领域审计确认 Iteration 087 只保护会议弹窗，首次编辑与编辑 412 恢复仍可在外部取消后把迟到旧地址写入 input/DOM。
- 决策：抽取唯一“会议敏感 GET + 强 ETag + exact Topic + revision/状态/入口/阶段”验证流程，由会议弹窗、首次编辑和 412 恢复共用；任何失效只返回公开最新版，不能把旧值注入表单或后续 payload。调用者继续用组件 active 或 access epoch 拒绝退出/关闭后的迟到链。
- 验收：两条编辑路径各覆盖外部取消/移除链接/删除、复核失败、非法 ETag 与退出；input value/attribute、正文和 HTML 都无 secret，零误写回。
- 成熟度：第 45 轮有有效 P2，不计 clean，连续 clean 保持 0。

## Iteration 089：会议状态冲突后的同卡业务回焦（Accepted）

- 规格：SPEC-030；第 45 轮 UI/旅程审计确认旧地址虽已安全丢弃，弹窗关闭与状态同步后焦点仍在 1.2 秒时落到广场标题，用户丢失发生变化的议题与下一步。
- 决策：会议业务冲突捕获 Topic ID 并抑制本次通用回焦；读取公开最新版后，仍有入口就聚焦同卡“加入会议”，动作消失则进入该状态无条件列表并聚焦同卡，删除才回议题区标题。回焦不触发额外敏感读取或 mutation。
- 验收：1440/768/390/360 与桌面/Pixel 7 在外部取消链路等待至少 1 秒仍聚焦同 ID 卡片，secret 不入 DOM、状态和反馈一致。
- 成熟度：修复两项后从第 46 轮重新开始连续 clean 计数。

第 46 轮三路独立复审均 clean：三类敏感读取无旁路，取消/换址/缺失元数据/复核失败均不泄露或误写回；四视口与桌面/Pixel 7 的同卡/同动作焦点在 1.2 秒后稳定。当前连续 clean 为 1，进入第 47 轮。

## Iteration 090：搜索空态清除后的稳定业务落点（Accepted）

- 规格：SPEC-024、SPEC-030；第 47 轮 UI 审计在四档视口复现主空态“清除搜索”后结果恢复，但按钮卸载且 1.2 秒焦点固定落到 `BODY`。
- 决策：抽取只清除搜索的命令，保留状态筛选与当前视图，在结果提交后复用导航焦点调度落到议题区标题；不把主空态误改为清除所有条件。
- 验收：360/390/768/1440 点击后结果恢复，等待 1.2 秒仍聚焦 `#topics h2`，无横溢、零网络写入；顶部/周历的“清除条件”语义不变。
- 成熟度：第 47 轮有有效 P2，不计 clean，连续 clean 从 1 重置为 0；修复后从第 48 轮重新计数。

## Iteration 091：空周查看下一场后的目标活动焦点（Accepted）

- 规格：SPEC-024、SPEC-030；第 47 轮 UI 审计以仅有一场跨年远期排期复现：空周点击“查看下一场”后正确跳到目标周并显示活动，但按钮卸载，1.2 秒焦点落到 `BODY`。
- 决策：查看下一场同时记录目标 Topic ID；周游标提交并渲染后聚焦对应 `.week-event-main`，并发缺失时回退周历标题。保留现有筛选与视图，不自动打开详情。
- 验收：390px 远期跨年动态用例和桌面/Pixel 职责均在 1.2 秒后聚焦目标活动，标题年份、事件可见、无横溢和零网络写入。
- 成熟度：与 Iteration 090 一并修复后从第 48 轮重新计数。

## Iteration 092：重新连接成功后的数据区焦点（Accepted）

- 规格：SPEC-024、SPEC-030；第 47 轮 UI 审计在初始 topics GET 503 后点击“重新连接”，第二次 200 正确恢复卡片，但错误按钮卸载后 390px 等待 1.2 秒焦点落到 `BODY`。
- 决策：封装显式重连命令，单次等待 `load()`；成功后调度焦点到议题区标题，失败则保留重试上下文并聚焦错误/按钮。不改变筛选、排序、视图或任何业务数据。
- 验收：四视口首次 503→显式一次重试→200 后卡片恢复且 1.2 秒焦点稳定；连续失败仍可原地重试，零 mutation、无横溢。
- 成熟度：与 Iteration 090/091 一并修复后从第 48 轮重新计数。

## Iteration 093：动态周事件落点避开吸顶导航（Accepted）

- 规格：SPEC-024、SPEC-030；第 48 轮 UI 审计确认“查看下一场”已正确聚焦目标事件，但四档视口事件 top≈0px、header bottom=65–77px，状态/时间和焦点轮廓被完全遮住。
- 决策：目标先声明 96px `scroll-margin-top`，通用业务聚焦再读取真实 sticky header 与目标矩形；若顶部不足 header bottom + 10px，执行即时差值滚动校正，以 2px 余量稳定满足 8px 验收线。静态边距防止浏览器在后续滚动阶段重新遮挡，动态校正适配真实导航高度；保留目标焦点、当前周和 fallback，不触发平滑二次漂移。
- 验收：360/390/768/1440 在 1.2 秒后 activeElement 仍为目标周事件，顶部安全间距至少 8px；清搜索、重连及既有导航落点不回退。
- 成熟度：第 48 轮有有效 P2，不计 clean，连续 clean 保持 0；修复后从第 49 轮重新计数。

## Iteration 094：主机安装器夹具跨身份可复现（Accepted）

- 规格：SPEC-003、SPEC-037；生产 controller 以 `fireside-build` 运行候选 check 时，两项本地 root 通过的测试因 `EACCES` 失败。
- 根因边界：fixture 事务快照不应依赖读取计划外 `0000` 哨兵；digest 篡改测试不应依赖 root 直接写 `0444`。真实 production bundle 的 root owner、0755/0444、manifest、单链接与固定路径门禁不得放宽。
- 决策：fixture 事务改为只记录并回滚本次管理动作涉及的 state/路径，或使用不读取正文且不会改变活动树链接不变量的等价机制；篡改测试由所有者显式临时开写、改内容、恢复 0444 后验证 digest 拒绝。
- 验收：普通非 root 与 root 身份的主机安装器专项结果一致、root 全量测试通过、release controller `install` 通过；每个计划动作的注入失败均恢复、0000 哨兵未读未改，manifest digest/extra file、硬链接与 production override 门禁均保留。
- 结果：root 与真实 `fireside-build` 专项均 8/8，逐个动作失败注入全部恢复；完整 check 181/181、依赖漏洞 0。修复严格限于 fixture/test/spec，产品业务成熟度仍采用第 49/50 轮结论。
