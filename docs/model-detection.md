# Model Detection

This document explains how the Antigravity Credit Auto-Resumer determines which AI model is currently active in the IDE — a non-trivial problem because the local language server API does not expose a simple "current model" field.

---

## The Problem

The language server's `GetUserStatus` API returns a field called `defaultOverrideModelConfig` that looks like it should identify the active model. In practice it is **static** — it does not update when the user switches models via the IDE's model selector dropdown. As a result, the extension must infer the active model from several indirect signals.

---

## Data Sources

The extension combines three data sources on every polling tick:

| Source | API Endpoint | What it Provides |
|---|---|---|
| **User Status** | `GET /GetUserStatus` | Credit pools, all model quota fractions (`remainingFraction`), and the static `defaultOverrideModelConfig` |
| **Trajectory Metadata** | `GET /GetAllCascadeTrajectories` | All conversation/cascade summaries, each containing the model used (`requestedModel`), modification timestamps, and workspace URIs |
| **State Memory** | In-process per-PID state | `lastSelectedModel` — the model resolved on the previous tick, and `lastModelQuotas` — a snapshot of quota fractions from the previous tick |

---

## The 6-Step Resolution Heuristic

The function `resolveActiveModelId()` in [`src/auto-resumer.ts`](../src/auto-resumer.ts) resolves the active model on every tick using a strict priority waterfall. The first step that produces a result wins — later steps are never evaluated.

```
resolveActiveModelId()  priority waterfall
═══════════════════════════════════════════════════════════════

  STEP 1 ▸ Explicit VS Code Configuration
  ──────────────────────────────────────────────
  • Read configuration value from gemini.model (or custom key)
  ✓ RETURN if set (bypasses all heuristics)

  STEP 2 ▸ Active Transcript Tail
  ──────────────────────────────────────────────
  • Locate latest conversation transcript on disk
  • Scan tail for <USER_SETTINGS_CHANGE> settings injection blocks
  ✓ RETURN the newly selected model ID if found

  STEP 3 ▸ Last Active Model (Sticky State)
  ──────────────────────────────────────────────
  • If a model was already active in the previous tick, preserve it
  ✓ RETURN lastActiveModelId

  STEP 4 ▸ Quota Delta Tracking
  ──────────────────────────────────────────────
  • Compare current model quotas against previous tick
  • If a model's remaining fraction decreased, it was used
  ✓ RETURN that model

  STEP 5 ▸ Global Default Override
  ──────────────────────────────────────────────
  • Check defaultOverrideModelConfig from GetUserStatus response
  ✓ RETURN defaultOverrideModelConfig if valid

  STEP 6 ▸ Fallback
  ──────────────────────────────────────────────
  • Return the first available model from the status list
```

---

## Workspace Scoping

When multiple VS Code windows are open simultaneously (each for a different project), all windows share the same language server process and the same trajectory pool. Without workspace scoping, a trajectory from Window A could incorrectly dominate model detection for Window B.

**How it works:** Each detected process has a `workspaceId` derived from the URI of the workspace root folder (e.g. `file_Users_arjan_personal_antigravity-credit-resumer`). During Step 2, the extension locates the active transcript for the current workspace by matching the workspace URI in step 0 metadata. Transcripts from other workspaces are ignored.

---

## Known Limitation: Immediate UI Model Switch

Switching the active model via the chat panel's dropdown does **not** update any VS Code settings or immediately notify the backend. The dropdown selection is only sent to the Language Server when the user submits their next command.

**What actually happens when you switch models:**

```
t = 0s    User switches Gemini Flash → Claude Sonnet in dropdown
t = 0s    Plugin still shows Gemini Flash
           (Step 3 sticky state wins: Gemini Flash remains active)

t = 0s    User sends first message on Claude Sonnet
           (IDE writes settings change and prompt to transcript)

t = 1–60s Next polling tick fires
           Step 2: transcript tail has <USER_SETTINGS_CHANGE> for Claude Sonnet
           Plugin detects Claude Sonnet ✓
```

**Detection latency after switch:** 0–60 seconds following the first message sent on the new model (bounded by the configured `checkInterval`). If the resumer is suspended waiting for a refill, you can manually trigger resumption by typing a command (e.g., `"continue"`) in the chat panel using the newly selected model.

---

## Polling and Event-Driven Triggers

Model detection runs on every monitoring tick. Ticks are triggered by:

| Trigger | When it fires |
|---|---|
| **Background timer** | Every `checkInterval` seconds (default: 60s, configurable) |
| **Window focus** | Immediately when the IDE window gains focus |
| **Active editor change** | Immediately when the user switches to a different open file |

The event-driven triggers ensure that switching to the IDE after sending a message on a new model will update the status bar immediately, without waiting for the background timer to fire.

---

## Test Coverage

The detection heuristic is covered by the unit test suite in [`tests/auto-resumer.test.ts`](../tests/auto-resumer.test.ts). Key test scenarios:

| Test | Covers |
|---|---|
| Detect in-use Claude Sonnet when static default has 100% quota | Step 5 fallback |
| Quota delta tracking when remainingFraction decreases | Step 2 |
| Manual UI switch when `defaultOverrideModelConfig` changes | Step 3 |
| Last active model persistence when quota < 99.9% | Step 4 |
| Zero-quota selected model override | Step 3 / Step 4 interaction |
| Trajectory-based detection after first message on new model | Step 1 wins over Step 4 |
| Workspace scoping — ignore trajectories from other workspaces | Step 1 workspace filter |
