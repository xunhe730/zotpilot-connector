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
 * onZoteroButtonElementClick → detects completion via sendMessage monkey-patch
 * on progressWindow.done → posts result back to bridge.
 *
 * The 2-second poll interval also serves as MV3 service worker keep-alive.
 */
// Task 1.1: timestamp at load time
console.log("[ZotPilot] agentAPI.js loaded at " + Date.now());

Zotero.AgentAPI = new function() {
	const BRIDGE_URL = "http://127.0.0.1:2619";
	const POLL_INTERVAL = 2000;
	const SAVE_TIMEOUT_MS = 60000; // Task 1.2: 60s; reports "unconfirmed" not false success
	const HEARTBEAT_EVERY_N_POLLS = 5; // Task 1.4: every 5 polls = every 10s

	let _polling = false;
	let _pollTimer = null;
	let _busy = false;
	let _pollCount = 0; // Task 1.4: heartbeat counter

	// Map<tabId, {resolve, item_key, item_title}> — pending save completions
	let _pendingSaves = new Map();

	/**
	 * Start polling. Called after Zotero.initDeferred resolves.
	 *
	 * Task 1.2: Installs DUAL monkey-patches on the messaging layer:
	 *
	 * 1. sendMessage patch (PRIMARY): ALL progressWindow.done signals flow through
	 *    Zotero.Messaging.sendMessage — both content-script-originated (relayed via
	 *    MESSAGES config dispatch) and background-originated (contentTypeHandler.js).
	 *    This is the patch that actually fires.
	 *
	 * 2. receiveMessage patch (DEFENSE-IN-DEPTH): currently non-functional for
	 *    progressWindow.done because the inject-side sendMessage stub wraps the call
	 *    as ["Messaging.sendMessage", [...]] so receiveMessage sees messageName =
	 *    "Messaging.sendMessage", not "progressWindow.done". Retained as a safety
	 *    net against future upstream changes that might send progressWindow.done
	 *    directly via browser.runtime.sendMessage.
	 *
	 * Both patches always forward to the original handler — they only observe.
	 */
	this.init = async function() {
		// Task 1.1: milestone — init start
		console.log("[ZotPilot] AgentAPI.init() called at " + Date.now() + ", awaiting Zotero.initDeferred...");
		await Zotero.initDeferred.promise;
		// Task 1.1: milestone — initDeferred resolved
		console.log("[ZotPilot] Zotero.initDeferred resolved at " + Date.now());

		// --- receiveMessage patch (DEFENSE-IN-DEPTH, currently non-functional for
		//     progressWindow.done — see init() JSDoc above) ---
		const _originalReceive = Zotero.Messaging.receiveMessage.bind(Zotero.Messaging);
		Zotero.Messaging.receiveMessage = async function(messageName, args, tab, frameId) {
			if (messageName === "progressWindow.done" && tab && _pendingSaves.has(tab.id)) {
				let entry = _pendingSaves.get(tab.id);
				_pendingSaves.delete(tab.id);
				let success = args[0];
				let error = args.length > 1 ? args[1] : null;
				Zotero.debug("[ZotPilot] completion via receiveMessage patch (defense-in-depth)");
				entry.resolve({ success: !!success, error, _via: "receiveMessage" });
			}
			// ALWAYS forward to original — never swallow messages
			return _originalReceive(messageName, args, tab, frameId);
		};

		// --- sendMessage patch (PRIMARY completion detector) ---
		const _originalSend = Zotero.Messaging.sendMessage.bind(Zotero.Messaging);
		Zotero.Messaging.sendMessage = function(messageName, args, tab, frameId) {
			// Task 1.2: catch progressWindow.done for save completion
			if (messageName === "progressWindow.done" && tab && _pendingSaves.has(tab.id)) {
				let entry = _pendingSaves.get(tab.id);
				_pendingSaves.delete(tab.id);
				let success = args && args[0];
				let error = args && args.length > 1 ? args[1] : null;
				Zotero.debug("[ZotPilot] completion via sendMessage patch (primary)");
				entry.resolve({ success: !!success, error, _via: "sendMessage" });
			}
			// Task 1.3: intercept itemProgress to capture title and item_key.
			// Args is an object: { sessionID, id, iconSrc, title, itemsLoaded, itemType }
			// For saveAsWebpage path, items[0].key is set before sendMessage, so args.key
			// contains the real Zotero item key (~5% of saves). For standard translator
			// saves, args.key is absent — title is the primary identifier.
			if (messageName === "progressWindow.itemProgress" && tab && _pendingSaves.has(tab.id)) {
				let entry = _pendingSaves.get(tab.id);
				let payload = args || {};
				if (payload.title && !entry.item_title) entry.item_title = payload.title;
				if (payload.key && !entry.item_key) entry.item_key = payload.key;
			}
			// ALWAYS forward — observe only, never modify args
			return _originalSend(messageName, args, tab, frameId);
		};

		_polling = true;
		_schedulePoll();
		// Task 1.1: milestone — polling started
		console.log("[ZotPilot] AgentAPI polling started at " + Date.now());
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
			_pollCount++;

			// Task 1.4: send heartbeat every Nth poll (fire-and-forget)
			if (_pollCount % HEARTBEAT_EVERY_N_POLLS === 0) {
				_sendHeartbeat().catch(() => {});
			}

			console.log("[ZotPilot] poll /pending → " + response.status);
			if (response.status === 200) {
				let command = await response.json();
				console.log("[ZotPilot] received command:", JSON.stringify(command));
				if (command && command.action === "save" && command.url) {
					await _handleSave(command);
				}
			}
		} catch (e) {
			console.log("[ZotPilot] poll error: " + e.message);
		}
		_schedulePoll();
	}

	/**
	 * Task 1.4: POST heartbeat to bridge every HEARTBEAT_EVERY_N_POLLS polls.
	 * Checks Zotero connectivity by pinging localhost:23119/connector/ping.
	 * Fire-and-forget — failures are silently ignored.
	 */
	async function _sendHeartbeat() {
		let zoteroConnected = false;
		try {
			let resp = await fetch("http://127.0.0.1:23119/connector/ping", {
				method: "GET",
				signal: AbortSignal.timeout(2000),
			});
			zoteroConnected = resp.ok;
		} catch (e) {}

		await fetch(BRIDGE_URL + "/heartbeat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				extension_version: browser.runtime.getManifest().version,
				zotero_connected: zoteroConnected,
			}),
		});
	}

	/**
	 * Handle a save command.
	 *
	 * Flow:
	 *   1. Open tab (active:false)
	 *   2. Wait for page load + poll for translator detection
	 *   3. Set up completion promise via _pendingSaves Map
	 *   4. Call onZoteroButtonElementClick(tab) — public API, same as user click
	 *      Task 1.2: synchronous throw → save_trigger_failed (not a catch-all)
	 *   5. Wait for progressWindow.done → resolved by sendMessage patch (primary)
	 *      Task 1.2: 60s timeout → { success: "unconfirmed", error_code: "completion_unconfirmed" }
	 *   6. Post result with item_key/title (Task 1.3), detection telemetry (Task 1.2)
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

			// 2. Wait for page load + translator detection
			await _waitForReady(tab.id, 30000);

			// 3. Set up completion detection — keep local ref to entry so we can
			//    read item_key/item_title after the promise resolves (the Map entry
			//    is deleted by the patch that fires, but the object reference lives on)
			let entry = { resolve: null, item_key: null, item_title: null };
			let saveCompleted = new Promise((resolve) => {
				// Task 1.2: 60s timeout reports unconfirmed instead of false-positive success
				let timer = setTimeout(() => {
					_pendingSaves.delete(tab.id);
					Zotero.debug("[ZotPilot] save timeout (60s) — reporting unconfirmed");
					resolve({
						success: "unconfirmed",
						error_code: "completion_unconfirmed",
						error: "Save was triggered but no completion signal received within timeout. Check Zotero directly.",
						_via: "timeout",
					});
				}, SAVE_TIMEOUT_MS);
				entry.resolve = (result) => { clearTimeout(timer); resolve(result); };
				_pendingSaves.set(tab.id, entry);
			});

			// 4. Trigger save — Task 1.2: catch synchronous throw → save_trigger_failed.
			//    Do NOT fail early for missing translators — saveAsWebpage fallback handles those.
			tab = await browser.tabs.get(tab.id);
			try {
				Zotero.Connector_Browser.onZoteroButtonElementClick(tab);
			} catch (err) {
				_pendingSaves.delete(tab.id);
				await _postResult({
					request_id,
					success: false,
					error_code: "save_trigger_failed",
					error_message: err.message || String(err),
					url,
				});
				return;
			}

			// 5. Wait for completion
			let result = await saveCompleted;
			// Task 1.2: telemetry — log which patch fired
			Zotero.debug("[ZotPilot] save result: success=" + result.success + " via=" + result._via);

			// 6. Post result — Task 1.3: include item_key and title for bridge-side routing
			await _postResult({
				request_id,
				success: result.success,
				...(result.error_code ? { error_code: result.error_code } : {}),
				...(result.error ? { error_message: result.error } : {}),
				url,
				title: entry.item_title || tab.title || "",
				item_key: entry.item_key || null,
				collection_key: command.collection_key || null,
				tags: command.tags || [],
				_detected_via: result._via,
			});

		} catch (err) {
			Zotero.logError(err);
			await _postResult({
				request_id,
				success: false,
				error_code: "save_trigger_failed",
				error_message: err.message || String(err),
				url,
			});
		} finally {
			// 7. Close tab and clean up
			if (tabId) {
				try { await browser.tabs.remove(tabId); } catch (e) {}
				_pendingSaves.delete(tabId);
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
