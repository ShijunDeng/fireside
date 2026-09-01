# SPEC-008：叠层弹窗所有权、草稿与滚动锁

- 状态：`Accepted`
- 创建：2026-09-02
- 优先级：P1
- 关联：SPEC-003 第 12 轮、SPEC-004 FR-ACCESS-001 / 弹窗可访问性

## 1. 问题与目标

业务弹窗提交时若会话口令失效，页面会在原表单之上打开 AccessModal。当前每个 `useDialogA11y` 都注册独立的 document keydown，并分别保存/恢复 `body.style.overflow`。一次 Esc 会被两层监听器同时处理：AccessModal 和业务弹窗全部关闭，未提交草稿永久丢失；两个清理按各自拍摄值恢复，body 最终还可能保持 `overflow: hidden`，页面无法滚动。

Pixel 7 确定性基线：Esc 前为 2 个 dialog、底层 inert、草稿存在、焦点在口令输入；一次 Esc 后变为 0 个 dialog、草稿 DOM 消失、body 仍 hidden。目标是建立统一弹窗栈，让键盘、焦点、背景可交互性和滚动锁都有唯一所有者。

## 2. 弹窗栈不变式

### FR-DIALOG-001 唯一顶层所有权

- 每个挂载的 dialog 以唯一 token 注册到共享栈，卸载时只移除自己的 token；不得依赖 DOM 查询顺序或 React effect 清理顺序。
- 只有栈顶 dialog 可以处理 Escape、Tab / Shift+Tab 和初始焦点；非栈顶监听器必须完全忽略键盘事件。
- Escape 只调用一次栈顶 `onClose`，不得冒泡成底层关闭；按钮 X 与顶层 backdrop 也只关闭自身。
- 栈顶变化后，新的栈顶恢复键盘所有权；不要求重新挂载底层业务表单。

### FR-DIALOG-002 底层 inert 与可访问树

- 叠层存在时，所有非栈顶 dialog 都必须为 `inert`；焦点、点击和辅助技术导航不能进入底层控件。
- AccessModal 关闭后，底层 dialog 立即解除 inert，仍保持 `role=dialog` 和完整表单状态；栈顶内 Tab / Shift+Tab 循环，不得逃到 inert 底层或页面。
- 最终一个 dialog 关闭后，页面恢复可交互；不得遗留 inert 属性。

### FR-DIALOG-003 共享滚动锁

- 第一个 dialog 打开时记录 body 原始 inline overflow，并锁为 hidden；后续叠层只增加锁持有者，不覆盖原始值。
- 任一非最后 dialog 关闭时 body 继续 hidden；最后一个持有者关闭时才恢复首次记录的原值。
- 释放必须按 token 幂等，能承受 React StrictMode 的挂载/清理以及非 LIFO 异常卸载；计数不得为负，也不得恢复其他代码在首个弹窗前已有的值。

### FR-DIALOG-004 焦点恢复

- 每层打开时记录其真实触发焦点。AccessModal 从失效提交打开时，关闭后焦点回到底层原提交按钮或底层 dialog 内确定的可操作元素。
- 随后关闭底层业务弹窗，焦点才回到页面原触发按钮；若该元素因权威同步消失，使用既有 Topic 卡或议题区标题回退。
- 初始焦点始终落在栈顶的 `data-initial-focus` 或首个可操作控件；错误提示聚焦不得把焦点送入 inert 层。

## 3. 口令叠层操作逻辑

### 3.1 已提交写操作收到 401

1. 原业务弹窗、字段值、HTML 校验状态和冲突草稿继续挂载。
2. 清除失效 session key，打开 AccessModal，底层业务 dialog inert，body 保持锁定。
3. Esc、X 或点击 Access backdrop 只关闭 AccessModal；底层草稿原样保留、解除 inert、恢复焦点，用户可继续检查或关闭。
4. 输入正确口令只解锁并关闭 AccessModal，不自动重放刚才的 POST/PATCH/DELETE；用户确认草稿后再次显式提交，写请求才发生。
5. 错误口令保持 AccessModal 位于栈顶并聚焦错误/输入，底层不变化。

### 3.2 尚未打开业务弹窗时请求解锁

- 点击“发起 / 认领 / 报名 / 会议”等受保护入口时，AccessModal 是唯一 dialog。正确解锁后可执行原先尚未发出的 pending action 并打开目标弹窗；关闭解锁则放弃 pending action并回到触发点。
- 本规格区分“尚未执行的入口动作”与“已失败的写请求”：前者解锁后允许续接，后者禁止自动重放。

## 4. 实现边界

- 将弹窗栈、顶层判断和 body 锁集中在单一模块/Hook；`Modal`、`ParticipantsModal`、`PosterModal`、`MeetingModal`、`AccessModal` 继续复用同一入口。
- `onClose` 使用最新引用，注册 token 不应因父组件每次渲染重新排队或改变栈顺序。
- 不通过 `stopPropagation` 作为唯一防线；即使监听器注册顺序变化，非栈顶检查仍必须正确。
- 不将表单草稿复制到全局状态或 localStorage；保持底层组件挂载即可保留原生输入状态。
- 不自动重放失败写请求，不改变共享口令存储策略和服务端鉴权。

## 5. 验收矩阵

桌面 Chrome 与 Pixel 7 对创建、编辑或报名中的至少一个真实 401 叠层流程逐项验证：

1. 填写多字段草稿并让 session key 失效；提交后恰有 2 个 dialog，底层 inert，body hidden，焦点在 Access 输入。
2. 在 Access 内连续 Tab / Shift+Tab，焦点始终属于顶层；底层输入不可聚焦/点击。
3. 单次 Esc 后恰有 1 个业务 dialog；所有字段值与原校验状态不变，底层不再 inert，body 仍 hidden，焦点在底层提交按钮或确定回退点。
4. 再关闭业务 dialog 后为 0 个 dialog，body 恢复打开，焦点回页面触发器。
5. 分别用 X 和 Access backdrop 重复第 3 项语义；backdrop 点击 dialog 内容不得关闭。
6. 正确解锁后草稿仍在，并断言没有自动新增写请求；用户再次点击提交后才产生一次成功写入。
7. 错误口令仍为 2 层且不改变草稿；Access 错误可被读屏感知。
8. 单层业务/海报/会议弹窗的 Esc、Tab 圈、Blob 清理、冲突焦点和触发点恢复全部回归。

建议增加不依赖浏览器的滚动锁/栈纯逻辑测试，覆盖两个 token、乱序释放、重复释放与原始 overflow 为非空值；真实 DOM 行为仍以双端 E2E 为准。

## 6. 非目标

- 不在本轮实现周历报名入口或统一移动触控热区。
- 不修改 API 鉴权、Topic revision、活动阶段或数据模型。
- 不引入自动保存草稿、跨刷新恢复或长期登录。
- 不在本轮处理异常空 JSON 请求被通用错误处理升级为 500；该项已登记为后续 P2。

## 7. 完成条件

- 所有弹窗使用统一栈与共享滚动锁，叠层 401 场景满足草稿、焦点、inert 与滚动不变式。
- 桌面 Chrome、Pixel 7、纯逻辑测试、全部既有 API/E2E、TypeScript、生产构建和依赖审计通过。
- 生产部署后以浏览器或等价受控流程验证单层/叠层关闭，不输出生产口令；服务继续监听 `0.0.0.0:80`。
- 证据与提交回写迭代日志后，状态方可改为 `Accepted`。

## 8. 验收证据（2026-09-02）

- 实现提交：`d0d41b1`。五类弹窗统一注册唯一 token；共享栈集中管理顶层键盘所有权、底层 `inert`、body 滚动锁和逐层焦点恢复。
- 真实 401 跨端验收：桌面 Chrome 与 Pixel 7 共 6/6，通过 Esc、X、Access backdrop、内容点击、Tab / Shift+Tab、错误口令聚焦、草稿与错误保留、正确解锁不自动 POST、再次显式提交唯一成功及单层回归。
- 全量验证：60/60 单元、API、安全、并发、海报与弹窗栈测试通过；50 项桌面/移动 E2E 在 `--retries=0` 下通过，另 2 项按设备能力设计跳过；TypeScript、生产构建、差异检查和依赖漏洞审计（0 项）通过。
- StrictMode 注册—清理—重放、重复/乱序释放、非空原始 overflow 与无 DOM 环境均有确定性纯逻辑回归；旧清理的延迟焦点恢复不会越过重放后的新注册。
- 生产验证：systemd 重启后监听 `0.0.0.0:80`，健康页与首页均为 200；以无效会话口令对真实生产 API 触发只读 401 验收，确认 2→1→0 逐层关闭、底层草稿/焦点保留、body `visible→hidden→visible`，未产生生产议题数据。公网地址回环仍超时，继续受 SPEC-001 §9 的外部网络边界约束。
