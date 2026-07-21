import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

let activityChannel: vscode.OutputChannel | undefined;

export function setFileLoggerOutputChannel(channel: vscode.OutputChannel) {
  activityChannel = channel;
}

/**
 * Returns the path to the .logs/ directory under the workspace root.
 */
function getLogsDirectory(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }
  return path.join(folders[0].uri.fsPath, '.logs');
}

/**
 * Appends content to a file inside the active workspace's .logs/ folder.
 * Gracefully catches and logs any errors.
 */
export async function appendToLogFile(fileName: string, content: string): Promise<boolean> {
  const isEnabled = vscode.workspace.getConfiguration('antigravityCreditResumer').get<boolean>('persistentLogging', true);
  if (!isEnabled) {
    return false;
  }

  const logsDir = getLogsDirectory();
  if (!logsDir) {
    return false;
  }

  try {
    // 1. Ensure the directory exists
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const filePath = path.join(logsDir, fileName);
    // 2. Append the content asynchronously
    await fs.promises.appendFile(filePath, content, 'utf8');
    return true;
  } catch (error: any) {
    // Graceful error reporting: write warning to in-memory activity channel instead of crashing
    if (activityChannel) {
      activityChannel.appendLine(`[FileLogger Warning] Failed to write to ${fileName}: ${error?.message || error}`);
    }
    return false;
  }
}

/**
 * Ensures the history report markdown file exists and has appropriate table headers.
 */
export async function initializeHistoryReport(): Promise<void> {
  const fileName = 'resumer-history.md';
  const logsDir = getLogsDirectory();
  if (!logsDir) {
    return;
  }

  const filePath = path.join(logsDir, fileName);
  try {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    if (!fs.existsSync(filePath)) {
      const headers = 
        `# Antigravity Credit Resumer - Activity History\n\n` +
        `| PID | Local Timestamp | Event Type | Details | Status |\n` +
        `| :--- | :--- | :--- | :--- | :--- |\n`;
      await fs.promises.writeFile(filePath, headers, 'utf8');
    }
  } catch (error: any) {
    if (activityChannel) {
      activityChannel.appendLine(`[FileLogger Warning] Failed to initialize ${fileName}: ${error?.message || error}`);
    }
  }
}

/**
 * Rotates the debug log if it exceeds the 5MB size limit.
 */
export function rotateDebugLog(): void {
  const isEnabled = vscode.workspace.getConfiguration('antigravityCreditResumer').get<boolean>('persistentLogging', true);
  if (!isEnabled) {
    return;
  }

  const logsDir = getLogsDirectory();
  if (!logsDir) {
    return;
  }

  const debugLogPath = path.join(logsDir, 'resumer-debug.log');
  try {
    if (fs.existsSync(debugLogPath)) {
      const stats = fs.statSync(debugLogPath);
      const maxSize = 5 * 1024 * 1024; // 5 MB

      if (stats.size > maxSize) {
        const backupPath = path.join(logsDir, 'resumer-debug.log.bak');
        if (fs.existsSync(backupPath)) {
          fs.unlinkSync(backupPath); // Delete old backup
        }
        fs.renameSync(debugLogPath, backupPath);
        if (activityChannel) {
          activityChannel.appendLine(`[FileLogger] Rotated resumer-debug.log to resumer-debug.log.bak (size: ${(stats.size / (1024 * 1024)).toFixed(2)}MB exceeds 5MB).`);
        }
      }
    }
  } catch (error: any) {
    if (activityChannel) {
      activityChannel.appendLine(`[FileLogger Warning] Failed to rotate resumer-debug.log: ${error?.message || error}`);
    }
  }
}
