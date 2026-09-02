# SPEC-033：归档活动的历史时序不变量

- 状态：`Accepted`
- 创建：2026-09-02
- 优先级：P2
- 关联：SPEC-002、SPEC-005、SPEC-007、SPEC-019、SPEC-029

## 1. 已复现

`ARCHIVED` 按 SPEC-002 允许纠正历史时间与时长，但 PATCH 的时间校验只覆盖 `SCHEDULED`。已于 2030-01-01 02:00 归档的活动可被改到 2031 年并返回 200，形成 `scheduledAt > archivedAt` 的“先归档、后举行”；公开日历会显示未来归档，撤销归档后又直接成为未来活动。

## 2. 产品决策

- 保留归档纠错能力：协调者可以修正历史开始时间和时长，不要求先撤销归档，避免为单纯录入错误改变已沉淀状态。
- 归档时序必须满足半开活动区间的结束时刻 `scheduledAt + duration <= archivedAt`；恰好在归档时刻结束允许，任何开始/结束落到归档之后都拒绝。
- `archivedAt` 是该次归档的权威时序上界，不能用请求时的当前时钟替代；这样历史纠错在以后仍得到稳定结果。
- 页面在归档编辑区明确说明该上界并保持时间/时长可编辑；服务端仍是唯一权威门禁。

## 3. API 与并发

- PATCH 在既有目标、If-Match、状态和 schema 优先级之后，使用候选 `scheduledAt / duration` 与当前未修改值组合校验完整区间。
- 权威校验必须在同一个 `BEGIN IMMEDIATE` 写事务内再次读取 `status / revision / archivedAt` 后执行，不能只依赖事务外预检。
- 无效历史数据返回 `400 ACTIVITY_TIME_INVALID`；候选结束晚于归档时刻返回 `409 ACTIVITY_TIME_CONFLICT`，不修改 Topic、revision、排序或参与名单。
- 陈旧 revision 即使携带违法时间也仍优先返回 `412 TOPIC_REVISION_CONFLICT`；状态并发变化继续返回既有 `409 TOPIC_STATE_CONFLICT`。
- 本轮不改变未来 `SCHEDULED` 的未来时间/单轨重叠门禁，也不修改 `archivedAt`。

## 4. 验收

API 覆盖合法历史纠错、结束恰好等于 archivedAt、开始移到未来、时长扩张越界、非法归档基线和陈旧 revision；所有拒绝零副作用。桌面与 Pixel 7 的归档编辑表单中时间/时长可编辑，显示归档上界说明，合法保存后仍为 `ARCHIVED` 并显示修正日期。全量 check 与 E2E 通过。

## 5. 回归证据

待实现后回写。
