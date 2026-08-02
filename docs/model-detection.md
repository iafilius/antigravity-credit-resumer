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

  STEP 1 ▸ Workspace-Scoped Trajectory Inspection
  ──────────────────────────────────────────────
  • Fetch all trajectories from GetAllCascadeTrajectories
  • Filter to those matching the target process workspaceId
  • From matching trajectories, pick the one with the latest
    lastModifiedTime or lastUserInputTime timestamp
  • Read its requestedModel.modelOrAlias.model field
  ✓ RETURN if a model ID is found

  STEP 2 ▸ Quota Delta Tracking
  ──────────────────────────────────────────────
  • Compare current remainingFraction for each model against
    lastModelQuotas snapshot from the previous tick
  • If any model's quota decreased by > 0.01% since last tick,
    it consumed tokens → that model is active
  ✓ RETURN the model whose quota dropped

  STEP 3 ▸ Explicit UI Switch Detection
  ──────────────────────────────────────────────
  • Read defaultOverrideModelConfig from GetUserStatus response
  • If it differs from lastSelectedModel → user switched in UI
  ✓ RETURN defaultOverrideModelConfig
  ⚠ In practice this step rarely fires — see Known Limitation below

  STEP 4 ▸ Last Active Model Persistence
  ──────────────────────────────────────────────
  • If lastSelectedModel has quota < 99.9% (it has been used)
    AND no stronger signal overrides it → preserve it
  ✓ RETURN lastSelectedModel
  ⚠ This is the "sticky lock" — the most common source of
    apparent "wrong model" display between model switches

  STEP 5 ▸ In-Use Fallback (no prior state)
  ──────────────────────────────────────────────
  • Only fires when no lastSelectedModel has been established yet
    (e.g. first tick after extension activation)
  • If defaultOverrideModelConfig is at 100% quota but another
    model is at < 99.9% → that other model is actively being used
  ✓ RETURN the < 99.9% model

  STEP 6 ▸ Default Fallback
  ──────────────────────────────────────────────
  • Return defaultOverrideModelConfig if set,
    otherwise the first model in the quota list
```

---

## Workspace Scoping

When multiple VS Code windows are open simultaneously (each for a different project), all windows share the same language server process and the same trajectory pool. Without workspace scoping, a trajectory from Window A could incorrectly dominate model detection for Window B.

**How it works:** Each detected process has a `workspaceId` derived from the URI of the workspace root folder (e.g. `file_Users_arjan_personal_antigravity-credit-resumer`). During Step 1, the extension only evaluates trajectories whose `workspaceFolderAbsoluteUri` matches this ID. Trajectories from other workspaces are silently ignored.

---

## Known Limitation: Immediate UI Model Switch

Switching the model in the IDE dropdown does **not** cause `defaultOverrideModelConfig` to update — it remains locked to whatever value it was initialized with. This makes Step 3 essentially a dead step in normal operation.

**What actually happens when you switch models:**

```
t = 0s    User switches Gemini Flash → Claude Sonnet in dropdown
t = 0s    Plugin still shows Gemini Flash
           (Step 4 persistence wins: Gemini Flash has < 99.9% quota)

t = 0s    User sends first message on Claude Sonnet

t = 1–60s Next polling tick fires
           Step 1: trajectory now has requestedModel = Claude Sonnet
           Plugin detects Claude Sonnet ✓
```

**Detection latency after switch:** 0–60 seconds following the first message sent on the new model (bounded by the configured `checkInterval`). The latency is further reduced by the event-driven triggers described below.

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
