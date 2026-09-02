# SPEC-037：主机安装器、固定目录与部署入口

- 状态：`Accepted`
- 创建：2026-09-02
- 优先级：P1
- 关联：SPEC-001、SPEC-009、SPEC-010、SPEC-020

## 1. 问题

`ops/install-release.sh` 只负责从已授权 commit 构建不可变 release，不是主机安装器。历史上首次准备、controller 固化、7 个 base systemd unit、HTTPS 目录/配置/unit 仍是文档中的数十条手工 `sudo install`；中断时容易留下混合状态，也没有单一的幂等验证入口。

历史操作文档还存在确定性矛盾：先把 `/etc/fireside-release` 设为 `root:root 0700`，又让普通用户从该目录读取 `.pub` 调用 `gh repo deploy-key add`，普通用户实际无法遍历该目录。不能通过放宽密钥目录解决。

## 2. 产品化安装结构

| 对象 | 固定位置 | 说明 |
| --- | --- | --- |
| 仓库安装包源 | `ops/host-installer/` | 打包器、dispatcher、安装逻辑和资产清单 |
| 生产固定 bundle | `/usr/local/libexec/fireside-host-installer/` | `root:root`，非 root 不可写，含完整 manifest 和 production marker |
| 单一入口 | `/usr/local/sbin/fireside-host-install` | 只转发到固定 bundle，不从 Git 工作树执行子脚本 |
| 安装状态 | `/var/lib/fireside-host-installer` | `root:root 0700`，只保留无敏感状态/回滚记录 |
| 互斥锁 | `/run/fireside-host-installer.lock` | root-only 单主机安装互斥 |

一次性 bootstrap 仅把已审阅的 bundle 复制到上述 root-owned 目录并安装 dispatcher；这是与 release controller 相同的显式信任边界。生产 dispatcher 必须验证固定路径、所有者/模式、production marker 与 bundle manifest，拒绝从工作树或可写 bundle 以 root 执行。

## 3. 命令与幂等边界

### 3.1 `check`

- 只读检查 Node、npm、Git、SSH、systemd、curl 和 Nginx；检查 80/443 监听冲突、现有账户/目录元数据和 unit 同名冲突。
- 输出稳定、无敏感的结果；不读口令正文或私钥。

### 3.2 `apply base`

- 缺失时创建无登录的 `fireside` / `fireside-build` 身份和 SPEC-010 固定目录；若已存在则严格核对 UID 类型、组、home、shell、所有者和模式，异常即停止，不删除重建、不递归 chown。
- 从已验 manifest 的 bundle 安装 release controller、production marker、known-hosts 资产与 7 个 base unit。安装前先在孤立位置执行 shell/Node 语法及 `systemd-analyze verify`，全部通过才原子替换并 `daemon-reload`。
- 第二次在相同健康状态执行不改变业务数据、release 指针或服务运行态。
- 本命令不自行 install/bootstrap/promote 任何 commit，不启动 80。

### 3.3 `apply https-layout`

- 只创建 `/etc/fireside-nginx`、`/etc/fireside-tls`、`/var/lib/fireside-https` 等固定目录，安装独立 Nginx 配置和 `fireside-https.service`。
- 安装后保持 HTTPS disabled/inactive，不搜索 home，不读取、复制或生成任何证书/私钥。

### 3.4 `verify base|https`

- 严格核对安装文件类型、单链接、owner/mode、manifest 内容和 unit 依赖；base 另检查 `/etc/fireside.env` 与专用只读 deploy key “存在且元数据正确”，不输出内容。
- HTTPS 活材料存在时才执行 `nginx -t` 与本机握手；不存在时明确报“布局已安装、待 TLS 材料”，不假报 HTTPS ready。

### 3.5 `activate base|https`

- base 只在 `fireside-release status` 证明 current 健康、写许可匹配后才 enable/start socket 和 backup timer；安装器不自行判断 bootstrap 还是 promote。
- HTTPS 只在独立 TLS 安装/轮换入口完成格式、SAN、有效期、信任链、公钥匹配、`nginx -t` 和本机握手后启动 443。base 与 HTTPS 互不启停。

## 4. 敏感与破坏性操作禁止

主机安装器绝不：

- 生成/上传 GitHub deploy key，调用 `gh` 或 token，或放宽私钥目录；公钥必须先在受控外部位置交给仓库管理者登记，再把私钥安装到 0700 目录。
- 创建、打印、通过命令行接收或改写围炉口令；只验证 `/etc/fireside.env` 是 `root:root 0600` 普通单链接文件。
- 搜索/复制 home 中的证书私钥，自动申请 ACME，修改 DNS、防火墙、安全组、HSTS 或 80 重定向。
- 自行选择 bootstrap/promote，迁移/恢复/删除数据库，改写 `current/previous`，删除旧 release/备份，停止未知服务或自动安装 OS 包。

TLS 材料安装属于 SPEC-020 的独立 `fireside-tls-install`：只接受操作者明确放入 root-owned staging 的两个普通单链接文件，先校验再 fsync + rename，失败恢复旧材料和服务状态，全程不输出私钥。

## 5. 验收

- `ops/host-installer/` 存在显式资产清单、bundle 打包器、dispatcher 与安装逻辑；打包输出不包含口令、token、证书或私钥。
- 无 root 测试在临时 fixture root 验证资产规划、首次与第二次 apply、异常 symlink/特殊文件/错 owner-mode 拒绝、失败回滚和 production override 拒绝。
- shell/Node 语法、bundle manifest、systemd unit 与 Nginx 配置通过；敏感路径使用不可读哨兵证明安装布局不打开它们。
- 生产运行手册主路径收口为：安装已审阅 root-owned bundle → `check` → `apply base` → 人工提供 env/已登记只读 key → `verify base` → 显式 release install + bootstrap/promote → `activate base`；HTTPS 独立走 `apply https-layout` → TLS install/rotate → `activate https`。
- 主机安装器测试必须在 root、本机普通身份和生产隔离 `fireside-build` 身份下保持同一结果。fixture 事务快照不得读取或改写计划外的 `0000` 哨兵正文；回滚只恢复本事务管理的路径与 fixture state，并逐个注入每个计划动作的失败点证明完整恢复，不得通过 root 绕过权限获得假通过。
- bundle digest 篡改用例必须显式以文件所有者可执行的模式转换完成篡改并恢复 `0444`，随后由 digest（不是写权限或 mode）拒绝；测试自身不能隐含要求 root 绕过只读位。

## 6. 回归证据

2026-09-02 已实现 `ops/host-installer/` 显式资产清单、manifest bundle、固定 dispatcher、base/https-layout 规划与事务 apply。HTTPS profile 同时安装不含材料的独立 TLS 安装入口；证书和私钥仍只能由操作者显式调用 SPEC-020 安装器导入。无 root fixture 测试 7 项通过，覆盖 bundle 篡改/额外文件、二次 apply 零动作、symlink/FIFO/错 owner-mode/硬链接、注入失败恢复和 production override 拒绝；HTTPS/TLS 联合专项共 12 项通过。生产运行手册主路径已收口到 host installer → 显式 env/key → release controller → TLS installer，公钥登记不再尝试穿越 0700 私钥目录。

当前主机已从 27 文件 manifest bundle 固化 `/usr/local/libexec/fireside-host-installer` 与 `/usr/local/sbin/fireside-host-install`；`check` 的 7 项依赖全部可用，`apply base` 只补建安装器状态目录，`apply https-layout` 为零动作，随后 base/HTTPS 双 `verify` 和双 `plan` 均收敛。80、443 与三项服务保持 active，本机可信 HTTPS 健康检查为 200。

第 51 轮生产候选门禁复现：隔离 build 用户运行同套测试时，`https-layout` 的 unreadable sentinel 快照和 manifest marker 篡改分别因 `EACCES` 失败；root 本地测试掩盖了两项测试基础设施权限假设。修复必须保持真实生产 owner/mode/manifest 门禁不放宽，并由非 root 定向测试、完整 check 与 controller install 共同验收。

修复验收：fixture 改为只回滚受管动作与虚拟 state，不再递归读取模拟主机；篡改夹具以最终 `0444` 的原子替换验证 digest。root 与真实 `fireside-build` 均 8/8，新增逐个计划动作的失败注入；完整 check 181/181、0 漏洞。生产 owner/mode/manifest、固定路径与非 root 构建门禁未放宽。

剩余边界：`activate` 仍由操作者在 release/TLS 健康验收后显式使用 systemd 命令，host installer 不擅自启动服务；`check` 当前覆盖依赖，端口冲突和完整在线握手由发布/TLS 安装器门禁负责。规格保持 Implementing，后续若收口统一 activate 命令须先扩展本规格。
