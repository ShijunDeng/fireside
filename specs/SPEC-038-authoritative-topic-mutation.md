# SPEC-038：报名与生命周期 mutation 的权威 Topic 快照

- 状态：`Accepted`
- 创建：2026-09-02
- 优先级：P1
- 关联：SPEC-004、SPEC-005、SPEC-030、SPEC-036

## 1. 已复现

1. 有 1 人报名的议题执行 PATCH、归档或撤销归档时，服务端直接把 `UPDATE ... RETURNING *` 交给 Topic 映射；结果缺少 `participant_count`，被默认成 0。事务后 GET 仍是 1，成功响应不是权威快照，后续刷新失败会把错误人数留在页面。
2. 报名 POST 201 / 取消 DELETE 204 会把 Topic revision 加 1，但响应只有 Participant 或空正文，客户端的新 revision 完全依赖后续 Topic GET。若名单与 Topic 两类 GET 均暂时失败，页面虽知道报名成功，却持有必然过期的 If-Match，下一次编辑/取消排期/归档必定 412。

## 2. 协议与事务规则

- 所有返回 Topic 的 mutation 必须在同一写事务内重新读取 `topics.* + participant_count`，再提交并返回；不得把不含聚合列的 RETURNING row 伪装成完整 Topic。
- Topic 映射收到缺失或非法 `participant_count` 时应失败，而不是静默回退 0；0 必须来自真实聚合结果。
- 报名 POST 保持 201 与 Participant 正文，取消保持 204；两者在响应头返回同一事务产生的强 `ETag: "<revision>"` 与十进制 `X-Fireside-Participant-Count`。响应头缺失/非法时客户端把它视为协议失败，不虚构 revision。
- 客户端收到成功响应后立即把 revision 与人数合并到列表、活动详情、名单、海报与会议快照；后续精确/列表 GET 只做并发校正。双 GET 失败后，使用新 revision 的下一项 If-Match 生命周期操作仍应成功。
- mutation 只增加一次 revision；拒绝与解析失败零副作用。响应元数据不得包含名单姓名、会议入口或口令。
- 客户端的所有同 ID Topic 投影必须按 revision 单调合并：`incoming.revision < current.revision` 一律忽略；相等或更大才可校正。该规则覆盖 mutation、精确 GET、列表 GET、报名名单读取及活动/名单/海报/会议快照，不能依赖各请求各自的 generation。
- 完整 `GET /participants` 必须在同一个只读事务快照读取 Topic revision 与名单，通过强 `ETag` 和 `X-Fireside-Participant-Count` 返回；正文长度、人数头和 revision 必须一致。客户端据此同时传播 revision/count，不再只校正人数。
- 完整 Topic 列表 GET 对“成员集合”权威：响应缺失的本地 ID 必须移除；只在响应与本地共同 ID 上使用 revision 单调合并。`preserveExisting` 只表示读取失败时不清空已知结果，不能在成功响应后把所有缺失本地项重新拼回。mutation 响应保护只允许针对本次明确 ID，不得制造跨协作者已删除的幽灵卡片。
- 打开的参与名单也是 Topic revision 的派生快照：父级同步到更高 revision 时必须使名单失效并重读。若新版状态从 `SCHEDULED` 回退为 `CLAIMED/OPEN`，取消排期已原子清空名单，弹窗必须关闭并说明“排期已取消、报名已清空”；不得把旧姓名改称历史回顾。进入 `ARCHIVED` 则重读后保留真实冻结名单。
- 派生名单对外部更高 revision 的校正必须在请求前进入未知态；失败时旧 revision 行不可继续作为完整/可操作名单，成功时才把正文、ETag 和 count 原子确认为新快照。弹窗自身 mutation 返回的 revision 先标记为已覆盖，避免自触发重复刷新。

## 3. 验收

1. API 对保留 1 人报名的普通编辑、改期、归档、撤销分别断言响应 `participantCount=1` 且与事务后 GET 完全一致。
2. 排期 revision 2 后报名得到 revision 3/count 1 响应头；阻断后续 participants、精确 Topic 和列表 GET，客户端仍显示 1 人并可直接用 revision 3 成功执行一个允许的 If-Match 操作。取消报名同理返回下一 revision/count 0。
3. 缺少聚合的内部行不能被映射成权威 Topic；全量类型、API、桌面与 Pixel 7 回归通过。
4. 让精确 Topic GET 在服务端读到 revision 2 后延迟，报名 201/ETag 3 先完成，再放回旧响应；全部快照仍为 revision 3/count 1，下一项 If-Match 操作成功。列表中的同 ID 旧 revision 同样不得覆盖新投影。
5. 外部协作者再报名推进到 revision 4/count 2，完整 participants GET 原子返回 ETag 4/count 2，页面同步到全部视图；迟到 revision 3 响应不得回退。
6. 客户端 A 先看到 X，客户端 B 删除 X；A 成功发布 Y 后收到不含 X 的完整列表，页面必须移除 X 并保留 Y。同 ID 低 revision 仍不得覆盖，列表 GET 失败仍保留 mutation 已知结果。
7. A 打开含 2 人的报名弹窗，B 以最新 revision 取消排期并清空名单；A 同步到 `CLAIMED` 后弹窗关闭、卡片为准备中并提示名单已清空，页面不存在旧姓名。若只发生外部报名/归档等更高 revision，名单按新 revision 重读且迟到旧读取不能覆盖。

## 4. 回归证据

2026-09-02 初次验收：API 覆盖编辑、归档、撤销归档的真实报名聚合，报名 POST/DELETE 的强 ETag 与人数头，以及 2048/2049 等相邻边界；180 项 `npm run check` 通过。桌面与 Pixel 7 覆盖名单/Topic 双 GET 失败后继续用 mutation 返回的新 revision 编辑，以及完整名单读取传播人数；完整 E2E 123 通过、5 项按设备职责跳过、0 失败/重试。

第 32 轮领域审计确定性复现迟到 revision 2 精确 GET 覆盖报名成功 revision 3；并确认完整 participants GET 无 ETag，外部报名 revision 4/count 2 无法原子传播。本规格重新进入 Implementing，完成全通道 revision 单调门禁后回写终验。

终验：participants GET 在同一只读事务返回正文、强 ETag 和人数头；客户端严格校验并同时传播 revision/count。列表、精确读取、mutation 与各弹窗快照只接受同 ID 相等或更高 revision；延迟 rev2 到报名 rev3 后仍保持 1 人，下一 PATCH 携带 `If-Match: "3"` 并成功。180 项 `npm run check`、桌面/Pixel 7 定向 4/4 与完整 E2E 127 通过、5 项职责跳过。

第 33 轮领域审计复现成功完整列表被错误当作增量：服务端已删除的其他 ID 被 `preserveExisting` 拼回并永久成为幽灵卡。成员集合权威规则补入后，本规格重新进入 Implementing。

第 34 轮领域审计复现打开名单期间同步到取消排期后的 `CLAIMED` revision，父 Topic 已更新但弹窗仍显示已被事务删除的 2 个姓名。本规格继续保持 Implementing，补齐弹窗派生快照失效规则。
