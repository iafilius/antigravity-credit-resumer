import * as vscode from 'vscode';
import { detectProcesses } from './process-detector';
import { queryCreditStatusForProcess } from './credit-monitor';
import { AutoResumer } from './auto-resumer';
import { setFileLoggerOutputChannel, initializeHistoryReport, appendToLogFile, rotateDebugLog } from './file-logger';
import { triggerDeveloperUpdate } from './developer-updater';

let pollTimer: NodeJS.Timeout | undefined;
let activityChannel: vscode.OutputChannel | undefined;
let debugChannel: vscode.OutputChannel | undefined;
let autoResumer: AutoResumer | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

// In-memory cache to store discovered language server processes and resolved ports
const cachedProcesses = new Map<number, any>();
let tickCount = 0;

export function activate(context: vscode.ExtensionContext) {
  const version = context.extension?.packageJSON?.version || '0.5.0';

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

export function deactivate() {
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
    // 1. Perform lightweight in-memory check to clean up dead cached processes
    const deadPids: number[] = [];
    for (const pid of cachedProcesses.keys()) {
      try {
        process.kill(pid, 0); // Standard POSIX check: returns true if running, throws if dead
      } catch (e: any) {
        if (e && e.code === 'ESRCH') {
          deadPids.push(pid);
        }
      }
    }
    for (const pid of deadPids) {
      cachedProcesses.delete(pid);
    }

    // 2. Only run shell scan (ps/lsof) if cache is empty or every 4th tick (to discover new windows)
    const cacheIsEmpty = cachedProcesses.size === 0;
    if (cacheIsEmpty || tickCount % 4 === 0) {
      autoResumer.log('Running process discovery shell scan...');
      const discovered = await detectProcesses();
      for (const proc of discovered) {
        cachedProcesses.set(proc.pid, proc);
      }
    }

    tickCount++;

    const processes = Array.from(cachedProcesses.values());
    if (processes.length === 0) {
      autoResumer.log('No active Antigravity Language Server processes found.');
      // Update Status Bar to indicate no active server
      if (statusBarItem) {
        statusBarItem.text = '$(credit-card) AGY: Idle';
        statusBarItem.tooltip = 'No active Antigravity Language Server processes found';
      }
      return;
    }

    for (const proc of processes) {
      autoResumer.log(`Processing PID ${proc.pid} (workspace: ${proc.workspaceId || 'global'})...`);
      const credits = await queryCreditStatusForProcess(proc);

      if (credits) {
        await autoResumer.processTick(proc, credits);
      } else {
        autoResumer.log(`Failed to query credits for PID ${proc.pid} on ports: ${proc.ports.join(', ')}`);
      }
    }
  } catch (err: any) {
    const errMsg = `Error in monitoring tick: ${err?.message || err}`;
    activityChannel?.appendLine(errMsg);
    appendToLogFile('resumer-debug.log', `[${new Date().toLocaleString()}] [Error] ${errMsg}\n`);
  }
}
