# SPEC-012：运行态门禁目录校验

- 状态：`Accepted`
- 创建：2026-09-02
- 最后更新：2026-09-02

## 1. 问题

生产发布在恢复旧版本时，`fireside-runtime-gate.service` 会调用 `prepare_runtime_root`。旧实现把 `/run/fireside-runtime` 的目录硬链接数写死为 `1`；Linux 上不含子目录的真实目录链接数通常为 `2`，因此合法目录被拒绝，服务启动失败并留下 `reverting` 事务。

这会让一次本应自动回退的发布变成端口仍监听但应用无法启动的服务不可用，优先级为 P0。

## 2. 需求

- 运行态根必须是非符号链接的真实目录。
- 生产环境必须校验其所有者为 `root:root`、权限为 `0755`。
- 不得把目录硬链接数固定为任一值；目录链接数会随文件系统和直接子目录数量变化，不是安全身份。
- `release-active`、`writes-enabled`、事务等固定普通文件继续要求单链接，不能放宽文件防替换约束。
- 门禁失败后的人工或 watchdog 恢复必须能重建 runtime selector/write permit、清理事务并启动健康的原版本。

## 3. 验收

1. 正常 `root:root 0755` 运行态目录（链接数为 2 或因子目录增加）通过门禁。
2. 符号链接、非目录、错误 owner/group 或 group/world writable 目录被拒绝。
3. 现有发布控制器故障注入测试全部通过。
4. 在真实 systemd 门禁中恢复当前 `reverting` 事务，旧版本健康恢复；随后新候选正常 promote，`current`、runtime selector、write permit 和健康接口指向同一提交。

## 4. 实现与验证

- `prepare_runtime_root` 先要求非符号链接真实目录，再校验 `root:root 0755`；不再读取目录链接数。
- `release-active`、`writes-enabled`、事务和健康标记的普通文件单链接约束保持不变。
- 49 项发布控制器故障注入测试通过；全量 `npm run check` 为 145 项测试、类型检查和生产构建通过。
- 真实故障事务已恢复到 `b15bdf5`，验证 journal clean、selector/write permit 重建、服务健康；修复提交 `7582f3c` 随后成功 promote。
- 生产 `current`、进程 cwd、`/api/health.releaseCommit` 均为 `7582f3c0fdefce30664fe778f6ea59f9c73ff0b5`；服务以 `fireside` UID 运行，socket 监听 `0.0.0.0:80`，公开转发地址健康返回同一提交。
