# Changelog

## [0.0.2] - 2026-03-24

质量巩固版本，无新功能。

### Fixed
- **receiveMessage patch**：修复 defense-in-depth 路径长期失效的问题。inject 侧消息以 `["Messaging.sendMessage", [name, args]]` 格式到达，导致原始检查永远无法匹配 `progressWindow.done`。现在正确解包后再检测，备用完成检测路径恢复工作。

### Added
- **单元测试**：新增 `test/tests/agentAPITest.mjs`，15 个测试覆盖 agentAPI.js 全部核心路径（80%+ 行覆盖率）
- `test/agentAPI.mocharc.js` 独立 mocha 配置，`npm run test:unit` 脚本，与现有 E2E 测试完全隔离

### Documentation
- `PROTOCOL.md` 版本号修正（错误的 `0.1.0` → `0.0.2`）
- 明确 `collection_key`/`tags` 在扩展侧是 echo-only，实际 Zotero API 路由由 bridge 负责
- 注明错误响应不包含 `collection_key`/`tags`（有意为之）

## [0.0.1] - 2026-03-24

### Added
- Initial ZotPilot Agent API (`agentAPI.js`) with HTTP polling bridge support
- Dual monkey-patch completion detection (sendMessage primary + receiveMessage defense)
- Heartbeat mechanism (every 10s) with Zotero connectivity check
- `PROTOCOL.md` v1.0.0 HTTP bridge specification
