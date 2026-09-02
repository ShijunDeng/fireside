# SPEC-039：沉淀资料链接长度边界

- 状态：`Accepted`
- 创建：2026-09-02
- 优先级：P2
- 关联：SPEC-002、SPEC-004、SPEC-013

## 1. 已复现

`meetingUrl` 已限制为 2048 字符，但归档与 PATCH 的 `materialUrl` 没有服务端上限，页面输入也无 `maxLength`。真实请求可保存 200,021 字符 URL，使单个公开 Topic 列表响应膨胀到约 200KB；多条记录会持续拖慢广场、日历与归档读取。

## 2. 规则

- `materialUrl` 去除首尾空白后最多 2048 个 Unicode code point，空串仍表示清除；沿用现有 HTTP(S) URL 校验。
- archive schema 与 PATCH schema 共享同一边界，不能只依赖页面；超长返回稳定 400，Topic、revision、归档状态、排序和名单均不改变。
- 归档/编辑表单对应输入设置 `maxLength=2048`，保留浏览器原生约束与服务端最终权威。
- 既有历史超长值不在读取时截断或破坏；协作者下一次修改该字段时必须提交合法值。

## 3. 验收

API 分别以 2048 字符合法 URL 和 2049 字符 URL 覆盖 archive/PATCH；前者保存，后者 400 且零副作用。桌面与 Pixel 7 输入 DOM 具有 2048 上限，正常资料打开与历史回顾不回退。

## 4. 回归证据

2026-09-02：archive/PATCH 均验证 2048 字符可保存、2049 字符稳定 400 且 Topic/revision/状态/名单零副作用；归档和编辑输入均暴露 `maxLength=2048`。180 项 `npm run check` 与完整跨端 E2E（123 通过、5 项职责跳过）通过。
