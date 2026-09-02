# SPEC-020：`firesidechat.cn` 独立 HTTPS 入口与证书轮换

- 状态：`Implementing`
- 创建：2026-09-02
- 优先级：P0
- 关联：SPEC-001 部署、SPEC-009 认证限流、SPEC-010 生产最小权限与可恢复发布

## 1. 背景与确定性基线

业务应用当前由 systemd socket activation 直接监听 `0.0.0.0:80`，生产 Node 进程不持有低端口 capability。HTTPS 应作为独立反向代理入口增加，不能把证书读取、TLS 生命周期或 Nginx 配置混入业务 release，也不能中断现有 HTTP 入口。

2026-09-02 的只读检查与域名决策：

- 用户明确将生产域名切换为 `firesidechat.cn`，`fireside.show` 已弃用。配置、证书主机名校验和验收不得继续接受旧域名。
- 公网域名 `firesidechat.cn` 的 A 记录解析为 `47.98.209.189`，与本机公网地址 `166.108.239.81` 不一致；在 DNS 改指或 `47.98.209.189` 明确转发 TCP 443 前，本机即使成功监听 443，公网用户访问该域名也不会到达本机。
- 刷新后的 `/home/dsj/xx.xx` 是 PEM 完整证书链：叶证书 SAN 为 `DNS:firesidechat.cn`、`DNS:www.firesidechat.cn`，有效期为 2026-09-02 00:00:00 UTC 至 2027-03-19 23:59:59 UTC，后附 RapidSSL/DigiCert 链。
- `/home/dsj/key.key` 是与叶证书公钥匹配的 PEM RSA 私钥，输入权限为 0600。两个源文件只能作为短期导入材料；安装后可以由用户删除，运行服务不得依赖其路径。
- 用户明确授权这组材料仅用于 HTTPS 测试，正式环境会轮换。证书请求（CSR，`BEGIN CERTIFICATE REQUEST`）本身不能作为 HTTPS 服务端证书；只有已由 CA 签发、与私钥匹配且覆盖域名的证书链可以使用。
- 系统级 Nginx 主配置会加载 `/etc/nginx/conf.d/*` 和 `/etc/nginx/sites-enabled/*`；其中既有站点可能监听 80，因此 HTTPS 入口不能启动该主配置。

## 2. 目标与非目标

### 2.1 目标

1. 在 TCP 443 提供 `https://firesidechat.cn`，反向代理至本机 `127.0.0.1:80`；证书覆盖的 `www.firesidechat.cn` 只做保留路径与查询串的 308 规范化跳转。
2. 保留现有 TCP 80 服务和 socket activation；TLS 启停、失败与回滚均不得改变业务 release、SQLite 或 80 入口。
3. 使用不加载系统既有 virtual hosts 的独立 Nginx 主配置和独立 systemd unit。
4. 私钥以 root-only 0600 落盘，并通过 systemd credential 只在 HTTPS 服务生命周期内提供给非 root Nginx。
5. 支持证书/私钥原子轮换，先验证再切换；失败恢复上一组材料。

### 2.2 非目标

- 本轮不把 80 重定向到 443；HTTP 是明确保留的兼容和回滚入口。
- 本轮不申请、续签或自动化 ACME 证书，也不把临时证书或私钥提交 Git。
- 本轮不修改业务 API、前端、SQLite、发布控制器或 80 socket。
- 本轮不启用 HSTS；临时测试和可独立回滚优先，避免客户端在 443 撤回后被长期强制到 HTTPS。

## 3. 部署结构

| 对象 | 固定位置 | 权限/身份 | 说明 |
| --- | --- | --- | --- |
| 独立 Nginx 配置 | `/etc/fireside-nginx/nginx.conf` | `root:root 0644`，父目录 0755 | 完整 main config，不 include `/etc/nginx/nginx.conf`、`conf.d` 或 `sites-enabled` |
| 证书链 | `/etc/fireside-tls/fullchain.pem` | `root:root 0644`，父目录 0700 | 公共证书材料，仍与私钥同目录隔离 |
| 私钥 | `/etc/fireside-tls/privkey.pem` | `root:root 0600` | Nginx 不直接以 www-data 打开此路径 |
| HTTPS unit | `/etc/systemd/system/fireside-https.service` | `root:root 0644` | 与系统 `nginx.service` 分离 |
| 运行凭据 | `/run/credentials/fireside-https.service/*` | systemd 管理 | `LoadCredential=` 在服务启动时复制，非 root 服务只读 |
| Nginx 状态/运行目录 | `/var/lib/fireside-https`、`/run/fireside-https` | `www-data:www-data` | 仅代理临时文件和 pid |

## 4. 功能与安全要求

### FR-TLS-001 独立 443 监听

- `fireside-https.service` 只能执行 `nginx -c /etc/fireside-nginx/nginx.conf`，不得启动发行版默认 `nginx.service`。
- 独立配置只能声明 IPv4/IPv6 的 443 listener；不得声明 80 listener，也不得加载任何可扩展 virtual-host 目录。
- `server_name` 只列 `firesidechat.cn` 与 `www.firesidechat.cn`。`www` 请求以 308 跳转到同路径、同查询串的 `https://firesidechat.cn`；其他 Host 返回 421，不代理到业务应用，`fireside.show` 作为弃用域名同样返回 421。
- upstream 固定为 `http://127.0.0.1:80`，不得由请求头、环境变量或 DNS 改写。

### FR-TLS-002 TLS 基线

- 只允许 TLS 1.2 和 TLS 1.3；禁用 TLS 1.0/1.1。
- 使用服务器证书链而非 CSR，私钥必须能由 OpenSSL 解析，叶证书必须覆盖 `firesidechat.cn`、处于有效期内且证书/私钥公钥一致。
- 代理响应带 `X-Content-Type-Options: nosniff` 和 `Referrer-Policy: strict-origin-when-cross-origin`；本轮不发送 HSTS。
- 转发原始 Host，并设置 `X-Forwarded-Proto=https`、`X-Forwarded-For` 与 `X-Real-IP`。业务服务仍不信任任意客户端伪造的转发头；在单机回环代理下，现有应用级认证限流对 HTTPS 来源表现为共享的 fail-closed 桶，不能把这一临时限制描述成来源级精确识别。永久化反向代理前须另行规格化“仅信任回环代理”的来源解析。

### FR-TLS-003 最小权限

- Nginx 以 `www-data:www-data` 启动，仅持有绑定 443 所需的 `CAP_NET_BIND_SERVICE`；启用 `NoNewPrivileges`、只读系统、私有临时/设备、内核保护及最小地址族。
- systemd 用 `LoadCredential=` 读取 root-only 证书和私钥；Nginx 配置引用运行时 credential 路径，不将 `/etc/fireside-tls/privkey.pem` 放宽为 www-data 可读。
- 私钥安装目标必须是普通文件、单链接、`root:root 0600`；证书与配置必须是普通文件、单链接且不可由非 root 修改。
- 输入文件不得是符号链接或特殊文件，且必须为 root-owned、单链接；私钥源必须为 0600。不得在日志、终端、测试快照、Git diff 或错误消息中输出私钥、哈希或正文片段。

### FR-TLS-004 原子安装与轮换

1. 安装器仅能从预先复制到固定 root-owned、非 group/world-writable 路径的脚本和模板运行；不得让 root 直接执行开发用户可写工作树中的脚本。
2. 在 root-only 临时目录规范化输入 PEM（仅移除 CR 与每行前导空白），然后完成解析、有效期、`firesidechat.cn` 主机名、系统信任链及公钥匹配验证。
3. 新材料先写同文件系统临时文件并 fsync，再以 rename 替换。替换前保存上一组材料和配置的 root-only 临时副本。
4. 使用独立配置执行 `nginx -t`。首次安装启动 `fireside-https.service`；轮换使用 restart，使 systemd 重新装载 credential。
5. 配置检查、daemon-reload、启动/restart 或本地 TLS 健康检查任一步失败，必须恢复上一组文件并恢复原 service 状态；首次安装失败则停止新 unit，80 服务继续可用。重启后的健康检查允许最多 5 秒有限就绪等待，不能因第一个瞬时连接拒绝误判失败，也不能无限等待。
6. 成功后清除临时副本；任何路径都不得删除用户业务状态或 release。

### FR-TLS-005 请求语义

- `/api/health`、静态页面、公开读取、认证与写入均经同一反向代理，不做路径重写。
- 请求体由业务应用继续执行既有 1 MiB/媒体类型契约；Nginx 不用自定义 HTML 413 提前替换 API 错误。
- WebSocket upgrade 不是当前业务依赖；配置不伪造 Connection/Upgrade。
- HTTPS 入口失败不影响直接访问 `http://166.108.239.81/` 或现有公开 HTTP URL。

## 5. DNS、公网与验收

### AC-TLS-001 静态和无特权验收

1. 自动化断言配置仅含 443，不含 `listen 80`，且不 include 系统 Nginx 配置或 virtual-host 目录。
2. 自动化用临时自签名证书渲染等价配置并运行 `nginx -t`，不读取生产私钥。
3. 自动化断言 TLS 版本、固定 upstream、Host 拒绝、systemd credential、0600 私钥安装规则与 sandbox 指令。
4. Shell 语法检查通过；仓库和构建输出中不存在 PEM 私钥头。

### AC-TLS-002 本机安装后验收

1. `systemctl is-active fireside.socket fireside.service fireside-https.service` 均成功；`ss` 同时显示 `0.0.0.0:80` 和 `*:443`。
2. `curl --resolve firesidechat.cn:443:127.0.0.1 https://firesidechat.cn/api/health` 返回 200；主页返回 200；`www` 返回保持路径/查询串的 308；错误 Host 与弃用域名 `fireside.show` 返回 421。
3. `openssl s_client -connect 127.0.0.1:443 -servername firesidechat.cn` 验证证书链和域名；TLS 1.2、1.3 成功，TLS 1.0、1.1 失败。
4. `/etc/fireside-tls/privkey.pem` 与获授权的输入源均为 0600，证书和私钥仍匹配；命令输出和 journal 不含私钥正文。
5. HTTPS 验收只做健康、公开读取与认证状态读取，不写业务数据；80 的相同只读请求继续为 200。

### AC-TLS-003 公网域名验收

必须先满足以下网络条件之一：

- 把 `firesidechat.cn` 的 A/AAAA 记录改指实际入口 `166.108.239.81`；或
- 在当前 DNS 目标 `47.98.209.189` 上建立明确、可审计的 TCP 443 转发到本机，并确保返回当前证书。

同时开放入口防火墙、安全组和 NAT 的 TCP 443。DNS 生效后，必须从本机之外验证：

1. 解析地址等于获批准入口；
2. `https://firesidechat.cn/` 和 `/api/health` 返回 200，无证书告警、无重定向循环；
3. 证书 SAN 覆盖 `firesidechat.cn`，链受公共信任且未过期；
4. HTTP 80 仍可访问；
5. 公网 HTTPS 写入只在持有有效协作会话时成功，未认证请求仍失败关闭。

DNS 未修正时，只能宣布“本机 443 与证书握手通过”，不得宣布 `https://firesidechat.cn` 已公网发布。

## 6. 回滚与轮换手册

### 6.1 HTTPS 入口回滚

- 停止并禁用 `fireside-https.service` 即撤回 443；不得停止 `fireside.socket` 或 `fireside.service`。
- 若需要恢复上一张证书，使用安装器保存的上一组 root-only 材料恢复并 restart HTTPS unit；恢复后重复本机握手和健康检查。
- 若 DNS 已指向本机但 443 暂时撤回，应同步回滚 DNS/转发；因为本轮未启用 HSTS，客户端仍可显式使用保留的 HTTP 入口。

### 6.2 正式证书轮换

- 正式材料必须是覆盖 `firesidechat.cn` 的完整证书链和匹配私钥，走同一安装器，不手工覆盖 live 文件。
- 轮换不要求重建或发布业务 commit；成功后记录证书序列号、有效期和部署时间，但不记录私钥内容或指纹。
- 到期监控和 ACME 自动续签在正式域名入口稳定后单独规格化；临时证书不据此声称具备无人值守续签能力。

## 7. 验收状态

- 规格：已建立。
- 输入证书链、SAN、有效期与密钥匹配：只读验证通过。
- 独立配置、systemd unit 与无特权自动化：已实现；3 项 HTTPS 专项测试通过，包括临时证书的真实 `nginx -t`。首次真实启动发现 hardened unit 的私有 `/dev` 不能打开 `/dev/stdout`，配置已改为关闭边缘访问日志、保留 stderr 错误日志，并补回归断言。
- 证书原子轮换安装器：已实现为固定 root-owned `/usr/local/sbin/fireside-tls-install`，源码位于 `ops/tls-installer/` 并纳入 host installer 的 HTTPS profile。专项测试覆盖固定入口、锁、来源元数据、SAN/有效期/信任链/密钥匹配、原子替换、有限就绪等待与失败恢复；仓库忽略常见 TLS 材料扩展名。
- 本机 443 安装：已验收。获授权输入已规范化复制为 `/etc/fireside-tls/fullchain.pem` 与 `/etc/fireside-tls/privkey.pem`，私钥与源文件均为 0600；用户可删除源文件，运行态不依赖 home。`fireside.socket`、`fireside.service`、`fireside-https.service` 同时 active，IPv4/IPv6 443 与 IPv4 80 同时监听。
- 本机 TLS：主页与 `/api/health` 经可信 `--resolve firesidechat.cn:443:127.0.0.1` 返回 200，系统信任链与主机名校验为 0；`www` 同路径/查询串返回 308 到裸域名，弃用的 `fireside.show` 返回 421；HTTP 80 健康检查仍为 200。
- 公网域名：`firesidechat.cn` 被 DNS 当前指向 `47.98.209.189` 阻塞，待改指或转发后验收。
