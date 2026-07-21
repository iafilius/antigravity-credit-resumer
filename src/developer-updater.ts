import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

let isUpdating = false;

export async function triggerDeveloperUpdate(context: vscode.ExtensionContext, activityChannel: vscode.OutputChannel) {
  if (isUpdating) {
    vscode.window.showWarningMessage('[AGY Resumer] An update is already in progress.');
    return;
  }

  // Get active workspace folder
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('[AGY Resumer] Developer update requires an open workspace.');
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  isUpdating = true;
  activityChannel.appendLine('[DeveloperUpdater] Triggered developer update...');

  // Show progress indicator
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "AGY Resumer: Rebuilding and packaging extension...",
    cancellable: false
  }, async (progress) => {
    return new Promise<void>((resolve) => {
      exec('make package', { cwd: workspaceRoot }, async (error, stdout, stderr) => {
        isUpdating = false;
        
        if (error) {
          activityChannel.appendLine(`[DeveloperUpdater] Build failed: ${error.message}`);
          activityChannel.appendLine(`[DeveloperUpdater] Stderr: ${stderr}`);
          vscode.window.showErrorMessage('[AGY Resumer] Build failed! Check activity logs for details.', 'Show Logs').then(selection => {
            if (selection === 'Show Logs') {
              activityChannel.show();
            }
          });
          resolve();
          return;
        }

        activityChannel.appendLine('[DeveloperUpdater] Build succeeded. Discovered package version...');
        
        try {
          // Read version and name from package.json
          const packageJsonPath = path.join(workspaceRoot, 'package.json');
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          const version = packageJson.version;
          const name = packageJson.name;
          const vsixFilename = `${name}-${version}.vsix`;
          const vsixPath = path.join(workspaceRoot, vsixFilename);

          if (!fs.existsSync(vsixPath)) {
            throw new Error(`Expected packaged VSIX file does not exist at: ${vsixPath}`);
          }

          activityChannel.appendLine(`[DeveloperUpdater] Installing packaged extension: ${vsixFilename}`);
          progress.report({ message: "Installing packaged extension..." });

          // Call VS Code install command
          await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
          
          activityChannel.appendLine('[DeveloperUpdater] Extension successfully updated.');
          vscode.window.showInformationMessage(
            `[AGY Resumer] Extension updated successfully to version ${version}. Please reload to activate.`,
            'Reload Window'
          ).then(selection => {
            if (selection === 'Reload Window') {
              vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
          });
        } catch (err: any) {
          activityChannel.appendLine(`[DeveloperUpdater] Installation failed: ${err.message || err}`);
          vscode.window.showErrorMessage(`[AGY Resumer] Installation failed: ${err.message || err}`);
        }

        resolve();
      });
    });
  });
}
