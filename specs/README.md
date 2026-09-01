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
| [SPEC-003](./SPEC-003-quality-loop.md) | Implementing | 独立 agent 持续审查与质量收敛循环 |
| [SPEC-004](./SPEC-004-end-to-end-collaboration.md) | Implementing | 端到端协作、参会、宣讲海报与公网写入边界 |
| [SPEC-005](./SPEC-005-topic-revision.md) | Accepted | 议题聚合版本、If-Match 并发保护与陈旧操作恢复 |
| [SPEC-006](./SPEC-006-poster-privacy-layout.md) | Accepted | 宣讲海报 Unicode 凭证脱敏、极限布局与最新快照生成 |
| [SPEC-007](./SPEC-007-activity-phase.md) | Accepted | 活动 UPCOMING / LIVE / ENDED 派生阶段与权威动作准入 |
| [SPEC-008](./SPEC-008-dialog-stack.md) | Ready | 叠层弹窗唯一所有权、草稿保护、焦点与共享滚动锁 |

历史与当前迭代记录见 [迭代日志](./iterations.md)。
