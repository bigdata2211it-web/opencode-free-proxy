# opencode-free-proxy

Free AI models from [OpenCode](https://opencode.ai) exposed as standard OpenAI and Anthropic APIs.

One server — works with any tool that speaks OpenAI or Anthropic format: Cursor, Continue, Cline, Claude Code, aider, opencode CLI, raw `curl`, whatever.

## 30-second setup

```bash
git clone https://github.com/bigdata2211it-web/opencode-free-proxy.git
cd opencode-free-proxy
npm install
npm start
```

Done. Server is at `http://localhost:6446`. API keys are in `api-keys.json` (auto-generated on first run).

`npm install` then `npm start`. The proxy talks to `opencode.ai/zen` directly with the official-client fingerprint the free tier requires.

## What you get

The server currently serves these free models (check `/v1/models` at runtime for the authoritative list):

| Model | Description |
|-------|-------------|
| `mimo-v2.5-free` | Xiaomi MiMo V2.5 |
| `nemotron-3-ultra-free` | NVIDIA Nemotron 3 Ultra |
| `nemotron-3.5-lightning-free` | NVIDIA Nemotron 3.5 Lightning |
| `ling-3.0-flash-fin-free` | Ling 3.0 Flash Fin |
| `big-pickle` | Big Pickle |
| `muse-spark-1.2-contributor-free` | Muse Spark 1.2 |
| `muse-spark-1.3-contributor-free` | Muse Spark 1.3 |

All models support streaming, system messages, and tool calling. Cursor's own tool names are forwarded; the proxy injects the four OpenCode fingerprint tools (`bash`, `glob`, `grep`, `read`) that the free-tier gate requires.

## API

### OpenAI format — `POST /v1/chat/completions`

```bash
curl http://localhost:6446/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo-v2.5-free",
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
    "model": "mimo-v2.5-free",
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
| `GET` | `/health` | Health + opencode status |

### Auth

Both `Authorization: Bearer KEY` and `x-api-key: KEY` work on all endpoints.

## Docker

```bash
docker compose up -d --build
# API keys persist in the proxy-data volume:
docker exec opencode-free-proxy cat /data/api-keys.json
```

API keys persist in the `proxy-data` volume.

## Use with tools

### Cursor / Continue / Cline

- Base URL: `http://YOUR_HOST:6446/v1`
- API Key: your key from `api-keys.json`
- Model: `mimo-v2.5-free`

### Claude Code (Anthropic format)

- Base URL: `http://YOUR_HOST:6446`
- API Key: your key from `api-keys.json`

## Environment variables

| Variable | Default | What |
|----------|---------|------|
| `PROXY_PORT` | `6446` | Proxy listen port |
| `KEYS_FILE` | `./api-keys.json` | API keys file path |
| `MAX_RETRIES` | `12` | Rate-limit / transient retries after first attempt |
| `RETRY_BASE_MS` | `1000` | First retry delay; doubles each attempt |
| `RETRY_MAX_MS` | `30000` | Backoff cap |
| `LOG_DETAIL` | `1` | `0` disables full I/O dumps |
| `LOG_MAX_CHARS` | `0` | Truncate logged payloads (0 = unlimited) |
| `NO_COLOR` / `FORCE_COLOR` | — | ANSI color control |

## How it works

```
Your tool (Cursor, CLI, curl, etc.)
        │
        ▼
  opencode-free-proxy        ← this server, translates formats
        │  HTTPS  POST /zen/v1/chat/completions
        ▼
  opencode.ai/zen            ← free tier
```

The free-tier gate (`FreeTierError: OpenCode's free tier can only be used from within OpenCode`) is **not** encrypted inference. It fingerprints the official client on four axes:

1. `User-Agent: opencode/<version>` with version ≥ 1.17
2. Canonical `x-opencode-session` / `x-opencode-request` ids (`prefix_` + 12 hex time bytes + 14 base62)
3. Request body includes tools named `{bash, glob, grep, read}` (extras allowed)
4. `stream: true` (non-stream is 403)

v0.2 talks to Zen directly: forces `stream: true` upstream, injects any missing fingerprint tools (Cursor's own tools are kept), and folds SSE back into JSON for sync clients. An earlier serve-spawn experiment still 403'd Cursor — that path is gone.

On 429 the session id is rotated (fresh free-tier quota) and the request retried with backoff.

## License

MIT
