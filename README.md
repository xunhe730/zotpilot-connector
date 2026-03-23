# ZotPilot Connector

> AI-native Zotero paper saving — zero clicks, full API

ZotPilot Connector extends the [Zotero Connector](https://www.zotero.org/support/dev/client_coding/connector_http_server) with an HTTP bridge that lets AI agents save papers directly. No UI interaction required.

```
Agent (MCP / CLI)        Bridge (localhost)         Chrome Extension         Zotero
      │                        │                          │                     │
      │──── POST /enqueue ────>│                          │                     │
      │<─── 200 {id} ─────────│                          │                     │
      │                        │──── GET /pending ──────>│                     │
      │                        │<─── 200 {url, id} ──────│                     │
      │                        │                    (opens tab, saves)          │
      │                        │<──── POST /result ─────────────────────────>│
      │<─── GET /result/{id}───│                          │                     │
      │─── 200 {success} ──────>│                          │                     │
```

## Features

- **Agent-native**: Any HTTP client (curl, Python, MCP tool) can trigger saves
- **Real browser context**: Uses the user's Chrome with institutional cookies and translator plugins
- **Accurate completion detection**: `sendMessage` + `receiveMessage` dual monkey-patch; honest `"unconfirmed"` on timeout — no false positives
- **Bridge-side routing**: After save, apply collections and tags via pyzotero
- **Heartbeat monitoring**: `/status` reports extension and Zotero connectivity
- **Fail-fast errors**: `extension_not_connected` (503) returned immediately, not after 90s timeout

## Architecture

```
src/
├── browserExt/
│   └── agentAPI.js      # Extension-side bridge poller
└── common/              # Shared Zotero Connector code (upstream)
    ├── inject/          # Content scripts
    └── messaging.js    # Message passing layer (monkey-patched here)
```

The extension polls `GET /pending` every 2s (also serves as MV3 keep-alive). On command it opens a tab, runs translators, and reports results via `POST /result`. The bridge runs as a Python HTTP server on `localhost:2619`.

## Quick Start

### 1. Build the extension

```bash
git clone https://github.com/xunhe730/zotpilot-connector.git
cd zotpilot-connector
npm install
./build.sh -d
```

### 2. Load in Chrome

1. Go to `chrome://extensions/`
2. Enable **Developer Mode**
3. Click **Load unpacked** → select `build/browserExt`

### 3. Start the bridge

```bash
# Part of the ZotPilot MCP server
zotpilot bridge

# Or in Python:
python -m zotpilot.cli bridge
```

### 4. Save a paper

```bash
curl -X POST http://127.0.0.1:2619/enqueue \
  -H "Content-Type: application/json" \
  -d '{"action": "save", "url": "https://arxiv.org/abs/2401.00001"}'

# Poll for result:
curl http://127.0.0.1:2619/result/<request_id>
```

Or use the MCP tool from ZotPilot:

```
save_from_url(url="https://arxiv.org/abs/2401.00001", collection_key="MYCOLL", tags=["ml"])
```

## API Reference

See [PROTOCOL.md](PROTOCOL.md) for the full specification.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/pending` | Extension polls for commands (every 2s) |
| `POST` | `/enqueue` | Enqueue a save command |
| `POST` | `/result` | Extension posts save result |
| `GET` | `/result/<id>` | Poll for a result |
| `POST` | `/heartbeat` | Extension liveness (every 10s) |
| `GET` | `/status` | Health + connectivity status |

### Error Codes

| Code | Meaning | Retry? |
|------|---------|--------|
| `extension_not_connected` | Extension not sending heartbeats | Yes |
| `zotero_not_running` | Zotero desktop unreachable | Yes |
| `save_trigger_failed` | Synchronous error on save click | Maybe |
| `completion_unconfirmed` | Timeout — save may have succeeded | Check Zotero |
| `collection_not_found` | Collection key invalid | No |

## Requirements

- Chrome with ZotPilot Connector loaded
- Zotero Desktop running (for translator-based saves)
- Bridge server running on port 2619
- For collection/tag routing: `ZOTERO_API_KEY` + `ZOTERO_USER_ID` in ZotPilot

## Protocol

The bridge is a transparent HTTP proxy. All endpoints accept and return JSON. CORS is open for all origins.

```
POST /enqueue  →  {request_id}
GET  /pending  →  {action, url, collection_key, tags}  |  204
POST /result   →  {request_id, success, title, item_key, ...}
GET  /result   →  {same as POST /result}               |  204
POST /heartbeat →  204
GET  /status   →  {bridge, extension_connected, zotero_running, ...}
```

## License

AGPL-3.0 — same as the upstream Zotero Connector project.
