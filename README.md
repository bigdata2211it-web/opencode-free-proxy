> **2026-11-19 本地修复版（v9-fix1）**
> 上游 `opencode.ai/zen` 已收紧匿名通道：`Authorization: Bearer public` 现在返回 `429 FreeUsageLimitError`，且原版硬编码的 5 个模型中 4 个已下架。
> 本次改动：动态模型白名单 / `OPENCODE_TOKEN` 凭证注入 / 新增 `POST /v1/responses` / 429 错误带配置指引。详见 `CHANGELOG-fix.md`。

# opencode-free-proxy

Free AI models from [OpenCode](https://opencode.ai) exposed as standard OpenAI and Anthropic APIs.

One server — works with any tool that speaks OpenAI or Anthropic format: Cursor, Continue, Cline, Claude Code, aider, opencode CLI, raw `curl`, whatever.

## 30-second setup

```bash
git clone https://github.com/bigdata2211it-web/opencode-free-proxy.git
cd opencode-free-proxy
npm install
node server.mjs
```

Done. Server is at `http://localhost:6446`. API keys are in `api-keys.json` (auto-generated on first run).

## What you get

| Model | What it is | Reliability |
|-------|-----------|-------------|
| `deepseek-v4-flash-free` | DeepSeek V4 Flash | Solid |
| `big-pickle` | DeepSeek V4 Flash (alias) | Solid |
| `minimax-m2.5-free` | MiniMax M2.5 | Solid |
| `nemotron-3-super-free` | NVIDIA Nemotron 3 Super | Hit or miss |
| `qwen3.6-plus-free` | Qwen 3.6 Plus | Intermittent |

All models support streaming, tool calls, and system messages.

## API

### OpenAI format — `POST /v1/chat/completions`

```bash
curl http://localhost:6446/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### Anthropic format — `POST /v1/messages`

```bash
curl http://localhost:6446/v1/messages \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-free",
    "system": "You are helpful.",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1024,
    "stream": true
  }'
```

### Other endpoints

| Method | Path | What |
|--------|------|------|
| `GET` | `/v1/models` | List models |
| `GET` | `/health` | Health + version |

### Auth

Both `Authorization: Bearer KEY` and `x-api-key: KEY` work on all endpoints.

## Use with tools

### opencode CLI

Add to `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "free": {
      "name": "free",
      "type": "openai",
      "apiKey": "YOUR_KEY",
      "baseURL": "http://localhost:6446/v1",
      "models": {
        "free/deepseek-v4-flash-free": {
          "id": "deepseek-v4-flash-free",
          "name": "free/deepseek-v4-flash-free",
          "attachment": true,
          "reasoning": true
        }
      }
    }
  }
}
```

### Cursor / Continue / Cline

- Base URL: `http://YOUR_HOST:6446/v1`
- API Key: your key from `api-keys.json`
- Model: `deepseek-v4-flash-free`

### Claude Code (Anthropic format)

- Base URL: `http://YOUR_HOST:6446`
- API Key: your key from `api-keys.json`
- Works with `/v1/messages` endpoint

## Deploy on a VPS

```bash
# On your VPS
git clone https://github.com/bigdata2211it-web/opencode-free-proxy.git
cd opencode-free-proxy
npm install
node server.mjs          # foreground
# or
nohup node server.mjs > proxy.log 2>&1 &   # background
```

If your VPS doesn't expose port 6446, use an SSH tunnel:

```bash
ssh -L 6446:127.0.0.1:6446 user@your-vps
# Now http://localhost:6446 works locally
```

### systemd service (optional)

```ini
# /etc/systemd/system/opencode-proxy.service
[Unit]
Description=OpenCode Free Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/opencode-proxy
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
Environment=PROXY_PORT=6446

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now opencode-proxy
```

## Environment variables

| Variable | Default | What |
|----------|---------|------|
| `PROXY_PORT` | `6446` | Server port |
| `KEYS_FILE` | `./api-keys.json` | API keys file path |

## How it works

```
Your tool (Cursor, CLI, curl, etc.)
        │
        ▼
  opencode-free-proxy        ← this server, translates formats
        │
        ▼  HTTPS
  opencode.ai/zen/v1/       ← free tier API
```

The proxy adds `x-opencode-*` authentication headers that the Zen API requires. These were discovered by reverse engineering the opencode binary — without them, even `Authorization: Bearer public` gets rejected with `AuthError`.

### Zen API auth headers (for the curious)

```
Authorization: Bearer public
User-Agent: opencode/1.15.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13
x-opencode-client: cli
x-opencode-project: global
x-opencode-request: msg_<unique_id>
x-opencode-session: ses_<unique_id>
```

## License

MIT
