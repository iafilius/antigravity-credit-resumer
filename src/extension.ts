import * as vscode from 'vscode';
import { detectProcesses, DetectedProcess } from './process-detector';
import { queryCreditStatusForProcess } from './credit-monitor';
import { AutoResumer, isCurrentWorkspaceProcess, findTargetWorkspaceProcess } from './auto-resumer';
import { setFileLoggerOutputChannel, initializeHistoryReport, appendToLogFile, rotateDebugLog } from './file-logger';
import { triggerDeveloperUpdate } from './developer-updater';

let pollTimer: NodeJS.Timeout | undefined;
let activityChannel: vscode.OutputChannel | undefined;
let debugChannel: vscode.OutputChannel | undefined;
let autoResumer: AutoResumer | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let currentExtensionPath: string | undefined;

function hasAntigravityHostPresence(): boolean {
  try {
    return Boolean(
      vscode.extensions?.getExtension?.('google.google-antigravity') ||
      vscode.extensions?.getExtension?.('google.antigravity')
    );
  } catch {
    return false;
  }
}

// In-memory cache to store discovered language server processes and resolved ports
const cachedProcesses = new Map<number, DetectedProcess>();
let tickCount = 0;

export async function resolveWindowProcessFromAgyExtension(currentWorkspaceFsPath?: string): Promise<DetectedProcess | undefined> {
  try {
    const extIds = ['google.google-antigravity', 'google.antigravity'];
    for (const id of extIds) {
      const ext = vscode.extensions?.getExtension?.(id);
      if (!ext) continue;

      const exportsObj: any = ext.isActive ? ext.exports : await ext.activate();
      if (!exportsObj) continue;

      const csrfToken: string | undefined = exportsObj.csrfToken || exportsObj.client?.csrfToken;
      let port: number | undefined = typeof exportsObj.port === 'number' ? exportsObj.port : exportsObj.client?.port;

      if (!port && typeof exportsObj.client?.serverUrl === 'string') {
        const m = exportsObj.client.serverUrl.match(/:(\d+)\/?$/);
        if (m) {
          port = parseInt(m[1], 10);
        }
      }

      if (csrfToken && port && port > 0) {
        const workspacePaths = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
        let matchedPid = process.pid;
        for (const cached of cachedProcesses.values()) {
          if (cached.csrfToken === csrfToken || (cached.ports && cached.ports.includes(port))) {
            matchedPid = cached.pid;
            break;
          }
        }
        return {
          pid: matchedPid,
          csrfToken,
          extensionServerPort: port,
          extensionServerCsrfToken: csrfToken,
          workspaceId: currentWorkspaceFsPath || 'global',
          workspacePaths: workspacePaths.length > 0 ? workspacePaths : undefined,
          ports: [port],
        };
      }
    }
  } catch {
    // Fall back to OS process discovery if built-in extension API is unavailable
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext) {
  const version = context.extension?.packageJSON?.version || '0.8.1';
  currentExtensionPath = context.extensionPath;

  // Create separated output channels
  activityChannel = vscode.window.createOutputChannel('Antigravity Credit Resumer Activity');
  debugChannel = vscode.window.createOutputChannel('Antigravity Credit Resumer (Debug)');

  activityChannel.appendLine(`Antigravity Credit Auto-Resumer v${version} Activity Log initialized.`);
  debugChannel.appendLine(`Antigravity Credit Auto-Resumer v${version} Debug Log initialized.`);

  // Create Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(credit-card) AGY: Init';
  statusBarItem.tooltip = `Antigravity Credit Auto-Resumer v${version} is initializing`;
  statusBarItem.command = 'antigravityCreditResumer.showActivity';

  // Register command to show activity logs
  const showActivityCmd = vscode.commands.registerCommand('antigravityCreditResumer.showActivity', () => {
    activityChannel?.show();
  });
  context.subscriptions.push(showActivityCmd);

  // Register command for developer update
  const developerUpdateCmd = vscode.commands.registerCommand('antigravityCreditResumer.developerUpdate', () => {
    if (activityChannel) {
      triggerDeveloperUpdate(context, activityChannel);
    }
  });
  context.subscriptions.push(developerUpdateCmd);

  // Read configuration to determine if status bar should be visible
  const showStatusBar = vscode.workspace.getConfiguration('antigravityCreditResumer').get<boolean>('showStatusBar', true);
  if (showStatusBar) {
    statusBarItem.show();
  }
  context.subscriptions.push(statusBarItem);

  autoResumer = new AutoResumer(activityChannel, debugChannel, statusBarItem, version);

  // Setup file logging OutputChannel, rotate old debug logs, and initialize the report
  setFileLoggerOutputChannel(activityChannel);
  rotateDebugLog();
  initializeHistoryReport().then(() => {
    const now = new Date().toLocaleString();
    const intervalSeconds = vscode.workspace.getConfiguration('antigravityCreditResumer').get<number>('checkInterval', 60);
    const mode = vscode.workspace.getConfiguration('antigravityCreditResumer').get<string>('modelSelectionMode', 'stick');
    const logMsg = `| \`${process.pid}\` | \`${now}\` | **Resumer Init (v${version})** | Monitoring interval: ${intervalSeconds}s, mode: \`${mode}\` | Ready |\n`;
    appendToLogFile('resumer-history.md', logMsg);
  });

  // Initial call and start polling
  setupPolling();

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('antigravityCreditResumer.checkInterval')) {
        activityChannel?.appendLine('Polling interval configuration changed. Re-initializing timer...');
        setupPolling();
      }
      if (e.affectsConfiguration('antigravityCreditResumer.showStatusBar')) {
        const show = vscode.workspace.getConfiguration('antigravityCreditResumer').get<boolean>('showStatusBar', true);
        if (show) {
          statusBarItem?.show();
        } else {
          statusBarItem?.hide();
        }
      }
      if (e.affectsConfiguration('antigravityCreditResumer.persistentLogging')) {
        const enabled = vscode.workspace.getConfiguration('antigravityCreditResumer').get<boolean>('persistentLogging', true);
        activityChannel?.appendLine(`Persistent logging configuration changed. Enabled: ${enabled}`);
      }
    })
  );

  // Listen for user interaction events (window focus gain, active text editor change) for swift tick evaluation
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) {
        scheduleDebouncedTick();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      scheduleDebouncedTick();
    })
  );
}

let eventDebounceTimer: NodeJS.Timeout | undefined;
function scheduleDebouncedTick() {
  if (eventDebounceTimer) {
    clearTimeout(eventDebounceTimer);
  }
  eventDebounceTimer = setTimeout(() => {
    eventDebounceTimer = undefined;
    pollIntervalTick();
  }, 500);
}

let startupRetryTimer: NodeJS.Timeout | undefined;
let startupRetryCount = 0;
let reconnectRetryTimer: NodeJS.Timeout | undefined;
let reconnectRetryCount = 0;

export function deactivate() {
  if (startupRetryTimer) {
    clearTimeout(startupRetryTimer);
    startupRetryTimer = undefined;
  }
  if (reconnectRetryTimer) {
    clearTimeout(reconnectRetryTimer);
    reconnectRetryTimer = undefined;
  }
  if (eventDebounceTimer) {
    clearTimeout(eventDebounceTimer);
    eventDebounceTimer = undefined;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  if (activityChannel) {
    activityChannel.dispose();
    activityChannel = undefined;
  }
  if (debugChannel) {
    debugChannel.dispose();
    debugChannel = undefined;
  }
  if (statusBarItem) {
    statusBarItem.dispose();
    statusBarItem = undefined;
  }
  autoResumer = undefined;
  cachedProcesses.clear();
}

function setupPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  if (startupRetryTimer) {
    clearTimeout(startupRetryTimer);
    startupRetryTimer = undefined;
  }
  startupRetryCount = 0;

  const intervalSeconds = vscode.workspace
    .getConfiguration('antigravityCreditResumer')
    .get<number>('checkInterval', 60); // Default to 60 seconds to save CPU/battery

  const startMsg = `Starting credit monitoring loop. Interval: ${intervalSeconds} seconds.`;
  activityChannel?.appendLine(startMsg);
  appendToLogFile('resumer-debug.log', `[${new Date().toLocaleString()}] ${startMsg}\n`);

  tickCount = 0;
  pollIntervalTick(); // Immediate execution
  pollTimer = setInterval(pollIntervalTick, intervalSeconds * 1000);
}

async function pollIntervalTick() {
  if (!autoResumer) return;

  try {
    const currentWorkspaceFsPath = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
      ? vscode.workspace.workspaceFolders[0].uri.fsPath
      : undefined;

    const intervalSeconds = vscode.workspace
      .getConfiguration('antigravityCreditResumer')
      .get<number>('checkInterval', 60);
    autoResumer.recordPoll(intervalSeconds);

    // Tier 1: Direct in-process extension bridge from built-in `google.google-antigravity`
    let targetProcess = await resolveWindowProcessFromAgyExtension(currentWorkspaceFsPath);

    // Tier 2: OS Process & Port Discovery fallback
    if (!targetProcess) {
      // 1. Prune dead processes from cache
      const deadPids: number[] = [];
      for (const pid of cachedProcesses.keys()) {
        let proc: DetectedProcess | undefined;
        try {
          process.kill(pid, 0); // Check if PID exists
          proc = cachedProcesses.get(pid);
        } catch (err: any) {
          if (err.code === 'ESRCH') {
            deadPids.push(pid);
            continue;
          } else {
            // PID exists but cannot signal (EPERM), retain cached process
            proc = cachedProcesses.get(pid);
          }
        }
        if (!proc || !proc.ports || proc.ports.length === 0) {
          deadPids.push(pid);
        }
      }
      for (const pid of deadPids) {
        cachedProcesses.delete(pid);
      }

      // 2. Check if we currently have a cached process for this window
      targetProcess = await findTargetWorkspaceProcess(Array.from(cachedProcesses.values()), currentWorkspaceFsPath);

      // 3. If target process is missing from cache or every 10th tick, perform a discovery shell scan (ps/lsof)
      if (!targetProcess || tickCount % 10 === 0) {
        autoResumer.log('Running process discovery shell scan...');
        const discovered = await detectProcesses();
        cachedProcesses.clear();
        for (const proc of discovered) {
          if (proc.ports && proc.ports.length > 0) {
            cachedProcesses.set(proc.pid, proc);
          }
        }
        targetProcess = await findTargetWorkspaceProcess(discovered, currentWorkspaceFsPath);
      }
    }

    tickCount++;

    if (!targetProcess) {
      autoResumer.log(`No active Antigravity Language Server process found matching workspace: ${currentWorkspaceFsPath || 'global'}`);

      // Schedule rapid sub-second retry if we are below max retries on startup (10 retries at 500ms)
      if (startupRetryCount < 10) {
        autoResumer.handleApiDark();
        startupRetryCount++;
        autoResumer.log(`Scheduling rapid startup retry ${startupRetryCount}/10 in 500ms...`);
        if (startupRetryTimer) clearTimeout(startupRetryTimer);
        startupRetryTimer = setTimeout(() => {
          startupRetryTimer = undefined;
          pollIntervalTick();
        }, 500);
      } else if (reconnectRetryCount < 3) {
        // Mid-session rapid reconnection retry (3 retries at 3000ms)
        autoResumer.handleApiDark();
        autoResumer.evaluateDiskVersionGuard(currentExtensionPath);
        reconnectRetryCount++;
        autoResumer.log(`Scheduling rapid reconnect retry ${reconnectRetryCount}/3 in 3000ms...`);
        if (reconnectRetryTimer) clearTimeout(reconnectRetryTimer);
        reconnectRetryTimer = setTimeout(() => {
          reconnectRetryTimer = undefined;
          pollIntervalTick();
        }, 3000);
      } else {
        if (hasAntigravityHostPresence()) {
          autoResumer.handleSchemaDrift(
            'Antigravity IDE is active, but neither google.google-antigravity exports nor OS process CLI flags matched expected format after 3 retries'
          );
        } else {
          autoResumer.handleApiDark();
        }
        autoResumer.evaluateDiskVersionGuard(currentExtensionPath);
      }
      return;
    }

    // Reset rapid retry counts once process is successfully attached
    startupRetryCount = 0;

    autoResumer.log(`Processing PID ${targetProcess.pid} for current workspace (${targetProcess.workspaceId || 'global'})...`);
    let credits = await queryCreditStatusForProcess(targetProcess);

    // If Tier 1 extension bridge port failed transiently, fallback once to Tier 2 OS process discovery
    if (!credits) {
      const discovered = await detectProcesses();
      cachedProcesses.clear();
      for (const proc of discovered) {
        if (proc.ports && proc.ports.length > 0) {
          cachedProcesses.set(proc.pid, proc);
        }
      }
      const fallbackProcess = await findTargetWorkspaceProcess(discovered, currentWorkspaceFsPath);
      if (fallbackProcess) {
        targetProcess = fallbackProcess;
        credits = await queryCreditStatusForProcess(targetProcess);
      }
    }

    if (credits) {
      reconnectRetryCount = 0;
      if (reconnectRetryTimer) {
        clearTimeout(reconnectRetryTimer);
        reconnectRetryTimer = undefined;
      }
      await autoResumer.processTick(targetProcess, credits, currentWorkspaceFsPath);
      autoResumer.evaluateDiskVersionGuard(currentExtensionPath);
    } else {
      autoResumer.log(`Failed to query credits for PID ${targetProcess.pid} on ports: ${targetProcess.ports.join(', ')}${autoResumer.isWaitingForRefill(targetProcess.pid) ? ' [REFILL WAIT]' : ''}`);
      // Evict failed process from cache so next tick performs rediscovery
      cachedProcesses.delete(targetProcess.pid);

      if (reconnectRetryCount < 3) {
        autoResumer.handleApiDark(targetProcess);
        autoResumer.evaluateDiskVersionGuard(currentExtensionPath);
        reconnectRetryCount++;
        autoResumer.log(`Scheduling rapid credit query retry ${reconnectRetryCount}/3 in 3000ms...`);
        if (reconnectRetryTimer) clearTimeout(reconnectRetryTimer);
        reconnectRetryTimer = setTimeout(() => {
          reconnectRetryTimer = undefined;
          pollIntervalTick();
        }, 3000);
      } else {
        autoResumer.handleSchemaDrift(
          `Process PID ${targetProcess.pid} is running, but GetUserStatus failed across all ports (${targetProcess.ports.join(', ')}) after 3 retries`,
          targetProcess
        );
        autoResumer.evaluateDiskVersionGuard(currentExtensionPath);
      }
    }
  } catch (err: any) {
    const errMsg = `Error in monitoring tick: ${err?.message || err}`;
    activityChannel?.appendLine(errMsg);
    appendToLogFile('resumer-debug.log', `[${new Date().toLocaleString()}] [Error] ${errMsg}\n`);
  }
}
