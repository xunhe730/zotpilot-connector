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
 * onZoteroButtonElementClick → detects completion via receiveMessage intercept
 * on progressWindow.done → posts result back to bridge.
 *
 * The 2-second poll interval also serves as MV3 service worker keep-alive.
 */
Zotero.AgentAPI = new function() {
	const BRIDGE_URL = "http://127.0.0.1:2619";
	const POLL_INTERVAL = 2000;
	let _polling = false;
	let _pollTimer = null;
	let _busy = false;

	// Map<tabId, {resolve: Function}> — pending save completions
	let _pendingSaves = new Map();

	/**
	 * Start polling. Called after Zotero.initDeferred resolves.
	 *
	 * Installs a receiveMessage wrapper to intercept progressWindow.done
	 * messages without breaking existing dispatch. messaging.js uses
	 * singleton _messageListeners slots — addMessageListener would
	 * replace any existing handler. The monkey-patch observes AND always
	 * forwards to the original handler.
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
	 *   2. Wait for page load + poll for translator detection
	 *   3. Set up completion promise via _pendingSaves Map
	 *   4. Call onZoteroButtonElementClick(tab) — public API, same as user click
	 *   5. Wait for progressWindow.done → resolved by receiveMessage intercept
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

			// 2. Wait for page load + translator detection
			await _waitForReady(tab.id, 30000);

			// 3. Set up completion promise BEFORE triggering save
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
