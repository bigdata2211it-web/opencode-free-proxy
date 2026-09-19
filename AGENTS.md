# opencode-free-proxy

Modular Node.js Express proxy that translates OpenAI/Anthropic API calls onto `opencode.ai/zen/v1` with the official-client fingerprint the free tier requires.

## Quick start

```bash
npm install
npm start     # port 6446
```

API keys are auto-generated into `api-keys.json` on first run — no `.env` setup needed.

## Key facts

- **ESM only** — `"type": "module"` in package.json; use `import` not `require`.
- **No build step** — raw Node.js, no TypeScript, no bundler.
- **Tests** — `npm test` runs Node built-in test runner in `tests/`.
- **Architecture (v0.2+)** — direct `opencode.ai/zen/v1/chat/completions`. The 2026-09-16 `FreeTierError` is HTTP fingerprinting, not encrypted inference. Required: `User-Agent: opencode/<≥1.17>`, canonical `x-opencode-session`/`x-opencode-request`, tools named `{bash, glob, grep, read}`, `stream: true`.
- **Cursor** — Custom Models send `read_file` / `codebase_search` / etc. and no `bash`/`read`. Forward those tools and inject the missing fingerprint names. Do not drop client tools. Do not spawn `opencode serve` and override `system` (that 403s as a custom agent).
- **Two API formats** served on the same server:
  - `POST /v1/chat/completions` (OpenAI)
  - `POST /v1/messages` (Anthropic)
  - Auth works with either `Authorization: Bearer KEY` or `x-api-key: KEY` header.
- **Streaming is real** — Zen SSE is piped through. Sync clients get SSE folded into one JSON body (`aggregateSseToCompletion`) because Zen 403s `stream: false`.
- **Dependencies** — `express` only.

## Env vars

| Variable | Default | Notes |
|----------|---------|-------|
| `PROXY_PORT` | `6446` | Proxy listen port |
| `KEYS_FILE` | `./api-keys.json` | Auto-created if missing |
| `MAX_RETRIES` | `12` | Rate-limit / transient retries |
| `RETRY_BASE_MS` / `RETRY_MAX_MS` | `1000` / `30000` | Backoff base / cap (±20% jitter) |
| `LOG_DETAIL` | `1` | `0` disables full I/O dumps |
| `LOG_MAX_CHARS` | `0` | Truncate logged payloads (0 = unlimited) |
| `NO_COLOR` / `FORCE_COLOR` | — | ANSI color control |

## Files

| Path | Purpose |
|------|---------|
| `src/index.mjs` | Entry: load keys, start server |
| `src/client.mjs` | Zen request builder + fingerprint tools |
| `src/session.mjs` | Per-user `ses_` id, rotated on 429 |
| `src/pipe-openai.mjs` | Zen SSE → OpenAI SSE / sync JSON |
| `src/pipe-anthropic.mjs` | Zen SSE → Anthropic SSE |
| `src/to-openai.mjs` | Anthropic → OpenAI message converter |
| `src/to-anthropic.mjs` | OpenAI → Anthropic converter |
| `src/retry.mjs` | Backoff + 429 session rotation |
| `src/routes/*.mjs` | Route handlers |
| `models.json` | Available models (free tier) |
| `api-keys.json` | Auto-generated, **never commit** |
| `Dockerfile` | Multi-stage, non-root |
| `docker-compose.yaml` | Production: read-only rootfs, cap_drop ALL |

## Style

- No TypeScript, no lint config — just raw JS with Express.
- `console.log` for logging (no structured logger).
- The main complexity is the Zen pipe in `pipe-openai.mjs` / `pipe-anthropic.mjs` and the free-tier fingerprint in `src/client.mjs` — preserve behavior when touching.
- If Zen starts 403ing again, bisect the four fingerprint axes before assuming the gate moved into a closed layer.
