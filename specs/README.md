# Fireside 规格索引

本目录是项目需求、设计与验收的唯一事实来源（source of truth）。实现代码必须能够追溯到带编号的规格条目。

## Spec Driven Development 流程

每次迭代严格按以下顺序执行：

1. **Specify**：先新增或更新规格，明确范围、非目标、业务规则和验收标准。
2. **Design**：记录数据结构、API、交互与迁移方案；存在重要取舍时写入决策记录。
3. **Implement**：只实现已进入 `Ready` 或 `Implementing` 状态的规格。
4. **Verify**：运行与风险相称的自动化测试、生产构建和浏览器验收。
5. **Record**：将验证证据、已知限制和提交号回写规格，将状态更新为 `Accepted`。

修复生产 BUG 也必须先补充可复现条件和回归验收标准。紧急故障允许先止血，但必须在同一迭代补齐规格。

## 状态

- `Draft`：仍在澄清，不应开发。
- `Ready`：范围和验收标准明确，可以开发。
- `Implementing`：正在开发或验证。
- `Accepted`：实现和验收均完成。
- `Superseded`：已被新规格取代，保留用于追溯。

## 当前规格

| 规格 | 状态 | 内容 |
| --- | --- | --- |
| [SPEC-001](./SPEC-001-core-platform.md) | Accepted | 核心议题生命周期、视觉、站点身份与部署 |
| [SPEC-002](./SPEC-002-crud-sort-calendar.md) | Accepted | 完整 CRUD、持久化排序、月历与周历 |
| [SPEC-003](./SPEC-003-quality-loop.md) | Accepted | 独立 agent 持续审查与质量收敛循环 |
| [SPEC-004](./SPEC-004-end-to-end-collaboration.md) | Accepted | 端到端协作、参会、宣讲海报与公网写入边界 |
| [SPEC-005](./SPEC-005-topic-revision.md) | Accepted | 议题聚合版本、If-Match 并发保护与陈旧操作恢复 |
| [SPEC-006](./SPEC-006-poster-privacy-layout.md) | Accepted | 宣讲海报 Unicode 凭证脱敏、极限布局与最新快照生成 |
| [SPEC-007](./SPEC-007-activity-phase.md) | Accepted | 活动 UPCOMING / LIVE / ENDED 派生阶段与权威动作准入 |
| [SPEC-008](./SPEC-008-dialog-stack.md) | Accepted | 叠层弹窗唯一所有权、草稿保护、焦点与共享滚动锁 |
| [SPEC-009](./SPEC-009-auth-rate-limit.md) | Accepted | 口令抗猜测、短期协作令牌、生产密钥强度与失败关闭 |
| [SPEC-010](./SPEC-010-production-least-privilege.md) | Accepted | 非 root 服务、socket activation、私有状态、崩溃安全备份与门禁回滚发布 |
| [SPEC-011](./SPEC-011-calendar-participation.md) | Accepted | 产品操作逻辑、日历活动详情与参与闭环、导航和合理排版 |
| [SPEC-012](./SPEC-012-runtime-gate-directory-validation.md) | Accepted | 运行态门禁目录校验 |
| [SPEC-013](./SPEC-013-request-error-contract.md) | Accepted | 客户端请求解析错误的稳定状态码、安全反馈与零副作用 |
| [SPEC-014](./SPEC-014-reschedule-participant-notice.md) | Accepted | 有报名活动改期的影响确认与线下通知责任 |
| [SPEC-015](./SPEC-015-navigation-destination-layout.md) | Accepted | 吸顶任务导航落点、焦点、当前态与合理排版 |
| [SPEC-016](./SPEC-016-unicode-passphrase.md) | Accepted | UTF-8 围炉口令、六字符生产门槛与版本化浏览器传输 |
| [SPEC-017](./SPEC-017-mature-topic-delete-guard.md) | Accepted | 成熟议题永久删除门禁、生命周期纠错路径与并发恢复 |
| [SPEC-018](./SPEC-018-create-entry-auth-distinction.md) | Accepted | 发起议题与解锁协作入口分离、先写草稿再显式发布 |
| [SPEC-019](./SPEC-019-same-day-program.md) | Accepted | 同日单轨联场、排期防重叠、当日日程与海报场次上下文 |
| [SPEC-020](./SPEC-020-https-edge.md) | Implementing | `firesidechat.cn` 独立 HTTPS 入口、证书安装与正式轮换边界 |
| [SPEC-021](./SPEC-021-tablet-calendar-reachability.md) | Accepted | 平板月历/周历局部横向滚动与右侧日期可达性 |
| [SPEC-022](./SPEC-022-extreme-text-layout.md) | Accepted | 合法连续文本下的议题卡片、海报弹窗与移动布局边界 |
| [SPEC-023](./SPEC-023-unschedule-participant-notice.md) | Accepted | 取消排期/未举行前的报名影响快照、复制名单与线下通知确认 |
| [SPEC-024](./SPEC-024-ui-promise-and-recovery.md) | Accepted | 会议/报名页面承诺、筛选空态和 44px 恢复入口一致性 |
| [SPEC-025](./SPEC-025-claim-to-schedule-transition.md) | Accepted | 自荐发布/认领成功后的可选排期连续转场与恢复 |
| [SPEC-026](./SPEC-026-activity-detail-extreme-text.md) | Accepted | 活动详情合法极端文本的可收缩布局与跨端边界 |
| [SPEC-027](./SPEC-027-schedule-revision-recovery.md) | Accepted | 排期 412 冲突保留草稿、更新 revision 与显式重试 |
| [SPEC-028](./SPEC-028-unschedule-impact-state-sync.md) | Accepted | 取消影响首次读取 404/409 的失效确认关闭与状态同步 |
| [SPEC-029](./SPEC-029-archive-replay-context.md) | Accepted | 往期列表和详情中的原活动信息与本期收获完整上下文 |
| [SPEC-030](./SPEC-030-action-completion-focus.md) | Accepted | 业务操作成功后的权威快照合并与稳定回焦上下文 |
| [SPEC-031](./SPEC-031-global-navigation-hit-targets.md) | Accepted | 顶部品牌、页脚品牌与任务链接的 44px 全局导航触控边界 |
| [SPEC-032](./SPEC-032-cross-year-schedule-date.md) | Accepted | 列表与下一场按北京时间为跨年排期显示四位年份 |
| [SPEC-033](./SPEC-033-archived-chronology.md) | Accepted | 归档时间纠错的活动结束不晚于归档时刻不变量 |
| [SPEC-034](./SPEC-034-unschedule-next-step.md) | Accepted | 未来取消回准备中、结束未举行连续进入可选重新排期 |
| [SPEC-035](./SPEC-035-calendar-current-day-touch.md) | Accepted | 横向月历的今日可见定位与平板活动 44px 触控边界 |
| [SPEC-036](./SPEC-036-participant-mutation-recovery.md) | Accepted | 报名/取消写入成功后的本地名单权威结果与同步失败恢复 |
| [SPEC-037](./SPEC-037-host-installer.md) | Accepted | root-owned 主机安装 bundle、幂等 base/HTTPS 布局与显式部署激活 |
| [SPEC-038](./SPEC-038-authoritative-topic-mutation.md) | Accepted | 报名与生命周期 mutation 的权威 Topic revision/人数快照 |
| [SPEC-039](./SPEC-039-material-url-bound.md) | Accepted | 沉淀资料链接 2048 字符边界与零副作用拒绝 |
| [SPEC-040](./SPEC-040-readable-typography.md) | Accepted | 全站业务文字可读性下限、跨端字号层级与布局回归 |
| [SPEC-041](./SPEC-041-product-readme.md) | Accepted | 面向业务旅程的项目入口 README 与独立生产运行手册 |

历史与当前迭代记录见 [迭代日志](./iterations.md)。
