# opencode-free-proxy

Free AI models from [OpenCode](https://opencode.ai) exposed as standard OpenAI and Anthropic APIs.

One server — works with any tool that speaks OpenAI or Anthropic format: Cursor, Continue, Cline, Claude Code, aider, opencode CLI, raw `curl`, whatever.

## Related projects

All three projects share the same CLI interface (`--port`, `--host`, `--proxy`, `--api-key`) and work together through [llama-swap](https://github.com/mmkeeper/llama-swap):

| Project | Port | Prefix | What |
|---------|------|--------|------|
| [opencode-free-proxy](https://github.com/mmkeeper/opencode-free-proxy) | 6446 | `ocf-` | OpenCode free models (this) |
| [deepseek-free-api](https://github.com/mmkeeper/deepseek-free-api) | 18632 | `dsf-` | DeepSeek free API |
| [mimo-free-proxy](https://github.com/mmkeeper/mimo-free-proxy) | 8788 | `mcf-` | Xiaomi MiMo free API |

## 30-second setup

```bash
git clone https://github.com/mmkeeper/opencode-free-proxy.git
cd opencode-free-proxy
pip install -r requirements.txt
python server.py
```

Done. Server is at `http://localhost:6446`. API keys are in `api-keys.json` (auto-generated on first run).

## CLI arguments

All projects use the same CLI interface:

```bash
python server.py --port 6446 --host 127.0.0.1 --proxy socks5://127.0.0.1:9150 --api-key sk-my-key
```

| Argument | Default | Description |
|----------|---------|-------------|
| `--port` | `6446` | Listen port |
| `--host` | `127.0.0.1` | Listen host |
| `--proxy` | _(none)_ | SOCKS5 proxy (e.g. `socks5://127.0.0.1:9150`) |
| `--api-key` | _(from api-keys.json)_ | API key for client auth |

## Environment variables

| Variable | Default | What |
|----------|---------|------|
| `PROXY_PORT` | `6446` | Server port |
| `HOST` | `127.0.0.1` | Listen host |
| `KEYS_FILE` | `./api-keys.json` | API keys file path |
| `SOCKS5_PROXY` | _(none)_ | SOCKS5 proxy address for upstream requests |

## What you get

The model list is **auto-discovered at startup** from `models.opencode.ai/api.json`: it fetches the catalog and the public Zen API (`/zen/v1/models`), then keeps only models exposed there whose cost is zero across all billing fields. No need to hardcode — new free models appear automatically on restart.

Models are exposed with the `ocf-` prefix (e.g. `ocf-deepseek-v4-flash-free`). Latest discovered set (check `/v1/models` for the live list):

| Model | What it is |
|-------|-----------|
| `mimo-v2.5-free` | Xiaomi MiMo v2.5 |
| `deepseek-v4-flash-free` | DeepSeek V4 Flash |
| `muse-spark-1.3-contributor-free` | Muse Spark 1.3 |
| `muse-spark-1.2-contributor-free` | Muse Spark 1.2 |
| `ling-3.0-flash-fin-free` | Ling 3.0 Flash Fin |
| `nemotron-3-ultra-free` | NVIDIA Nemotron 3 Ultra |
| `nemotron-3.5-lightning-free` | NVIDIA Nemotron 3.5 Lightning |
| `big-pickle` | Reasoning model |

All models support streaming, tool calls, and system messages.

### Model name aliases (opencode CLI / Hermes)

When using the proxy with tools that support provider-prefixed model names (opencode CLI, Hermes), use the `ocf-` prefix:

| Tool format | Actual model sent to upstream |
|-------------|------------------------------|
| `ocf-mimo-v2.5-free` | `mimo-v2.5-free` |
| `ocf-deepseek-v4-flash-free` | `deepseek-v4-flash-free` |

The `ocf-` prefix is stripped before forwarding to opencode.ai, so multiple providers (mimo-free-proxy, opencode-free-proxy) can coexist without model name conflicts.

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
pip install -r requirements.txt
python server.py          # foreground
# or
nohup python server.py > proxy.log 2>&1 &   # background
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
ExecStart=/usr/bin/python3 server.py
Restart=always
RestartSec=5
Environment=PROXY_PORT=6446

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now opencode-proxy
```

## SOCKS5 Proxy

Route all upstream requests to opencode.ai through a SOCKS5 proxy.

### CLI argument

```bash
python server.py --proxy 127.0.0.1:9150
python server.py --proxy socks5://user:pass@10.0.0.1:1080
```

### Environment variable

```bash
SOCKS5_PROXY=127.0.0.1:9150 python server.py
SOCKS5_PROXY=socks5://user:pass@10.0.0.1:1080 python server.py
```

CLI `--proxy` takes priority over `SOCKS5_PROXY`. If neither is set, requests go directly.

### systemd with proxy

```ini
Environment=SOCKS5_PROXY=127.0.0.1:9150
```

## llama-swap integration

This server works with [llama-swap](https://github.com/mmkeeper/llama-swap) as a peer. See `config.yaml` in the llama-swap repo for an example.

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

### Session persistence

The proxy maintains conversation sessions automatically. It uses a hash of the message prefix to identify which upstream session to reuse, so multi-turn conversations stay coherent without the client managing session IDs.

### Model prefix (`ocf-`)

All models are exposed with an `ocf-` prefix (e.g. `ocf-mimo-v2.5-free`) to avoid conflicts with other providers in tools like Hermes. The prefix is stripped before forwarding to opencode.ai.

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
