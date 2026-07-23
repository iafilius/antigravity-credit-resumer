import * as https from 'https';
import * as vscode from 'vscode';
import { DetectedProcess } from './process-detector';
import { UserCreditsStatus, ModelQuotaInfo } from './credit-monitor';
import { appendToLogFile } from './file-logger';

interface ResumerState {
  modelExhausted: boolean;
  waitingForRefill: boolean;
  lastSelectedModel: string;
  lastPromptCredits?: number;
  lastFlowCredits?: number;
  lastRemainingFraction?: number;
}

export class AutoResumer {
  private activityChannel: vscode.OutputChannel;
  private debugChannel: vscode.OutputChannel;
  private statusBarItem?: vscode.StatusBarItem;
  private states = new Map<number, ResumerState>();

  constructor(activityChannel: vscode.OutputChannel, debugChannel: vscode.OutputChannel, statusBarItem?: vscode.StatusBarItem) {
    this.activityChannel = activityChannel;
    this.debugChannel = debugChannel;
    this.statusBarItem = statusBarItem;
  }

  public log(msg: string) {
    const debug = vscode.workspace.getConfiguration('antigravityCreditResumer').get<boolean>('debugLogging', false);
    if (debug) {
      const logStr = `[${new Date().toLocaleString()}] [AutoResumer Debug] ${msg}\n`;
      this.debugChannel.appendLine(`[AutoResumer Debug] ${msg}`);
      appendToLogFile('resumer-debug.log', logStr);
    }
  }

  public async processTick(proc: DetectedProcess, credits: UserCreditsStatus) {
    const config = vscode.workspace.getConfiguration('antigravityCreditResumer');
    const mode = config.get<string>('modelSelectionMode', 'stick');
    const resumePrompt = config.get<string>('resumePrompt', 'continue');

    // Get current state or initialize
    let state = this.states.get(proc.pid);
    if (!state) {
      state = {
        modelExhausted: false,
        waitingForRefill: false,
        lastSelectedModel: '',
      };
      this.states.set(proc.pid, state);
    }

    // Print credit changes if any pool changes
    if (
      state.lastPromptCredits !== credits.availablePromptCredits ||
      state.lastFlowCredits !== credits.availableFlowCredits
    ) {
      this.activityChannel.appendLine(
        `[AutoResumer] Pid ${proc.pid} (${proc.workspaceId || 'global'}): Prompt Credits = ${credits.availablePromptCredits}, Flow Credits = ${credits.availableFlowCredits}`
      );
      state.lastPromptCredits = credits.availablePromptCredits;
      state.lastFlowCredits = credits.availableFlowCredits;
    }

    // 1. Identify currently active/selected model
    const currentModelId = credits.rawResponse?.userStatus?.cascadeModelConfigData?.defaultOverrideModelConfig?.modelOrAlias?.model || '';
    if (!currentModelId) {
      return;
    }

    if (state.lastSelectedModel !== currentModelId) {
      this.activityChannel.appendLine(`[AutoResumer] Pid ${proc.pid}: Selected model changed to ${currentModelId}`);
      state.lastSelectedModel = currentModelId;
    }

    // Find current model's quota info
    const currentModelQuota = credits.models.find(m => m.model === currentModelId);
    const hasRemainingFraction = currentModelQuota && currentModelQuota.remainingFraction !== undefined;
    const remainingFraction = hasRemainingFraction ? currentModelQuota!.remainingFraction! : 1.0;

    const isExhausted = remainingFraction <= 0.001; // Quota <= 0%

    // Update Status Bar Item
    if (this.statusBarItem) {
      const showStatusBar = vscode.workspace.getConfiguration('antigravityCreditResumer').get<boolean>('showStatusBar', true);
      if (showStatusBar) {
        const modelLabel = currentModelQuota?.label || currentModelId;
        const shortModelName = getShortModelLabel(modelLabel);
        const quotaPercentageText = hasRemainingFraction ? `${(remainingFraction * 100).toFixed(0)}%` : '∞';
        this.statusBarItem.text = `$(credit-card) AGY: ${credits.availablePromptCredits}p/${credits.availableFlowCredits}a cr (${shortModelName}: ${quotaPercentageText})`;
        
        const quotaPercentage = hasRemainingFraction ? `${(remainingFraction * 100).toFixed(1)}%` : 'Unlimited';
        const resetStr = currentModelQuota?.resetTime ? formatResetTime(currentModelQuota.resetTime, currentModelQuota.remainingFraction) : (currentModelQuota?.remainingFraction !== undefined && currentModelQuota.remainingFraction >= 0.999 ? 'Full Quota' : 'N/A');

        // Construct list of all model quotas
        const modelQuotasLines = credits.models.map(m => {
          const isCurrent = m.model === currentModelId;
          const labelStr = isCurrent ? `**${m.label} (Active)**` : m.label;
          
          let detailStr = 'Unlimited';
          if (m.remainingFraction !== undefined) {
            const pct = (m.remainingFraction * 100).toFixed(1);
            const resetVal = m.resetTime ? formatResetTime(m.resetTime, m.remainingFraction) : (m.remainingFraction >= 0.999 ? 'Full Quota' : 'N/A');
            detailStr = `${pct}% (refills ${resetVal})`;
          }
          return `• ${labelStr}: ${detailStr}`;
        }).join('\n');

        const tooltip = new vscode.MarkdownString(
          `**Antigravity Credit Auto-Resumer**\n\n` +
          `### 👤 Active Model Status\n` +
          `• **Model**: ${modelLabel}\n` +
          `• **Quota Remaining**: ${quotaPercentage}\n` +
          `• **Next Reset / Refill**: ${resetStr}\n\n` +
          `---\n\n` +
          `### 💳 Credit Pools (Current / Monthly)\n` +
          `• **Prompt Credits**: ${credits.availablePromptCredits} cr${credits.monthlyPromptCredits ? ` / ${credits.monthlyPromptCredits.toLocaleString()} cr` : ''}\n` +
          `• **AI Credits**: ${credits.availableFlowCredits} cr${credits.monthlyFlowCredits ? ` / ${credits.monthlyFlowCredits.toLocaleString()} cr` : ''}\n\n` +
          `---\n\n` +
          `### 📊 All Model Quotas (Rate Limits)\n` +
          `${modelQuotasLines}\n\n` +
          `---\n\n` +
          `👉 [Open Activity Logs](command:antigravityCreditResumer.showActivity) | [🔄 Rebuild & Update](command:antigravityCreditResumer.developerUpdate)`
        );
        tooltip.isTrusted = true;
        this.statusBarItem.tooltip = tooltip;

        if (isExhausted) {
          this.statusBarItem.text = `$(alert) AGY: Refill Pending`;
          this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else {
          this.statusBarItem.backgroundColor = undefined;
        }
        this.statusBarItem.show();
      } else {
        this.statusBarItem.hide();
      }
    }

    // Only log model quota ticks if it changed significantly (>= 1%) or state transitioned
    const fractionDiff = state.lastRemainingFraction !== undefined ? Math.abs(state.lastRemainingFraction - remainingFraction) : 1.0;
    const exhaustionStateChanged = state.modelExhausted !== isExhausted;

    if (fractionDiff >= 0.01 || exhaustionStateChanged) {
      this.log(
        `Pid ${proc.pid} (${currentModelId}): remainingFraction=${remainingFraction.toFixed(4)}, exhausted=${isExhausted}, state.waiting=${state.waitingForRefill}`
      );
      state.lastRemainingFraction = remainingFraction;
    }

    if (isExhausted) {
      state.modelExhausted = true;

      if (!state.waitingForRefill) {
        this.log(`Pid ${proc.pid}: Model ${currentModelId} ran out of credits!`);
        state.waitingForRefill = true;
        const now = new Date().toLocaleString();
        appendToLogFile(
          'resumer-history.md',
          `| \`${proc.pid}\` | \`${now}\` | **Quota Exhausted** | Model \`${currentModelId}\` reached 0% | Suspended |\n`
        );
      }

      if (mode === 'auto') {
        // Find candidate models with remaining credits (> 5%)
        const candidateModels = credits.models.filter(m => {
          if (m.model === currentModelId) return false;
          if (m.remainingFraction === undefined) return true; // Assume unlimited/no limit info
          return m.remainingFraction > 0.05; // Has at least 5% credits
        });

        // Sort candidates:
        // 1. Same family match (e.g. Flash -> Flash, Pro -> Pro, Sonnet -> Sonnet)
        // 2. Highest remainingFraction
        const currentFamily = getShortModelLabel(currentModelQuota?.label || currentModelId).split(' ').pop() || '';
        candidateModels.sort((a, b) => {
          const aFamily = getShortModelLabel(a.label || a.model).split(' ').pop() || '';
          const bFamily = getShortModelLabel(b.label || b.model).split(' ').pop() || '';
          const aMatch = aFamily && currentFamily && aFamily === currentFamily ? 1 : 0;
          const bMatch = bFamily && currentFamily && bFamily === currentFamily ? 1 : 0;
          if (aMatch !== bMatch) return bMatch - aMatch;

          const aQuota = a.remainingFraction ?? 1.0;
          const bQuota = b.remainingFraction ?? 1.0;
          return bQuota - aQuota;
        });

        const alternateModel = candidateModels[0];

        if (alternateModel) {
          this.log(`Pid ${proc.pid}: Found alternate model ${alternateModel.label} (${alternateModel.model}) with remaining credits.`);
          const now = new Date().toLocaleString();
          appendToLogFile(
            'resumer-history.md',
            `| \`${proc.pid}\` | \`${now}\` | **Model Switch** | Switched from \`${currentModelId}\` to \`${alternateModel.model}\` | Switching |\n`
          );
          const showNotifications = vscode.workspace.getConfiguration('antigravityCreditResumer').get<boolean>('showNotifications', true);
          if (showNotifications) {
            vscode.window.showInformationMessage(
              `[AGY Resumer] Exhausted ${currentModelId}. Switched active cascade model to ${alternateModel.label}.`,
              'Show Logs'
            ).then(selection => {
              if (selection === 'Show Logs') {
                vscode.commands.executeCommand('antigravityCreditResumer.showActivity');
              }
            });
          }
          await this.resumeActiveCascade(proc, alternateModel.model, resumePrompt);
          state.waitingForRefill = false;
          state.modelExhausted = false;
        } else {
          this.log(`Pid ${proc.pid}: No alternate models with available credits found. Waiting for refill...`);
        }
      }
    } else {
      // Current model has credits
      if (state.waitingForRefill) {
        this.log(`Pid ${proc.pid}: Model ${currentModelId} has been refilled (remainingFraction=${remainingFraction.toFixed(4)})!`);
        const now = new Date().toLocaleString();
        appendToLogFile(
          'resumer-history.md',
          `| \`${proc.pid}\` | \`${now}\` | **Quota Refilled** | Model \`${currentModelId}\` refilled to ${(remainingFraction * 100).toFixed(1)}% | Refilled |\n`
        );
        await this.resumeActiveCascade(proc, currentModelId, resumePrompt);
        state.waitingForRefill = false;
      }
      state.modelExhausted = false;
    }
  }

  private async resumeActiveCascade(proc: DetectedProcess, modelId: string, promptText: string) {
    this.activityChannel.appendLine(`[AutoResumer] Attempting to resume active cascade for process PID ${proc.pid} using model ${modelId}...`);

    const trajectories = await this.getAllTrajectories(proc);
    if (!trajectories || Object.keys(trajectories).length === 0) {
      this.log(`Pid ${proc.pid}: No trajectories found to resume.`);
      const now = new Date().toLocaleString();
      appendToLogFile(
        'resumer-history.md',
        `| \`${proc.pid}\` | \`${now}\` | **Cascade Resumed** | No active trajectories found to resume | Idle |\n`
      );
      return;
    }

    // Find the most recently modified trajectory
    let activeTrajectoryId: string | null = null;
    let maxTime = 0;

    for (const id of Object.keys(trajectories)) {
      const traj = trajectories[id];
      const modTimeStr = traj.lastModifiedTime || traj.lastUserInputTime || '';
      if (modTimeStr) {
        const time = new Date(modTimeStr).getTime();
        if (time > maxTime) {
          maxTime = time;
          activeTrajectoryId = traj.trajectoryId || id;
        }
      }
    }

    if (!activeTrajectoryId) {
      // Fallback to first key
      activeTrajectoryId = Object.keys(trajectories)[0];
    }

    if (activeTrajectoryId) {
      this.activityChannel.appendLine(
        `[AutoResumer] Resuming cascade ${activeTrajectoryId} with prompt "${promptText}" using model ${modelId}`
      );
      const success = await this.sendCascadeMessage(proc, activeTrajectoryId, modelId, promptText);
      const now = new Date().toLocaleString();
      if (success) {
        this.activityChannel.appendLine(`[AutoResumer] Successfully resumed cascade ${activeTrajectoryId}.`);
        appendToLogFile(
          'resumer-history.md',
          `| \`${proc.pid}\` | \`${now}\` | **Cascade Resumed** | Resumed trajectory \`${activeTrajectoryId.substring(0, 8)}\` via model \`${modelId}\` | Success |\n`
        );
        const showNotifications = vscode.workspace.getConfiguration('antigravityCreditResumer').get<boolean>('showNotifications', true);
        if (showNotifications) {
          vscode.window.showInformationMessage(
            `[AGY Resumer] Automatically resumed cascade (${activeTrajectoryId.substring(0, 8)}) for model ${modelId}.`,
            'Show Logs'
          ).then(selection => {
            if (selection === 'Show Logs') {
              vscode.commands.executeCommand('antigravityCreditResumer.showActivity');
            }
          });
        }
      } else {
        this.activityChannel.appendLine(`[AutoResumer] Failed to resume cascade ${activeTrajectoryId}.`);
        appendToLogFile(
          'resumer-history.md',
          `| \`${proc.pid}\` | \`${now}\` | **Cascade Resumed** | Failed to resume trajectory \`${activeTrajectoryId.substring(0, 8)}\` via model \`${modelId}\` | Failure |\n`
        );
      }
    }
  }

  private getAllTrajectories(proc: DetectedProcess): Promise<any | null> {
    return new Promise((resolve) => {
      const payload = JSON.stringify({
        metadata: {
          ideName: 'antigravity',
          extensionName: 'antigravity',
          locale: 'en',
        },
      });

      // Try all candidate ports
      let resolved = false;
      for (const port of proc.ports) {
        const options: https.RequestOptions = {
          hostname: '127.0.0.1',
          port: port,
          path: '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories',
          method: 'POST',
          rejectUnauthorized: false,
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'X-Codeium-Csrf-Token': proc.csrfToken,
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 2000,
        };

        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            if (res.statusCode === 200 && !resolved) {
              resolved = true;
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                resolve(null);
              }
            }
          });
        });

        req.on('error', () => {});
        req.write(payload);
        req.end();
      }

      setTimeout(() => {
        if (!resolved) {
          resolve(null);
        }
      }, 2500);
    });
  }

  private sendCascadeMessage(proc: DetectedProcess, trajectoryId: string, modelId: string, messageText: string): Promise<boolean> {
    return new Promise((resolve) => {
      const payload = JSON.stringify({
        message: messageText,
        selectedCascadeId: trajectoryId,
        requestedModel: {
          model: modelId,
        },
        metadata: {
          ideName: 'antigravity',
          extensionName: 'antigravity',
          locale: 'en',
        },
      });

      // Send to ports
      let resolved = false;
      for (const port of proc.ports) {
        const options: https.RequestOptions = {
          hostname: '127.0.0.1',
          port: port,
          path: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
          method: 'POST',
          rejectUnauthorized: false,
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'X-Codeium-Csrf-Token': proc.csrfToken,
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 3000,
        };

        const req = https.request(options, (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            if (res.statusCode === 200 && !resolved) {
              resolved = true;
              resolve(true);
            }
          });
        });

        req.on('error', () => {});
        req.write(payload);
        req.end();
      }

      setTimeout(() => {
        if (!resolved) {
          resolve(false);
        }
      }, 3500);
    });
  }
}

export function formatResetTime(resetTimeStr: string, remainingFraction?: number): string {
  if (remainingFraction !== undefined && remainingFraction >= 0.999) {
    return 'Full Quota';
  }

  try {
    const resetDate = new Date(resetTimeStr);
    if (isNaN(resetDate.getTime())) {
      return 'N/A';
    }
    const now = new Date();
    const diffMs = resetDate.getTime() - now.getTime();
    if (diffMs <= 0) {
      return 'Pending Refill';
    }

    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    let relativeStr = '';
    if (diffDays > 0) {
      relativeStr = `${diffDays}d ${diffHours % 24}h`;
    } else if (diffHours > 0) {
      relativeStr = `${diffHours}h ${diffMins % 60}m`;
    } else {
      relativeStr = `${diffMins}m`;
    }

    const isToday = resetDate.toDateString() === now.toDateString();
    const timeStr = resetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    let absoluteStr = '';
    if (isToday) {
      absoluteStr = `Today at ${timeStr}`;
    } else {
      const month = String(resetDate.getMonth() + 1).padStart(2, '0');
      const day = String(resetDate.getDate()).padStart(2, '0');
      absoluteStr = `${month}/${day} at ${timeStr}`;
    }

    return `in ${relativeStr} (${absoluteStr})`;
  } catch (e) {
    return 'N/A';
  }
}

export function getShortModelLabel(label: string): string {
  if (!label) return 'Unknown';

  const versionMatch = label.match(/(\d+\.\d+)/);
  const version = versionMatch ? versionMatch[1] : '';

  let tier = '';
  if (label.includes('(High)')) tier = '-H';
  else if (label.includes('(Medium)')) tier = '-M';
  else if (label.includes('(Low)')) tier = '-L';

  if (label.includes('Flash')) {
    return version ? `${version} Flash${tier}` : `Flash${tier}`;
  }
  if (label.includes('Pro')) {
    return version ? `${version} Pro${tier}` : `Pro${tier}`;
  }
  if (label.includes('Sonnet')) {
    return version ? `Sonnet ${version}` : 'Sonnet';
  }
  if (label.includes('Opus')) {
    return version ? `Opus ${version}` : 'Opus';
  }
  if (label.includes('GPT-OSS')) {
    return 'GPT-OSS';
  }

  const cleaned = label.replace(/^(Gemini|Claude)\s+/i, '').trim();
  return cleaned || label.split(' ').slice(0, 2).join(' ');
}

