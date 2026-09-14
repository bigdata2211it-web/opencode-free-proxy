import argparse
import json
import os
import secrets
import sys
import time
from datetime import datetime, timezone

import httpx
import uvicorn


def log(*a):
    msg = f"[{time.strftime('%H:%M:%S')}] " + " ".join(str(x) for x in a)
    print(msg, flush=True)
    with open("proxy.log", "a", encoding="utf-8") as f:
        f.write(msg + "\n")
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

# ── CLI args ───────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="OpenCode Free Proxy")
    p.add_argument("--port", type=int, default=None, help="Listen port (default: 6446)")
    p.add_argument("--host", default=None, help="Listen host (default: 0.0.0.0)")
    p.add_argument("--proxy", default=None, help="SOCKS5 proxy (socks5://host:port)")
    p.add_argument("--api-key", default=None, help="API key for client auth")
    return p.parse_args()

args = parse_args()

# ── SOCKS5 Proxy ──────────────────────────────────────────────────

def normalize_proxy_url(raw: str | None) -> str | None:
    if not raw:
        return None
    if not raw.startswith("socks5://") and not raw.startswith("socks4://"):
        return "socks5://" + raw
    return raw


PROXY_URL = normalize_proxy_url(args.proxy or os.environ.get("SOCKS5_PROXY"))

http_client = httpx.AsyncClient(
    base_url="https://opencode.ai",
    timeout=httpx.Timeout(120.0),
    proxy=PROXY_URL,
)

# ── App ───────────────────────────────────────────────────────────

app = FastAPI()

PORT = args.port or int(os.environ.get("PORT", "6446"))
HOST = args.host or os.environ.get("HOST", "0.0.0.0")
OC_VERSION = "1.15.0"
PROXY_VERSION = "9"

# ── API Keys ──────────────────────────────────────────────────────

API_KEY = args.api_key or os.environ.get("LOCAL_KEY") or os.environ.get("API_KEY")


def auth(request: Request) -> str | None:
    if not API_KEY:
        return "user"
    hdr = request.headers.get("authorization") or request.headers.get("x-api-key") or ""
    tok = hdr[7:] if hdr.startswith("Bearer ") else hdr
    if tok == API_KEY:
        return "user"
    return None


# ── Helpers ───────────────────────────────────────────────────────

def oc_id(prefix: str) -> str:
    ts = format(int(time.time() * 1000), "x")
    rnd = secrets.token_urlsafe(12)[:16]
    return f"{prefix}_{ts}{rnd}"


# Models are auto-discovered from opencode.ai's catalog at startup.
# Fallback list is used only if discovery fails (offline, API down, etc.).
FALLBACK_MODELS = [
    "ocf-mimo-v2.5-free",
    "ocf-deepseek-v4-flash-free",
    "ocf-north-mini-code-free",
    "ocf-nemotron-3-ultra-free",
    "ocf-big-pickle",
]


def _is_free(cost: dict | None) -> bool:
    if not cost:
        return False
    for v in cost.values():
        if isinstance(v, (dict, list)):
            continue  # tiers / sub-objects
        if not isinstance(v, (int, float)) or v != 0:
            return False
    return True


def discover_models() -> list[str]:
    """Fetch the model catalog and pick the free models.

    A model counts as free when every billing field of its cost in
    models.opencode.ai/api.json is zero AND it is actually exposed by
    the public Zen API (opencode.ai/zen/v1/models). The latter filters
    out zero-cost models that still require a subscription.
    """
    try:
        with httpx.Client(timeout=30.0, proxy=PROXY_URL) as client:
            catalog = client.get("https://models.opencode.ai/api.json").json()
            zen = client.get("https://opencode.ai/zen/v1/models").json()
    except Exception as e:
        log(f"MODELS discovery failed ({e}), using fallback list")
        return list(FALLBACK_MODELS)

    oc_models = (catalog.get("opencode") or {}).get("models") or {}
    zen_ids = [m.get("id") for m in (zen.get("data") or [])]
    free = [f"ocf-{m}" for m in zen_ids if _is_free((oc_models.get(m) or {}).get("cost"))]
    if not free:
        log("MODELS discovery returned nothing, using fallback list")
        return list(FALLBACK_MODELS)
    return free


MODELS = discover_models()
log(f"MODELS: {', '.join(MODELS)}")

# Session per conversation (hash-based lookup)
import hashlib

# {user: {hash_of_messages: server_session_id}}
_user_sessions: dict[str, dict[str, str]] = {}


def _hash_messages(messages: list[dict]) -> str:
    parts = []
    for m in (messages or []):
        role = m.get("role", "")
        content = m.get("content") or ""
        if isinstance(content, list):
            content = json.dumps(content, ensure_ascii=False)
        parts.append(f"{role}:{content}")
    return hashlib.sha256("||".join(parts).encode()).hexdigest()[:16]


def get_session(user: str, messages: list[dict]) -> str:
    if user not in _user_sessions:
        _user_sessions[user] = {}
    sessions = _user_sessions[user]

    # Check hashes from longest prefix to shortest
    for n in range(len(messages), 0, -1):
        h = _hash_messages(messages[:n])
        if h in sessions:
            full_h = _hash_messages(messages)
            sessions[full_h] = sessions[h]
            log(f"SESSION match prefix={n}/{len(messages)} -> {sessions[h]}")
            return sessions[h]

    # No match — new session
    new_id = f"ses_{oc_id('ses')}"
    full_h = _hash_messages(messages)
    sessions[full_h] = new_id
    log(f"SESSION new {new_id} (msgs={len(messages)})")
    return new_id


# ── Zen API transport ─────────────────────────────────────────────

def strip_prefix(model: str) -> str:
    return model[4:] if model.startswith("ocf-") else model


def zen_request(model, messages, stream, tools, tool_choice, session_id):
    req_body: dict = {"model": strip_prefix(model), "messages": messages, "stream": bool(stream)}
    if tools:
        req_body["tools"] = tools
    if tool_choice:
        req_body["tool_choice"] = tool_choice

    request_id = oc_id("msg")
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer public",
        "User-Agent": f"opencode/{OC_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13",
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
        "x-opencode-request": request_id,
        "x-opencode-session": session_id,
    }
    return req_body, headers


# ── Anthropic Messages → OpenAI conversion ────────────────────────

def anthropic_to_openai(body: dict) -> tuple[list[dict], list[dict] | None]:
    messages = []

    if body.get("system"):
        sys_val = body["system"]
        if isinstance(sys_val, str):
            sys_text = sys_val
        elif isinstance(sys_val, list):
            sys_text = "\n".join(b.get("text", "") for b in sys_val)
        else:
            sys_text = ""
        if sys_text:
            messages.append({"role": "system", "content": sys_text})

    for msg in body.get("messages", []):
        content = msg.get("content")
        if isinstance(content, str):
            messages.append({"role": msg["role"], "content": content})
        elif isinstance(content, list):
            text = "\n".join(b.get("text", "") for b in content if b.get("type") == "text")
            tool_uses = [b for b in content if b.get("type") == "tool_use"]

            if tool_uses and msg.get("role") == "assistant":
                messages.append({
                    "role": "assistant",
                    "content": text or None,
                    "tool_calls": [
                        {
                            "id": t["id"],
                            "type": "function",
                            "function": {
                                "name": t["name"],
                                "arguments": json.dumps(t.get("input") or {}),
                            },
                        }
                        for t in tool_uses
                    ],
                })
            elif any(b.get("type") == "tool_result" for b in content):
                for b in content:
                    if b.get("type") == "tool_result":
                        c = b.get("content")
                        if isinstance(c, str):
                            result_text = c
                        elif isinstance(c, list):
                            result_text = "\n".join(x.get("text", "") for x in c)
                        else:
                            result_text = ""
                        messages.append({
                            "role": "tool",
                            "tool_call_id": b["tool_use_id"],
                            "content": result_text,
                        })
            else:
                messages.append({"role": msg["role"], "content": text})
        else:
            messages.append({"role": msg["role"], "content": str(content)})

    tools_out = [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t.get("description") or "",
                "parameters": t.get("input_schema") or {},
            },
        }
        for t in body.get("tools", [])
    ]

    return messages, tools_out or None


# ── OpenAI response → Anthropic Messages format ──────────────────

def openai_to_anthropic(oai_resp: dict, model: str, input_tokens: int) -> dict:
    choice = (oai_resp.get("choices") or [None])[0]
    if not choice:
        return {
            "id": oc_id("msg"),
            "type": "message",
            "role": "assistant",
            "content": [{"type": "text", "text": ""}],
            "model": model,
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": input_tokens or 0,
                "output_tokens": 0,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
            },
        }

    content = []
    msg = choice.get("message") or {}
    if msg.get("content"):
        content.append({"type": "text", "text": msg["content"]})
    for tc in msg.get("tool_calls", []):
        try:
            inp = json.loads(tc["function"]["arguments"])
        except (json.JSONDecodeError, KeyError):
            inp = {}
        content.append({
            "type": "tool_use",
            "id": tc.get("id") or oc_id("toolu"),
            "name": tc["function"]["name"],
            "input": inp,
        })
    if not content:
        content.append({"type": "text", "text": ""})

    stop_reason = "end_turn"
    fr = choice.get("finish_reason")
    if fr == "tool_calls":
        stop_reason = "tool_use"
    elif fr == "length":
        stop_reason = "max_tokens"

    return {
        "id": oc_id("msg"),
        "type": "message",
        "role": "assistant",
        "content": content,
        "model": model,
        "stop_reason": stop_reason,
        "usage": {
            "input_tokens": (oai_resp.get("usage") or {}).get("prompt_tokens") or input_tokens or 0,
            "output_tokens": (oai_resp.get("usage") or {}).get("completion_tokens") or 0,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        },
    }


# ── Routes: OpenAI format ─────────────────────────────────────────

@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [
            {"id": m, "object": "model", "created": 1779000000, "owned_by": "opencode-free"}
            for m in MODELS
        ],
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    user = auth(request)
    if not user:
        return JSONResponse(status_code=401, content={"error": {"message": "Invalid API key"}})

    body = await request.json()
    model = body.get("model")
    messages = body.get("messages")
    stream = body.get("stream")
    tools = body.get("tools")
    tool_choice = body.get("tool_choice")

    log(f"REQUEST model={model} stream={stream} msgs={len(messages or [])} tools={len(tools or [])}")

    if model not in MODELS:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": f"Unknown model: {model}. Available: {', '.join(MODELS)}"}},
        )

    session_id = get_session(user, messages)
    msg_summary = [
        {"role": m.get("role"), "len": len(m.get("content") if isinstance(m.get("content"), str) else json.dumps(m.get("content") or ""))}
        for m in (messages or [])
    ]
    ts = datetime.now(timezone.utc).isoformat()
    print(f"[OAI] {ts} {user} {model} {'stream' if stream else 'sync'} msgs: {json.dumps(msg_summary)}")

    req_body, headers = zen_request(model, messages, stream, tools, tool_choice, session_id)

    if stream:
        return StreamingResponse(
            stream_openai(req_body, headers),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )
    else:
        try:
            resp = await http_client.post(
                "/zen/v1/chat/completions",
                json=req_body,
                headers=headers,
            )
            data = resp.json()
            if resp.status_code == 429 or data.get("error"):
                err_msg = (data.get("error") or {}).get("message") or "Rate limit exceeded"
                return JSONResponse(
                    status_code=429,
                    content={"error": {"message": err_msg + " (free model rate limit)", "type": "rate_limit_error", "code": "rate_limit_exceeded"}},
                )
            return data
        except Exception as e:
            print(f"[ZEN ERROR] {e}")
            return JSONResponse(status_code=502, content={"error": {"message": f"Upstream error: {e}", "type": "upstream_error"}})


async def stream_openai(req_body: dict, headers: dict):
    log(f"STREAM session={headers.get('x-opencode-session')} model={req_body.get('model')} msgs={len(req_body.get('messages', []))}")
    async with http_client.stream("POST", "/zen/v1/chat/completions", json=req_body, headers=headers) as resp:
        if resp.status_code == 429:
            try:
                raw = await resp.aread()
                data = json.loads(raw)
                err_msg = (data.get("error") or {}).get("message") or "Rate limit exceeded"
            except Exception:
                err_msg = "Rate limit exceeded"
            log(f"STREAM 429: {err_msg}")
            yield f'data: {json.dumps({"error": {"message": err_msg + " (free model rate limit)", "type": "rate_limit_error", "code": "rate_limit_exceeded"}})}\n\n'
            return

        if resp.status_code >= 400:
            raw = await resp.aread()
            log(f"STREAM error {resp.status_code}: {raw[:500]}")
            yield f'data: {json.dumps({"error": {"message": f"Upstream error {resp.status_code}", "type": "upstream_error"}})}\n\n'
            return

        chunk_count = 0
        first_chunks = []
        last_chunks = []
        async for line in resp.aiter_lines():
            if line:
                # Skip SSE comments (lines starting with :)
                if line.startswith(":"):
                    continue
                chunk_count += 1
                yield line + "\n\n"
                if chunk_count <= 3:
                    first_chunks.append(line[:200])
                if line.strip() == "data: [DONE]":
                    break
                last_chunks.append(line[:200])
                if len(last_chunks) > 5:
                    last_chunks.pop(0)
        log(f"STREAM done: {chunk_count} chunks")
        log(f"  first: {first_chunks}")
        log(f"  last: {last_chunks}")


# ── Routes: Anthropic Messages format ─────────────────────────────

@app.post("/v1/messages")
async def messages(request: Request):
    user = auth(request)
    if not user:
        return JSONResponse(
            status_code=401,
            content={"type": "error", "error": {"type": "authentication_error", "message": "Invalid API key"}},
        )

    body = await request.json()
    model = body.get("model")
    stream = body.get("stream")

    if model not in MODELS:
        return JSONResponse(
            status_code=400,
            content={"type": "error", "error": {"type": "invalid_request_error", "message": f"Unknown model: {model}. Available: {', '.join(MODELS)}"}},
        )

    oai_messages, tools = anthropic_to_openai(body)
    session_id = get_session(user, oai_messages)
    input_tokens = len(json.dumps(oai_messages)) // 4

    ts = datetime.now(timezone.utc).isoformat()
    print(f"[ANT] {ts} {user} {model} {'stream' if stream else 'sync'} msgs: {len(oai_messages)}")

    req_body, headers = zen_request(model, oai_messages, stream, tools, None, session_id)

    if stream:
        return StreamingResponse(
            stream_anthropic(req_body, headers, model, input_tokens),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )
    else:
        try:
            resp = await http_client.post(
                "/zen/v1/chat/completions",
                json=req_body,
                headers=headers,
            )
            data = resp.json()
            if resp.status_code == 429 or data.get("error"):
                err_msg = (data.get("error") or {}).get("message") or "Rate limit exceeded"
                return JSONResponse(
                    status_code=429,
                    content={"type": "error", "error": {"type": "rate_limit_error", "message": err_msg + " (free model rate limit)"}},
                )
            if not data.get("choices"):
                return JSONResponse(
                    status_code=502,
                    content={"type": "error", "error": {"type": "upstream_error", "message": "Invalid upstream response"}},
                )
            return openai_to_anthropic(data, model, input_tokens)
        except Exception as e:
            print(f"[ZEN ERROR] {e}")
            return JSONResponse(status_code=502, content={"type": "error", "error": {"type": "upstream_error", "message": str(e)}})


async def stream_anthropic(req_body: dict, headers: dict, model: str, input_tokens: int):
    msg_id = oc_id("msg")
    buffer = ""
    content_idx = 0
    tool_idx = -1
    output_tokens = 0
    headers_sent = False

    def send_sse(event: str, data: dict) -> str:
        return f"event: {event}\ndata: {json.dumps(data)}\n\n"

    try:
        async with http_client.stream("POST", "/zen/v1/chat/completions", json=req_body, headers=headers) as resp:
            if resp.status_code == 429:
                try:
                    raw = await resp.aread()
                    parsed = json.loads(raw)
                    err_msg = (parsed.get("error") or {}).get("message") or "Rate limit"
                except Exception:
                    err_msg = "Rate limit"
                yield send_sse("error", {"type": "error", "error": {"type": "rate_limit_error", "message": err_msg + " (free model rate limit)"}})
                return

            async for raw_line in resp.aiter_lines():
                if not raw_line:
                    continue

                # Check for errors on first chunk
                if not headers_sent:
                    trimmed = raw_line.strip()
                    if trimmed.startswith("{") and ("FreeUsageLimitError" in trimmed or '"error"' in trimmed):
                        try:
                            parsed = json.loads(trimmed)
                            if parsed.get("error") or parsed.get("type") == "error":
                                err_msg = (parsed.get("error") or {}).get("message") or parsed.get("message") or "Rate limit"
                                yield send_sse("error", {"type": "error", "error": {"type": "rate_limit_error", "message": err_msg + " (free model rate limit)"}})
                                return
                        except json.JSONDecodeError:
                            pass

                # Process SSE lines from upstream
                if raw_line.startswith("data: "):
                    payload = raw_line[6:].strip()
                    if payload == "[DONE]":
                        # Close open blocks
                        total_blocks = (1 if content_idx > 0 else 0) + (tool_idx + 1 if tool_idx >= 0 else 0)
                        for i in range(total_blocks):
                            yield send_sse("content_block_stop", {"type": "content_block_stop", "index": i})
                        yield send_sse("message_delta", {
                            "type": "message_delta",
                            "delta": {"stop_reason": "end_turn"},
                            "usage": {"output_tokens": output_tokens},
                        })
                        yield send_sse("message_stop", {"type": "message_stop"})
                        return

                    try:
                        parsed = json.loads(payload)
                    except json.JSONDecodeError:
                        continue

                    delta = (parsed.get("choices") or [{}])[0].get("delta") or {}
                    if not delta:
                        continue

                    if not headers_sent:
                        headers_sent = True
                        yield send_sse("message_start", {
                            "type": "message_start",
                            "message": {
                                "id": msg_id, "type": "message", "role": "assistant", "content": [],
                                "model": model, "stop_reason": None,
                                "usage": {"input_tokens": input_tokens or 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
                            },
                        })

                    # Text content
                    if delta.get("content"):
                        if content_idx == 0 and tool_idx == -1:
                            yield send_sse("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
                            content_idx = 1
                        yield send_sse("content_block_delta", {
                            "type": "content_block_delta", "index": 0,
                            "delta": {"type": "text_delta", "text": delta["content"]},
                        })
                        output_tokens += -(-len(delta["content"]) // 4)  # ceil division

                    # Tool calls
                    for tc in delta.get("tool_calls", []):
                        idx = tc.get("index", 0)
                        if idx > tool_idx:
                            if tool_idx == -1 and content_idx > 0:
                                yield send_sse("content_block_stop", {"type": "content_block_stop", "index": 0})
                            tool_idx = idx
                            block_idx = idx + 1 if content_idx > 0 else idx
                            yield send_sse("content_block_start", {
                                "type": "content_block_start", "index": block_idx,
                                "content_block": {"type": "tool_use", "id": tc.get("id") or oc_id("toolu"), "name": (tc.get("function") or {}).get("name") or ""},
                            })
                        func = tc.get("function") or {}
                        if func.get("arguments"):
                            block_idx = idx + 1 if content_idx > 0 else idx
                            yield send_sse("content_block_delta", {
                                "type": "content_block_delta", "index": block_idx,
                                "delta": {"type": "input_json_delta", "partial_json": func["arguments"]},
                            })
                            output_tokens += -(-len(func["arguments"]) // 4)

                    # Finish
                    finish_reason = (parsed.get("choices") or [{}])[0].get("finish_reason")
                    if finish_reason:
                        total_blocks = (1 if content_idx > 0 else 0) + (tool_idx + 1 if tool_idx >= 0 else 0)
                        for i in range(total_blocks):
                            yield send_sse("content_block_stop", {"type": "content_block_stop", "index": i})

                        stop_reason = "end_turn"
                        if finish_reason == "tool_calls":
                            stop_reason = "tool_use"
                        elif finish_reason == "length":
                            stop_reason = "max_tokens"

                        yield send_sse("message_delta", {
                            "type": "message_delta",
                            "delta": {"stop_reason": stop_reason},
                            "usage": {"output_tokens": output_tokens},
                        })
                        yield send_sse("message_stop", {"type": "message_stop"})
                        return

    except httpx.HTTPError as e:
        print(f"[ZEN ERROR] {e}")
        if not headers_sent:
            yield send_sse("error", {"type": "error", "error": {"type": "upstream_error", "message": str(e)}})


# ── Health ────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "version": f"v{PROXY_VERSION}",
        "models": len(MODELS),
        "socks5": PROXY_URL,
        "endpoints": ["/v1/chat/completions", "/v1/messages", "/v1/models"],
    }


# ── Start ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"OpenCode Free Proxy v{PROXY_VERSION} on http://{HOST}:{PORT}")
    if PROXY_URL:
        print(f"  SOCKS5 proxy: {PROXY_URL}")
    else:
        print("  No SOCKS5 proxy configured (use --proxy or SOCKS5_PROXY)")
    print("  OpenAI:    POST /v1/chat/completions")
    print("  Anthropic: POST /v1/messages")
    print("  Models:    GET  /v1/models")
    print("  Health:    GET  /health")
    print(f"  Models: {', '.join(MODELS)}")
    if API_KEY:
        print(f"  API key:   {API_KEY[:8]}...")
    else:
        print("  API key:   (none - open access)")

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
