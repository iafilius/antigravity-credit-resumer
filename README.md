# Antigravity Credit Auto-Resumer

An extension for Antigravity IDE (and VS Code) that monitors your AI model credits locally and automatically resumes active conversations. Designed to **eliminate manual AI babysitting** during long-running execution jobs—allowing your tasks to keep progressing automatically while you sleep or focus on other work.

Depending on your choice of settings, it either **waits for credit quotas to refresh and then resumes**, or **automatically switches to another model with available credits and resumes** immediately.

---

## 1. What It Does

1.  **Process Discovery**: Automatically scans local processes to find running instances of the Antigravity Language Server and extracts their CSRF tokens.
2.  **Port Mapping**: Discovers the dynamic local HTTPS/gRPC ports that the target processes are listening on.
3.  **Credit Status Monitoring**: Queries the local Connect RPC `/GetUserStatus` endpoint to monitor prompt/flow credits and individual model quotas.
4.  **Model Detection**: Automatically tracks which AI model is currently active in the IDE using a multi-signal heuristic — combining trajectory metadata, quota consumption deltas, and configuration data. Updates within one polling tick after you send a message on a newly selected model.
5.  **Auto-Resume Cascade**: Depending on your chosen settings (`stick` mode), waits for model credits to refresh and then automatically sends `"continue"` (or your custom prompt) to resume active conversations/cascades.
6.  **Smart Model Switching**: In `auto` mode, automatically switches to another model with available credits when the current model is exhausted, and then resumes the active cascade immediately.
7.  **Persistent Logging**: Mirrors all activity to `.logs/resumer-debug.log` and maintains an append-only resumption history at `.logs/resumer-history.md` inside the active workspace.
8.  **Clean Lifecycle**: Runs entirely in-memory and cleanly terminates all background timers and Output Channels upon extension unload, leaving no trace on disk beyond the `.logs/` directory.

---

## 2. Configuration Settings

You can configure these settings in the IDE Settings editor:

*   **`antigravityCreditResumer.modelSelectionMode`** (`string`):
    *   `stick` (Default): Stay with your currently selected model and wait for its credits to refresh.
    *   `auto`: Automatically switch to any other recommended model with positive credits when the current model runs out.
*   **`antigravityCreditResumer.resumePrompt`** (`string`):
    *   `continue` (Default): The standard message that Antigravity quickly understands.
    *   *Custom*: Any text prompt you wish to submit when resuming (e.g., `"resume"`).
*   **`antigravityCreditResumer.checkInterval`** (`integer`):
    *   Frequency in seconds to query local credits (Default: `60`).
*   **`antigravityCreditResumer.debugLogging`** (`boolean`):
    *   Enable detailed logging (Default: `false`).
    *   *Where to find logs*: Open the bottom dock in the IDE, click on the **Output** tab (next to Terminal), and select **"Antigravity Credit Resumer"** from the drop-down menu in the top-right corner of that panel.
*   **`antigravityCreditResumer.showStatusBar`** (`boolean`):
    *   Show credit status indicator in the bottom status bar (Default: `true`).
*   **`antigravityCreditResumer.showNotifications`** (`boolean`):
    *   Show toast notification actions when a cascade is auto-continued or model is switched (Default: `true`).
*   **`antigravityCreditResumer.persistentLogging`** (`boolean`):
    *   Mirror all logs to `.logs/resumer-debug.log` and maintain a resumption history at `.logs/resumer-history.md` in the active workspace (Default: `true`). Log files are rotated at 5 MB.

---

## 3. Installation via Homebrew (Recommended)

You can install and keep the extension updated automatically via Homebrew:

```bash
# Add dedicated tap
brew tap iafilius/tap

# Install extension (automatically provisions into Antigravity IDE and VS Code)
brew install antigravity-credit-resumer

# Upgrade to latest version anytime
brew upgrade antigravity-credit-resumer
```

The formula installs the `.vsix` into Homebrew's shared repository and triggers immediate auto-installation into Antigravity IDE. You can also re-trigger the IDE installation or inspect the package path via the CLI helper:

```bash
antigravity-credit-resumer install   # Install / re-provision extension into IDE
antigravity-credit-resumer path      # Print path to cached .vsix package
antigravity-credit-resumer version   # Print version
```

---

## 4. Local Installation & Testing

To build and run the extension locally:

### Step 1: Build & Package
Run the following command in the extension directory to install dependencies, compile, and package the extension into a `.vsix` file:
```bash
make package
```
This generates a package file named `antigravity-credit-resumer-0.5.0.vsix` in your root directory.

### Step 2: Install in the IDE
You can install the packaged extension directly using the Makefile:
```bash
make install-ide
```
Alternatively, to install it manually through the UI:
1.  Open the Command Palette (`Cmd+Shift+P` on macOS or `Ctrl+Shift+P` on Windows/Linux).
2.  Search for and run: **`Extensions: Install from VSIX...`**
3.  Choose the generated `antigravity-credit-resumer-0.5.0.vsix` file.
4.  Reload the window to activate.

---

## 5. Registering & Publishing on Open VSX

Open VSX is an open-source alternative registry to the Microsoft VS Code Marketplace.

### Step 1: Create an Account & Namespace
1.  Go to [open-vsx.org](https://open-vsx.org/) and log in/register using GitHub, GitLab, or Google.
2.  Navigate to your profile and create a **Namespace** (e.g., `arjan`). The namespace must match the `publisher` field in your `package.json`.
    *   *Note*: Ensure that the `publisher` field in `package.json` matches your registered namespace.

### Step 2: Generate an Access Token
1.  In your Open VSX profile page, go to **Access Tokens**.
2.  Generate a new token with write access for publishing. Save the token securely.

### Step 3: Publish
You can publish the extension directly using the Makefile:
```bash
make publish TOKEN=<YOUR_OPEN_VSX_TOKEN>
```
This automatically packages the extension and uploads the resulting `.vsix` file to the Open VSX registry.

---

## 6. Documentation

*   **[docs/architecture.md](docs/architecture.md)** — Full technical overview: process discovery, credit monitoring, trajectory detection, automated continuation, and sleep/wake behavior.
*   **[docs/model-detection.md](docs/model-detection.md)** — Deep dive into model detection: the 6-step `resolveActiveModelId()` heuristic, data sources, workspace scoping, known limitations, and test coverage.
*   **[CHANGELOG.md](CHANGELOG.md)** — Version history.
