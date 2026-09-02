# SPEC-013：客户端请求错误契约

- 状态：`Ready`
- 创建：2026-09-02
- 最后更新：2026-09-02

## 1. 用户问题

协作者使用有效会话提交议题时，空/截断 JSON、不支持的媒体类型或超过服务上限的请求会被全局错误处理器统一改写成 `500` 和“请稍后再试”。这些错误不会通过等待恢复，用户会被误导为重复提交；旧客户端或弱网络下尤其明显。

独立审计已确定性复现：

| 输入 | Fastify 错误 | 旧响应 | 正确语义 |
| --- | --- | --- | --- |
| JSON Content-Type + 空 body | `FST_ERR_CTP_EMPTY_JSON_BODY` | 500 | 400 |
| 截断/畸形 JSON | `FST_ERR_CTP_INVALID_JSON_BODY` | 500 | 400 |
| `application/xml` | `FST_ERR_CTP_INVALID_MEDIA_TYPE` | 500 | 415 |
| body 超过默认 1 MiB | `FST_ERR_CTP_BODY_TOO_LARGE` | 500 | 413 |

四条路径均未写入 Topic，但错误反馈违反 SPEC-011 已登记的 `400 / 413 / 415` 页面/API契约。

## 2. 错误契约

有效协作会话下：

- 空或畸形 JSON：`400 { code: "INVALID_JSON_BODY", message: "提交内容不是有效的 JSON，请检查后重试" }`。
- 不支持的媒体类型：`415 { code: "UNSUPPORTED_MEDIA_TYPE", message: "提交格式不受支持，请使用 JSON" }`。
- 请求体超过限制：`413 { code: "REQUEST_BODY_TOO_LARGE", message: "提交内容过大，请精简后重试" }`。
- 不回显原始 payload、口令、会话令牌或 Fastify 内部异常文本。
- 未识别的程序异常继续返回通用 `500`，并记录服务端错误日志。

认证优先级保持不变：无效/缺失会话叠加上述任一解析错误时仍先返回 `401 ACCESS_SESSION_REQUIRED`，不能借解析错误探测受保护路由。

## 3. 数据不变式

所有解析拒绝路径必须在业务 handler 前终止，且 Topic 行、revision、position、手动排序版本和参与名单均保持不变。客户端可安全修改输入后重试，但服务端不得把失败请求部分执行。

## 4. 验收

1. 使用有效会话分别验证空 JSON、畸形 JSON、错误媒体类型和超大 body 的精确状态码、code 与安全文案。
2. 验证错误前后的完整公开 Topic 列表、revision/position、`X-Order-Version` 和参与名单一致。
3. 无效会话叠加畸形 JSON 和超大 body 仍为 401。
4. 无 body 的 DELETE 若错误携带 JSON Content-Type 返回 400，正确 DELETE 不携带该头仍按业务语义成功。
5. 注入未知内部异常时继续为安全的 500，且 logger 收到错误；客户端响应不含异常正文。
6. 全量单元/API、类型检查、生产构建和桌面/移动浏览器回归继续通过。
