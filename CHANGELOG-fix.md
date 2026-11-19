---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 42e31703284e703932c6fac21371e0e2_5631c15fe3d711f1b35052540024e231
    ReservedCode1: pU7bhyfRDK9qwJ+Y6LKGGBa3uqihgKPdj7s93PkEIOULhfZe5w9V0GDkYn9A2C4NHfpLHBYtNienGyPAtGzhGhP9gZ/FX20aeMMAjsg8tOOzOGdcQSgicRHbR+soffXXnHv01Dj/B8OwmliKIW4QBJ05SQ3adg+kc7h9Cy2Yi9UqU8akRxxZ6XtpgBY=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 42e31703284e703932c6fac21371e0e2_5631c15fe3d711f1b35052540024e231
    ReservedCode2: pU7bhyfRDK9qwJ+Y6LKGGBa3uqihgKPdj7s93PkEIOULhfZe5w9V0GDkYn9A2C4NHfpLHBYtNienGyPAtGzhGhP9gZ/FX20aeMMAjsg8tOOzOGdcQSgicRHbR+soffXXnHv01Dj/B8OwmliKIW4QBJ05SQ3adg+kc7h9Cy2Yi9UqU8akRxxZ6XtpgBY=
---



# CHANGELOG-fix

改造日期：2026-11-19
基线：bigdata2211it-web/opencode-free-proxy `49488fd2`（v9，2026-05-18）

## 为什么改

1. **上游模型名单已变**：原版硬编码 5 个模型，其中 deepseek-v4-flash-free、minimax-m2.5-free、nemotron-3-super-free、qwen3.6-plus-free 已从上上游 /zen/v1/models 中消失，仅 big-pickle 仍在。原版会直接 400 Unknown model。
2. **匿名鉴权被收紧**：`Authorization: Bearer public` + 伪造 CLI 指纹头的调用现返回
   `429 FreeUsageLimitError: Free usage limit reached. Free models work in OpenCode`。
   这说明上游已按账号/额度控制，改请求头无法绕过，必须提供真实 OpenCode 账号凭证。
3. **缺少 Responses API**：仓库 issue #3 指出只支持 /v1/chat/completions，使用 Responses 格式的客户端（ZCode 等）会 404。

## 改动清单

| 文件 | 改动 |
|---|---|
| server.mjs | 新增 `ZEN_TOKEN`（env `OPENCODE_TOKEN`，默认 `public`）、`ZEN_HOST`（env） |
| server.mjs | 新增 `zenHeaders()`，统一构造上游指纹头 |
| server.mjs | `FALLBACK_MODELS` 替换为 2026-11 实测的 11 个 free 模型；`refreshModels()` 启动时从 `/zen/v1/models` 动态拉取 `-free` 模型（含 big-pickle），失败回退兜底名单 |
| server.mjs | 新增 `isModelAllowed()`，两处模型校验由 `MODELS.includes` 改为该函数 |
| server.mjs | 新增 `POST /v1/responses`：input/instructions → messages、tools 格式转换、非流式与流式（response.created / output_text.delta / response.completed 事件） |
| server.mjs | `/health` 增加 `upstream`（anonymous 或 token）与 `models_source` 字段 |
| server.mjs | 两个 429 错误体补充 “set OPENCODE_TOKEN...” 指引 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROXY_PORT` | 6446 | 监听端口 |
| `KEYS_FILE` | ./api-keys.json | 本地 API key 文件 |
| `OPENCODE_TOKEN` | public | 上游凭证。填自己的 OpenCode 账号 token 才会走真实额度 |
| `ZEN_HOST` | opencode.ai | 上游域名 |
| `MODELS` | 空 | 逗号分隔，强制指定模型列表（跳过动态拉取） |
| `ALLOW_ANY_MODEL` | 0 | 设 1 则放开模型白名单（需要账号有对应权限） |

## 实测结果（本机，匿名模式）

| 测试 | 结果 |
|---|---|
| GET /health | 200，12 个模型，upstream=anonymous(Bearer public) |
| GET /v1/models | 200，返回上游当前 12 个 free 模型（含新出现的 mimo-v2.6-flash-free） |
| POST /v1/chat/completions (big-pickle) | 429 rate_limit_error（上游限定，非代码问题） |
| POST /v1/responses (big-pickle) | 429 rate_limit_error，路由已生效（此前为 404） |
| POST /v1/chat/completions (gpt-6-sol) | 400 Unknown model，白名单生效 |
| 错误 API key | 401 authentication_error |

## 使用

```bash
npm install
OPENCODE_TOKEN=<你的 token> node server.mjs
# 或 PowerShell: $env:OPENCODE_TOKEN="xxx"; node server.mjs
```

不配 `OPENCODE_TOKEN` 时服务仍可跑，但对话请求会稳定 429——这是上游封匿名通道的结果，不是代理缺陷。

## 已知限制

- 流式 Responses 为“先取全文再分片推送”，首字延迟等于整条响应耗时；不支持 Responses 的工具调用往返。
- Anthropic 通道沿用原实现的转换逻辑，未做改动。
- 未做上游重试与多 key 轮转。
*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*
