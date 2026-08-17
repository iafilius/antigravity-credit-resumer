# Changelog

All notable changes to the Antigravity Credit Auto-Resumer extension are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.5.0] — 2026-08-09

### Added
- **`resetTime` Timestamp Validation**: Automated resumption now verifies that the model's `resetTime` has elapsed (`currentTime >= resetTime`) before triggering a continuation prompt, preventing premature resume attempts caused by transient local RPC cache resets.
- **Upstream Resume Failure Recovery**: If `SendUserCascadeMessage` encounters an upstream failure or HTTP 429 rate limit error, the resumer retains `waitingForRefill = true` and logs the failure, ensuring the background polling loop stays active until quota truly renews.
- **Unit Test Coverage**: Added tests in `tests/auto-resumer.test.ts` for future `resetTime` resumption inhibition and `waitingForRefill` retention on upstream failure.

### Fixed
- **Status Bar Tooltip Reset Time Formatting**: Corrected `formatResetTime` to display relative refill countdowns (e.g. `in 1h 33m`) whenever `resetTime` is in the future, preventing inaccurate `"Full Quota"` status display during transient local RPC resets.

---

## [0.4.0] — 2026-08-02

### Added
- `docs/model-detection.md`: New dedicated reference document explaining the 6-step `resolveActiveModelId()` heuristic, data sources, workspace scoping, and the known limitation for immediate UI model switches
- `CHANGELOG.md`: This file — full version history in Keep a Changelog format

### Changed
- `docs/architecture.md`: Full overhaul — fixed stale file path references (old repo name `agy_continue_when_new_credits`), updated Mermaid flow diagram to reflect event-driven triggers and refill recovery logic, added Persistent Logging section, linked to new `docs/model-detection.md`
- `README.md`: Updated version references to v0.4.0, added `persistentLogging` setting, added Model Detection section, added Documentation links section, fixed VSIX filename in install instructions
- `package.json`: Version bumped from `0.3.0` to `0.4.0`

---

## [0.3.0] — 2026-08-01

### Added
- **Visible versioning**: Extension version (`vX.Y.Z`) now displayed in the status bar tooltip header and footer, Output Channel startup banners, and persistent log headers
- **Unit test infrastructure**: `vitest` test suite with 30+ unit tests covering `resolveActiveModelId()`, `formatResetTime()`, status bar tooltip rendering, and process list parsing — with full VS Code API mocking so tests run in Node.js without booting VS Code
- **Integration test scaffold**: `@vscode/test-electron` integration test harness for VS Code API-level testing
- **Model label refinement**: Status bar short labels now preserve version numbers (e.g. `3.6`, `3.5`) and tier designations (e.g. `-H`, `-M`, `-L`) for distinct model identification (e.g. `3.6 Flash-H` vs `3.5 Flash-M`)
- **Model deduplication**: Status bar tooltip model list filters duplicate `clientModelConfigs` entries returned by the language server
- **"Full Quota" label**: Models at 100% quota display `Full Quota` instead of `Pending Refill` in the tooltip

### Changed
- **Workspace scoping for trajectory model inspection**: `resolveActiveModelId()` now filters trajectory candidates by the target process's `workspaceId`, ignoring trajectories from unrelated open workspaces
- **Model switching detection fixes**: Removed sticky "In-Use Model Fallback" logic that overrode `defaultOverrideModelConfig` when switching to fresh models at 100% quota; trajectory metadata now takes priority when it belongs to the active workspace
- **Swift manual model exhaustion detection**: Event-driven polling triggers on IDE window focus and active document changes, reducing detection latency from up to 60 seconds to near-instant; models manually switched to 0% quota are immediately detected without waiting for the next background tick
- **Refill recovery threshold**: Resumption now triggers when quota transitions from depleted or low quota (< 5%) back to ≥ 50%, capturing refill events that occurred between polling intervals
- **Process eviction protection**: Cached PIDs are now only evicted if `process.kill(pid, 0)` returns `ESRCH` (process not found); `EPERM` errors no longer falsely discard active monitored processes
- **Multi-window PID tracking**: `resumer-history.md` rows now include the monitoring process PID as a distinct column, enabling log separation across multiple open VS Code windows

---

## [0.2.0] — 2026-07-05

### Added
- **Persistent disk logging**: All activity and debug logs are mirrored to `.logs/resumer-debug.log` inside the active workspace root; high-frequency ticks are only written when `debugLogging` is enabled
- **Log rotation**: On activation, if `resumer-debug.log` exceeds 5 MB it is renamed to `resumer-debug.log.bak` before a fresh log file is started
- **Historical resumption report**: An append-only Markdown table at `.logs/resumer-history.md` records extension initialization, quota exhaustion events, model switches, and cascade resumption results
- **Makefile GitHub publish workflow**: `make push-github` safely syncs clean production files and pushes incremental commits to GitHub without history divergence; `make sync` now clones the existing repository instead of initializing a disconnected root commit

---

## [0.1.0] — Initial Release

### Added
- Background polling loop querying `/GetUserStatus` every 60 seconds
- Automated cascade resumption via `/SendUserCascadeMessage` on credit refill
- `stick` mode: wait for the active model's quota to refill before resuming
- `auto` mode: switch to any alternate model with > 5% quota remaining and resume immediately
- Process and port discovery via `ps -ax` / `wmic` and `lsof` / `netstat`
- Status bar indicator with credit quota display and hover tooltip
- Toast notifications with `[Show Logs]` action on cascade resume or model switch
- Separate `Activity` and `Debug` output channels
- Configurable resume prompt, check interval, and debug logging settings
- Sleep / suspend behavior documentation and macOS `caffeinate` workaround guidance
