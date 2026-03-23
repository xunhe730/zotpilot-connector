# ZotPilot Connector MVP — Agent API Implementation Plan (rev3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Agent API to the Zotero Connector so AI agents can trigger paper saving (metadata + PDF) by sending a URL, reusing the Connector's existing Translator + PDF download flow with the user's browser cookies.

**Architecture:** An HTTP bridge (`http://127.0.0.1:2619`) runs as a separate Python process via `zotpilot bridge`. The Chrome extension's `agentAPI.js` module polls `GET /pending` every 2s (which also serves as MV3 service worker keep-alive). On command, it opens a tab, waits for translator detection via `onTranslators` callback, then calls `Zotero.Connector_Browser.onZoteroButtonElementClick(tab)` (public API). Save completion is detected by listening for `progressWindow.done` messages scoped by tab ID. Results are posted back to `POST /result`.

**Tech Stack:** Chrome Extension (Manifest V3), HTTP polling (browser-native fetch), ThreadingHTTPServer (Python stdlib), existing Zotero Connector internals.

---

## RALPLAN-DR Summary

**Principles:**
1. **Minimum invasion** — zero changes to Connector's core save logic; Agent API is a new trigger surface only
2. **Reuse over rebuild** — leverage existing Translators, PDF download, cookie handling, Zotero communication
3. **No new Chrome APIs** — use standard `fetch()` for polling; no WebSocket, no native messaging
4. **Two-repo separation** — extension changes in zotpilot-connector, bridge+MCP tool in ZotPilot; clean interface at HTTP boundary
5. **Graceful degradation** — extension works normally as Zotero Connector when bridge isn't running; polling silently catches fetch errors

**Decision Drivers:**
1. **PDF with institutional access** — the entire reason this exists; must use the user's real browser session with cookies
2. **Simplicity of deployment** — user loads unpacked extension + `save_from_url` auto-starts bridge
3. **Upstream compatibility** — changes must not break existing Connector functionality; easy to merge upstream updates

**Viable Options:**

| | Option A: HTTP Polling (selected) | Option B: WebSocket in Offscreen Doc | Option C: Native Messaging |
|---|---|---|---|
| How | Extension polls `GET /pending` every 2s via fetch() | WebSocket server in MV3 offscreen document | Chrome native messaging host (Python binary) |
| Pros | Zero new Chrome APIs; MV3 compatible; polling IS service worker keep-alive; simple to debug | Real-time push, no polling delay | Chrome-native secure IPC channel |
| Cons | 2s latency floor; bridge must be running separately | Offscreen docs designed for audio/DOM, not persistent servers; Chrome may kill them to save resources; adds API surface complexity | Requires native binary packaging per-platform; native host manifest registration varies by OS; complex user install |
| **Verdict** | **Selected** | Rejected: over-engineered for MVP; offscreen lifecycle risk | Rejected: too much install friction for users |

---

## HTTP API Contract

### `GET /pending`
Returns the next queued save command, or 204 if empty.

**200 Response:**
```json
{
  "request_id": "a1b2c3d4e5f6",
  "action": "save",
  "url": "https://www.sciencedirect.com/science/article/pii/S0029801826006669",
  "collection_key": "A8BBZ3TA",
  "tags": ["drag reduction", "CFD"]
}
```
**204 Response:** No body.

### `POST /result`
Extension posts save outcome.

**Request body:**
```json
{
  "request_id": "a1b2c3d4e5f6",
  "success": true,
  "title": "Numerical and experimental hydrodynamic assessment...",
  "url": "https://www.sciencedirect.com/...",
  "error": null
}
```
**200 Response:** No body.

### `GET /status`
Health check.

**200 Response:**
```json
{"bridge": "running", "port": 2619}
```

---

## File Structure

**zotpilot-connector (fork):**
```
src/browserExt/
├── agentAPI.js              # (create) Agent API: HTTP polling + save orchestration
├── background.js            # (modify) Add AgentAPI.init() in Connector_Browser.init()
└── background-worker.js     # (no change — agentAPI.js loaded via gulpfile)
gulpfile.js                  # (modify) Add 'agentAPI.js' to backgroundIncludeBrowserExt
```

**ZotPilot:**
```
src/zotpilot/
├── bridge.py                # (create) ThreadingHTTPServer on localhost:2619
├── cli.py                   # (modify) Add `bridge` subcommand
└── tools/
    └── ingestion.py          # (modify) Add `save_from_url` MCP tool
tests/
└── test_bridge.py           # (create) Bridge server tests
```

---

### Task 1: Create `agentAPI.js` — HTTP Polling + Save Orchestration

**Files:**
- Create: `src/browserExt/agentAPI.js`

- [ ] **Step 1: Create agentAPI.js**

```javascript
// src/browserExt/agentAPI.js
/*
    ***** BEGIN LICENSE BLOCK *****

    Copyright © 2026 ZotPilot Contributors

    This file is part of ZotPilot Connector (a fork of Zotero Connector).

    ZotPilot Connector is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    ***** END LICENSE BLOCK *****
*/

/**
 * Agent API — enables AI agents to trigger Zotero saves via HTTP polling.
 *
 * Polls GET http://127.0.0.1:2619/pending for save commands from ZotPilot bridge.
 * On command: opens tab → waits for translator detection → triggers save via
 * onZoteroButtonElementClick → listens for progressWindow.done → posts result.
 *
 * The 2-second poll interval also serves as MV3 service worker keep-alive.
 */
Zotero.AgentAPI = new function() {
	const BRIDGE_URL = "http://127.0.0.1:2619";
	const POLL_INTERVAL = 2000;
	let _polling = false;
	let _pollTimer = null;
	let _busy = false; // serialize saves: one at a time

	// Map<tabId, {resolve: Function}> — pending save completions
	let _pendingSaves = new Map();

	/**
	 * Start polling. Called after Zotero.initDeferred resolves.
	 *
	 * Installs a receiveMessage wrapper to intercept progressWindow.done
	 * messages without breaking existing dispatch (messaging.js uses
	 * singleton _messageListeners slots — addMessageListener would
	 * replace any existing handler).
	 */
	this.init = async function() {
		await Zotero.initDeferred.promise;

		// Monkey-patch receiveMessage to observe progressWindow.done
		const _originalReceive = Zotero.Messaging.receiveMessage.bind(Zotero.Messaging);
		Zotero.Messaging.receiveMessage = async function(messageName, args, tab, frameId) {
			if (messageName === "progressWindow.done" && tab && _pendingSaves.has(tab.id)) {
				let entry = _pendingSaves.get(tab.id);
				_pendingSaves.delete(tab.id);
				let success = args[0];
				let error = args.length > 1 ? args[1] : null;
				entry.resolve({ success: !!success, error });
			}
			// ALWAYS forward to original — never swallow messages
			return _originalReceive(messageName, args, tab, frameId);
		};

		_polling = true;
		_schedulePoll();
		Zotero.debug("AgentAPI: initialized, polling " + BRIDGE_URL);
	};

	this.destroy = function() {
		_polling = false;
		if (_pollTimer) {
			clearTimeout(_pollTimer);
			_pollTimer = null;
		}
	};

	function _schedulePoll() {
		if (!_polling) return;
		_pollTimer = setTimeout(_poll, POLL_INTERVAL);
	}

	async function _poll() {
		if (!_polling) return;
		if (_busy) {
			_schedulePoll();
			return;
		}
		try {
			let response = await fetch(BRIDGE_URL + "/pending", {
				method: "GET",
				headers: { "Accept": "application/json" },
			});
			if (response.status === 200) {
				let command = await response.json();
				if (command && command.action === "save" && command.url) {
					await _handleSave(command);
				}
			}
		} catch (e) {
			// Bridge not running — silently retry
		}
		_schedulePoll();
	}

	/**
	 * Handle a save command.
	 *
	 * Flow:
	 *   1. Open tab (active:false)
	 *   2. Wait for page load + translator detection (onTranslators callback)
	 *   3. Set up progressWindow.done listener for this tab
	 *   4. Call onZoteroButtonElementClick(tab) — public API, same as user click
	 *   5. Wait for progressWindow.done message → extract success/failure
	 *   6. Post result to bridge
	 *   7. Close tab
	 */
	async function _handleSave(command) {
		const { request_id, url } = command;
		_busy = true;
		Zotero.Connector_Browser.setKeepServiceWorkerAlive(true);
		let tabId = null;

		try {
			// 1. Open tab
			let tab = await browser.tabs.create({ url: url, active: false });
			tabId = tab.id;

			// 2. Wait for page load + translators
			await _waitForReady(tab.id, 30000);

			// 3. Set up completion promise BEFORE triggering save
			// Uses _pendingSaves Map populated here, resolved by receiveMessage wrapper
			let saveResult = new Promise((resolve) => {
				let timer = setTimeout(() => {
					_pendingSaves.delete(tab.id);
					resolve({ success: false, error: "Save timeout (60s)" });
				}, 60000);
				_pendingSaves.set(tab.id, {
					resolve: (result) => { clearTimeout(timer); resolve(result); }
				});
			});

			// 4. Trigger save — same as user clicking the Connector icon
			// Refresh tab object (URL may have changed due to redirects)
			tab = await browser.tabs.get(tab.id);
			Zotero.Connector_Browser.onZoteroButtonElementClick(tab);

			// 5. Wait for completion
			let { success, error } = await saveResult;

			// 6. Post result
			await _postResult({
				request_id,
				success,
				title: tab.title || "",
				url: url,
				error: error || null,
			});

		} catch (err) {
			Zotero.logError(err);
			await _postResult({
				request_id,
				success: false,
				url: url,
				error: err.message || String(err),
			});
		} finally {
			// 7. Close tab
			if (tabId) {
				try { await browser.tabs.remove(tabId); } catch (e) {}
			}
			Zotero.Connector_Browser.setKeepServiceWorkerAlive(false);
			_busy = false;
		}
	}

	/**
	 * Wait for tab to finish loading and for translators to be detected.
	 * Polls getTabInfo(tabId).translators after page load instead of a
	 * blind delay — resolves as soon as translators are available, or
	 * after 5s of polling (whichever comes first). Falls through on
	 * outer timeout regardless so saveAsWebpage can still work.
	 */
	function _waitForReady(tabId, timeout) {
		return new Promise((resolve) => {
			let resolved = false;
			let timer = setTimeout(() => {
				if (!resolved) { resolved = true; resolve(); }
			}, timeout);

			function onReady() {
				if (resolved) return;
				resolved = true;
				clearTimeout(timer);
				browser.tabs.onUpdated.removeListener(onUpdated);
				resolve();
			}

			// Listen for tab load completion
			function onUpdated(id, changeInfo) {
				if (id !== tabId || changeInfo.status !== "complete") return;
				_pollForTranslators(tabId, onReady);
			}
			browser.tabs.onUpdated.addListener(onUpdated);

			// Check if tab is already complete (fast cached pages)
			browser.tabs.get(tabId).then((tab) => {
				if (tab.status === "complete") {
					_pollForTranslators(tabId, onReady);
				}
			}).catch(() => {});
		});
	}

	/**
	 * Poll tabInfo.translators until available or 5s elapsed.
	 * Checks every 500ms, 10 attempts max.
	 */
	function _pollForTranslators(tabId, onReady) {
		let attempts = 0;
		function check() {
			let tabInfo = Zotero.Connector_Browser.getTabInfo(tabId);
			if (tabInfo && tabInfo.translators && tabInfo.translators.length > 0) {
				onReady();
				return;
			}
			attempts++;
			if (attempts >= 10) {
				// No translators after 5s — proceed anyway (saveAsWebpage fallback)
				onReady();
				return;
			}
			setTimeout(check, 500);
		}
		check();
	}

	// NOTE: Save completion detection uses the receiveMessage monkey-patch
	// installed in init(). The _pendingSaves Map correlates tab IDs to
	// resolve callbacks. No _listenForSaveCompletion function needed —
	// the Promise is created inline in _handleSave (Step 3).

	/**
	 * Post result back to bridge.
	 */
	async function _postResult(result) {
		try {
			await fetch(BRIDGE_URL + "/result", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(result),
			});
		} catch (e) {
			Zotero.debug("AgentAPI: failed to post result: " + e.message);
		}
	}
};
```

- [ ] **Step 2: Commit**

```bash
cd /Users/zxd/zotpilot-connector
git add src/browserExt/agentAPI.js
git commit -m "feat: add AgentAPI module for AI agent save commands"
```

---

### Task 2: Wire AgentAPI into Build + Background

**Files:**
- Modify: `gulpfile.js` line 151 — add `'agentAPI.js'` to `backgroundIncludeBrowserExt`
- Modify: `src/browserExt/background.js` — add init call in `Connector_Browser.init()`

- [ ] **Step 1: Add agentAPI.js to backgroundIncludeBrowserExt**

In `gulpfile.js`, find the `backgroundIncludeBrowserExt` array (line 151) and add `'agentAPI.js'` after `'saveWithoutProgressWindow.js'`:

```javascript
// gulpfile.js line 151-158
var backgroundIncludeBrowserExt = ['browser-polyfill.js'].concat(backgroundInclude, [
	'webRequestIntercept.js',
	'contentTypeHandler.js',
	'saveWithoutProgressWindow.js',
	'agentAPI.js',  // ZotPilot Agent API
	'messagingGeneric.js',
	'browserAttachmentMonitor/browserAttachmentMonitor.js',
	'offscreen/offscreenFunctionOverrides.js', 'background/offscreenManager.js',
]);
```

- [ ] **Step 2: Add AgentAPI.init() to Connector_Browser.init()**

In `src/browserExt/background.js`, at the end of `this.init = async function()` (after line 76, before the closing `}`):

```javascript
		// ZotPilot Agent API — enable AI agent integration
		if (typeof Zotero.AgentAPI !== 'undefined') {
			Zotero.AgentAPI.init();
		}
```

- [ ] **Step 3: Build and verify**

```bash
cd /Users/zxd/zotpilot-connector
npm install
./build.sh -d
# Verify agentAPI.js is in the build output:
grep -l "AgentAPI" build/browserExt/*.js
```

- [ ] **Step 4: Commit**

```bash
git add gulpfile.js src/browserExt/background.js
git commit -m "feat: wire AgentAPI into build system and background init"
```

---

### Task 3: ZotPilot Bridge HTTP Server

**Files:**
- Create: `src/zotpilot/bridge.py` (in ZotPilot repo at `/Users/zxd/ZotPilot`)
- Create: `tests/test_bridge.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_bridge.py
"""Tests for ZotPilot HTTP bridge server."""
from __future__ import annotations

import json
import urllib.request

from zotpilot.bridge import BridgeServer


class TestBridgeServer:
    def test_no_pending_returns_204(self):
        """GET /pending with no commands returns 204."""
        bridge = BridgeServer(port=0)
        bridge.start()
        try:
            port = bridge.port
            req = urllib.request.Request(f"http://127.0.0.1:{port}/pending")
            resp = urllib.request.urlopen(req)
            assert resp.status == 204
        finally:
            bridge.stop()

    def test_enqueue_and_fetch(self):
        """Enqueue a command, GET /pending returns it with request_id."""
        bridge = BridgeServer(port=0)
        bridge.start()
        try:
            port = bridge.port
            bridge.enqueue({
                "action": "save",
                "url": "https://example.com/paper",
            })
            req = urllib.request.Request(f"http://127.0.0.1:{port}/pending")
            resp = urllib.request.urlopen(req)
            data = json.loads(resp.read())
            assert data["action"] == "save"
            assert data["url"] == "https://example.com/paper"
            assert "request_id" in data
        finally:
            bridge.stop()

    def test_post_result_and_retrieve(self):
        """POST /result stores result, wait_for_result returns it."""
        bridge = BridgeServer(port=0)
        bridge.start()
        try:
            port = bridge.port
            rid = bridge.enqueue({"action": "save", "url": "https://example.com"})
            result = {"request_id": rid, "success": True, "title": "Test Paper"}
            data = json.dumps(result).encode()
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/result",
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req)
            stored = bridge.get_result(rid)
            assert stored is not None
            assert stored["success"] is True
            assert stored["title"] == "Test Paper"
        finally:
            bridge.stop()

    def test_status_endpoint(self):
        """GET /status returns running status."""
        bridge = BridgeServer(port=0)
        bridge.start()
        try:
            port = bridge.port
            req = urllib.request.Request(f"http://127.0.0.1:{port}/status")
            resp = urllib.request.urlopen(req)
            data = json.loads(resp.read())
            assert data["bridge"] == "running"
        finally:
            bridge.stop()

    def test_queue_is_fifo(self):
        """Multiple commands dequeue in order."""
        bridge = BridgeServer(port=0)
        bridge.start()
        try:
            port = bridge.port
            bridge.enqueue({"action": "save", "url": "https://first.com"})
            bridge.enqueue({"action": "save", "url": "https://second.com"})

            resp1 = urllib.request.urlopen(f"http://127.0.0.1:{port}/pending")
            data1 = json.loads(resp1.read())
            assert data1["url"] == "https://first.com"

            resp2 = urllib.request.urlopen(f"http://127.0.0.1:{port}/pending")
            data2 = json.loads(resp2.read())
            assert data2["url"] == "https://second.com"
        finally:
            bridge.stop()
```

- [ ] **Step 2: Run test — expect fail**

Run: `cd /Users/zxd/ZotPilot && uv run pytest tests/test_bridge.py -v`

- [ ] **Step 3: Implement BridgeServer**

```python
# src/zotpilot/bridge.py
"""HTTP bridge between ZotPilot MCP tools and the ZotPilot Connector extension.

The bridge serves three endpoints on localhost:
  GET  /pending  → returns next queued save command (or 204 No Content)
  POST /result   → receives save results from the extension
  GET  /status   → health check

The Chrome extension polls GET /pending every 2 seconds.
MCP tools call bridge.enqueue() and bridge.wait_for_result().

Uses ThreadingHTTPServer to avoid deadlock when MCP tool is blocking
on wait_for_result() while the extension tries to POST /result.
"""
import json
import logging
import subprocess
import sys
import threading
import uuid
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_PORT = 2619


class _BridgeHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the bridge."""

    def log_message(self, format, *args):
        logger.debug(format, *args)

    def _set_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._set_cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/pending":
            # Extension polls this — returns next queued command or 204
            cmd = self.server.bridge._dequeue()
            if cmd:
                body = json.dumps(cmd).encode()
                self.send_response(200)
                self._set_cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(204)
                self._set_cors()
                self.end_headers()
        elif self.path.startswith("/result/"):
            # MCP tool polls this — returns result for a specific request_id
            request_id = self.path.split("/result/")[1]
            result = self.server.bridge.get_result(request_id)
            if result:
                body = json.dumps(result).encode()
                self.send_response(200)
                self._set_cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(204)
                self._set_cors()
                self.end_headers()
        elif self.path == "/status":
            body = json.dumps({"bridge": "running", "port": self.server.bridge.port}).encode()
            self.send_response(200)
            self._set_cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/enqueue":
            # MCP tool posts save commands here
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                command = json.loads(body)
                request_id = self.server.bridge.enqueue(command)
                resp = json.dumps({"request_id": request_id}).encode()
                self.send_response(200)
                self._set_cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(resp)
            except json.JSONDecodeError:
                self.send_response(400)
                self.end_headers()
        elif self.path == "/result":
            # Extension posts save results here
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                result = json.loads(body)
                self.server.bridge._store_result(result)
                self.send_response(200)
                self._set_cors()
                self.end_headers()
            except json.JSONDecodeError:
                self.send_response(400)
                self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()


class BridgeServer:
    """HTTP bridge server for Chrome extension communication."""

    def __init__(self, port: int = DEFAULT_PORT):
        self._requested_port = port
        self._queue: list[dict] = []
        self._results: dict[str, dict] = {}
        self._events: dict[str, threading.Event] = {}
        self._lock = threading.Lock()
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.port = port

    def enqueue(self, command: dict) -> str:
        """Add a save command to the queue. Returns request_id."""
        command = {**command}  # defensive copy — never mutate caller's dict
        if "request_id" not in command:
            command["request_id"] = uuid.uuid4().hex[:12]
        request_id = command["request_id"]
        event = threading.Event()
        with self._lock:
            self._queue.append(command)
            self._events[request_id] = event
        return request_id

    def wait_for_result(self, request_id: str, timeout: float = 90.0) -> dict | None:
        """Block until the extension posts a result for this request_id."""
        event = self._events.get(request_id)
        if not event:
            return None
        event.wait(timeout=timeout)
        with self._lock:
            self._events.pop(request_id, None)
            return self._results.pop(request_id, None)

    def get_result(self, request_id: str) -> dict | None:
        """Get a stored result without blocking."""
        with self._lock:
            return self._results.get(request_id)

    def _dequeue(self) -> dict | None:
        with self._lock:
            return self._queue.pop(0) if self._queue else None

    def _store_result(self, result: dict):
        request_id = result.get("request_id")
        if not request_id:
            return
        with self._lock:
            self._results[request_id] = result
            event = self._events.get(request_id)
            if event:
                event.set()

    def start(self):
        """Start the HTTP server in a background thread."""
        self._server = ThreadingHTTPServer(("127.0.0.1", self._requested_port), _BridgeHandler)
        self._server.bridge = self
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        logger.info(f"Bridge server listening on http://127.0.0.1:{self.port}")

    def stop(self):
        """Stop the HTTP server."""
        if self._server:
            self._server.shutdown()
            self._server = None

    @staticmethod
    def is_running(port: int = DEFAULT_PORT) -> bool:
        """Check if a bridge is already running on the given port."""
        import urllib.request
        try:
            resp = urllib.request.urlopen(f"http://127.0.0.1:{port}/status", timeout=2)
            return resp.status == 200
        except Exception:
            return False

    @staticmethod
    def auto_start(port: int = DEFAULT_PORT) -> None:
        """Start bridge as a background subprocess if not already running."""
        if BridgeServer.is_running(port):
            return
        subprocess.Popen(
            [sys.executable, "-m", "zotpilot.cli", "bridge", "--port", str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # Wait briefly for startup
        import time
        for _ in range(10):
            time.sleep(0.5)
            if BridgeServer.is_running(port):
                return
        raise RuntimeError(f"Failed to auto-start bridge on port {port}")
```

- [ ] **Step 4: Run test — expect pass**

Run: `cd /Users/zxd/ZotPilot && uv run pytest tests/test_bridge.py -v`

- [ ] **Step 5: Commit**

```bash
cd /Users/zxd/ZotPilot
git add src/zotpilot/bridge.py tests/test_bridge.py
git commit -m "feat: add ThreadingHTTPServer bridge for Chrome extension polling"
```

---

### Task 4: CLI `bridge` Subcommand + MCP Tool `save_from_url`

**Files:**
- Modify: `src/zotpilot/cli.py` — add `bridge` subcommand
- Modify: `src/zotpilot/tools/ingestion.py` — add `save_from_url` tool

- [ ] **Step 1: Add cmd_bridge to cli.py**

In `src/zotpilot/cli.py`, add the function before `cmd_register`:

```python
def cmd_bridge(args):
    """Run the HTTP bridge for ZotPilot Connector extension."""
    import time
    from .bridge import BridgeServer

    port = getattr(args, "port", 2619)
    server = BridgeServer(port=port)
    server.start()
    print(f"ZotPilot bridge running on http://127.0.0.1:{port}")
    print("The ZotPilot Connector extension will poll this endpoint.")
    print("Press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping bridge...")
        server.stop()
    return 0
```

In `main()`, add the subparser before the `register` block:

```python
    # bridge
    sub_bridge = subparsers.add_parser("bridge", help="Run HTTP bridge for ZotPilot Connector")
    sub_bridge.add_argument("--port", type=int, default=2619, help="HTTP port (default: 2619)")
    sub_bridge.set_defaults(func=cmd_bridge)
```

- [ ] **Step 2: Add save_from_url MCP tool to ingestion.py**

In `src/zotpilot/tools/ingestion.py`, add after the existing `ingest_papers` tool:

```python
@mcp.tool()
def save_from_url(
    url: str,
    collection_key: str | None = None,
    tags: list[str] | None = None,
) -> dict:
    """Save a paper from any publisher URL to Zotero via ZotPilot Connector.

    Opens the URL in the user's real browser (with institutional cookies),
    runs Zotero translators to extract metadata, downloads PDF, and saves to Zotero.

    Requires: ZotPilot Connector extension installed in Chrome.
    The bridge is auto-started if not already running.
    """
    import json
    import time
    import urllib.request
    from ..bridge import BridgeServer, DEFAULT_PORT

    bridge_url = f"http://127.0.0.1:{DEFAULT_PORT}"

    # Auto-start bridge if not running
    if not BridgeServer.is_running(DEFAULT_PORT):
        try:
            BridgeServer.auto_start(DEFAULT_PORT)
        except RuntimeError as e:
            return {"success": False, "error": str(e)}

    # POST command to bridge's /enqueue endpoint (pure HTTP client)
    command = {
        "action": "save",
        "url": url,
        "collection_key": collection_key,
        "tags": tags or [],
    }
    try:
        req = urllib.request.Request(
            f"{bridge_url}/enqueue",
            data=json.dumps(command).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=5)
        request_id = json.loads(resp.read())["request_id"]
    except Exception as e:
        return {"success": False, "error": f"Failed to enqueue: {e}"}

    # Poll GET /result/<request_id> until result arrives or timeout
    deadline = time.monotonic() + 90.0
    while time.monotonic() < deadline:
        time.sleep(2)
        try:
            resp = urllib.request.urlopen(
                f"{bridge_url}/result/{request_id}", timeout=5
            )
            if resp.status == 200:
                return json.loads(resp.read())
        except Exception:
            pass  # 204 or connection error — keep polling

    return {
        "success": False,
        "error": "Timeout (90s) — extension did not respond. "
                 "Ensure ZotPilot Connector is installed and Chrome is open.",
    }
```

- [ ] **Step 3: Run full test suite**

```bash
cd /Users/zxd/ZotPilot
uv run ruff check src/zotpilot/bridge.py src/zotpilot/cli.py src/zotpilot/tools/ingestion.py
uv run pytest -q
```

- [ ] **Step 4: Commit**

```bash
cd /Users/zxd/ZotPilot
git add src/zotpilot/cli.py src/zotpilot/tools/ingestion.py
git commit -m "feat: add bridge CLI subcommand + save_from_url MCP tool"
```

---

### Task 5: Build, Install, and E2E Test

- [ ] **Step 1: Build the modified Connector**

```bash
cd /Users/zxd/zotpilot-connector
npm install
./build.sh -d
# Verify agentAPI.js is included:
grep "AgentAPI" build/browserExt/background.js && echo "OK: AgentAPI found in build"
```

- [ ] **Step 2: Load in Chrome**

1. Open `chrome://extensions/`
2. Disable the official Zotero Connector (to avoid conflicts)
3. Enable Developer mode
4. Click "Load unpacked" → select `/Users/zxd/zotpilot-connector/build/browserExt/`
5. Verify extension loads without errors (check service worker console)

- [ ] **Step 3: Start bridge and test E2E**

```bash
# Terminal 1: Start bridge
cd /Users/zxd/ZotPilot
uv run zotpilot bridge

# Terminal 2: Verify bridge is running
curl -s http://127.0.0.1:2619/status
# Expected: {"bridge": "running", "port": 2619}

# Terminal 2: Enqueue a save command via POST /enqueue
curl -s -X POST http://127.0.0.1:2619/enqueue \
  -H "Content-Type: application/json" \
  -d '{"action":"save","url":"https://www.sciencedirect.com/science/article/pii/S0029801826006669"}'
# Response: {"request_id": "abc123def456"}

# Wait ~30s, poll for result via GET /result/<request_id>:
sleep 30
curl -s http://127.0.0.1:2619/result/abc123def456
```

Note: The bridge's `/pending` endpoint is GET (polled by extension), so the E2E test uses the bridge's Python API directly or a test script.

- [ ] **Step 4: Verify in Zotero**

Check Zotero desktop for the new paper:
- Title: "Numerical and experimental hydrodynamic assessment..."
- Authors present (populated by Zotero Translator)
- PDF attached (if institutional access available)
- Saved to correct collection (if specified)

- [ ] **Step 5: Verify existing Connector functionality**

Manually navigate to a paper page in Chrome and click the Connector icon — should save normally.

- [ ] **Step 6: Run full ZotPilot test suite**

```bash
cd /Users/zxd/ZotPilot
uv run ruff check src tests
uv run pytest -q
```

- [ ] **Step 7: Commit**

```bash
cd /Users/zxd/zotpilot-connector
git add -A
git commit -m "build: include agentAPI.js in extension build"

cd /Users/zxd/ZotPilot
git add -A
git commit -m "test: verify bridge + save_from_url E2E flow"
```

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| MV3 service worker killed during save | `setKeepServiceWorkerAlive(true)` during save (existing pattern); polling itself resets 30s idle timer |
| Bridge not running | `save_from_url` auto-starts bridge via `BridgeServer.auto_start()` |
| Concurrent saves | `_busy` flag serializes saves; `request_id` UUID correlates results |
| Tab left open on error | `finally` block in `_handleSave` always calls `browser.tabs.remove()` |
| Zotero desktop not running | Connector already handles this (error message or fallback to web API) |
| Extension conflicts with official Connector | User must disable official Connector before loading fork |
| Translator not detected in time | 3-second delay after page load; if still no translator, falls back to `saveAsWebpage` (existing behavior) |
| Save hangs indefinitely | 60s timeout in `_pendingSaves`; 90s timeout in `save_from_url` polling |
| Single-thread HTTP deadlock | Solved by `ThreadingHTTPServer` — handles concurrent requests |

## Acceptance Criteria

1. Extension builds without errors (`./build.sh -d` succeeds)
2. `agentAPI.js` is loaded in the background service worker (verified via `chrome://extensions` console: "AgentAPI: initialized")
3. Bridge starts and responds to `GET /status` → `{"bridge": "running"}`
4. `save_from_url(url)` triggers save: tab opens, Translator runs, paper saved to Zotero
5. Result returned to MCP tool: `{success: true, title: "..."}`
6. PDF attached when institutional access is available
7. Existing Connector functionality unaffected (manual click still works)
8. Extension runs normally when bridge is not running (no errors in console)
9. ZotPilot test suite passes (`uv run pytest -q`)
10. Bridge tests pass (`uv run pytest tests/test_bridge.py -v`)

---

## RALPLAN-DR ADR

**Decision:** HTTP Polling bridge between MCP server and Chrome extension.

**Drivers:** Need institutional PDF access (browser cookies); must be simple to deploy; must not break existing Connector.

**Alternatives considered:**
- WebSocket in Offscreen Document — rejected: offscreen lifecycle risks, over-engineered for MVP
- Native Messaging — rejected: platform-specific binary packaging, complex user install
- CDP (Chrome DevTools Protocol) — rejected: Chrome 146+ ignores `--remote-debugging-port` on macOS
- AppleScript keystroke simulation — rejected: requires accessibility permissions, macOS-only
- Playwright with user profile — rejected: triggers anti-scraping; can't run alongside user's Chrome

**Why chosen:** HTTP polling with `fetch()` works in MV3 service workers without any new Chrome APIs. The 2-second poll serves double duty as service worker keep-alive. `ThreadingHTTPServer` (stdlib) handles concurrent requests without deadlock. Auto-start from `save_from_url` minimizes user friction.

**Consequences:**
- 2-second latency floor (acceptable for paper saving)
- Extension must have bridge running (auto-started) to process agent commands
- One save at a time (serialized via `_busy` flag)

**Follow-ups:**
- **PDF path completion detection**: `contentTypeHandler.js` sends `progressWindow.done` via `tabs.sendMessage` (background→inject), which bypasses the `receiveMessage` monkey-patch. Direct PDF/RIS downloads will save correctly in Zotero but `save_from_url` receives a timeout instead of success. Fix by instrumenting `contentTypeHandler` or polling `tabInfo` for saved state.
- **Collection/tag routing**: `collection_key` and `tags` are accepted by the API but not yet consumed by `agentAPI.js` — `onZoteroButtonElementClick` saves to Zotero's default location. Implement by passing these to the Connector's save options.
- Batch save: queue multiple URLs, process sequentially
- Firefox support (WebExtension API compatible)
- Auto-start bridge as thread inside MCP server process (eliminate separate process)

## Review History

### Architect v1 (APPROVE-WITH-RESERVATIONS)
- Applied: ThreadingHTTPServer (not HTTPServer) to avoid deadlock
- Applied: Auto-start bridge from save_from_url
- Applied: Polling IS keep-alive — documented as design strength
- Applied: 90s timeout with tab cleanup

### Critic v1 (REVISE)
- Applied: `_browserAction` → `onZoteroButtonElementClick` (public API)
- Applied: Save completion detection via `progressWindow.done` listener scoped by tab ID
- Applied: Exact build integration point: `backgroundIncludeBrowserExt` in `gulpfile.js:151`
- Applied: HTTP API contract (JSON shapes for /pending, /result, /status)
- Applied: Wait for translator detection before triggering save (3s after page load)
- Applied: `Zotero.initDeferred.promise` for safe initialization timing

### Architect v2 (REQUEST-CHANGES)
- Applied: `addMessageListener` is singleton-slot → replaced with `receiveMessage` monkey-patch that observes + always forwards
- Applied: `save_from_url` was creating second server → replaced with pure HTTP client (POST /enqueue + poll GET /result/<id>)
- Applied: Added `POST /enqueue` and `GET /result/<id>` endpoints to bridge
- Applied: `_waitForReady` race condition noted (tab may already be complete) — added to implementation note

### Critic v2 (REVISE — 3 surgical fixes)
- Applied: Deleted dead `return result` line (unreachable, undefined name, would fail ruff F821)
- Applied: Replaced blind 3s delay with `_pollForTranslators` loop (500ms × 10 attempts on `getTabInfo().translators`)
- Applied: Fixed E2E curl commands (POST /pending → POST /enqueue, result?id= → result/<id>)
- Noted: `collection_key` and `tags` are accepted in API but not consumed by extension — documented as known MVP limitation
- Noted: `setKeepServiceWorkerAlive` before try block — benign, Chrome recycles anyway

### Architect v3 (APPROVE)
- Applied: Shared `onReady` callback for dangling `onUpdated` listener cleanup
- Applied: Immutable `enqueue()` — defensive copy of command dict

### Critic v3 (ACCEPT-WITH-RESERVATIONS)
- Accepted: contentTypeHandler PDF path not intercepted by receiveMessage monkey-patch — save succeeds in Zotero but result reports timeout. Documented as known MVP limitation in Follow-ups.
- Noted: `save_from_url` docstring should mention collection_key/tags are not yet applied
- Noted: `_handleSave` comment references "onTranslators callback" which doesn't exist — fix comment during implementation
