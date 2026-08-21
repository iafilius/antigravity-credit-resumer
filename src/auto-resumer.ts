import * as https from 'https';
import * as vscode from 'vscode';
import { DetectedProcess } from './process-detector';
import { UserCreditsStatus, ModelQuotaInfo } from './credit-monitor';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { appendToLogFile } from './file-logger';
interface ResumerState {
  modelExhausted: boolean;
  waitingForRefill: boolean;
  lastSelectedModel: string;
  lastPromptCredits?: number;
  lastFlowCredits?: number;
  lastRemainingFraction?: number;
  lastModelQuotas?: Map<string, number>;
}

export class AutoResumer {
  private activityChannel: vscode.OutputChannel;
  private debugChannel: vscode.OutputChannel;
  private statusBarItem?: vscode.StatusBarItem;
  private extensionVersion: string;
  private states = new Map<number, ResumerState>();

  constructor(activityChannel: vscode.OutputChannel, debugChannel: vscode.OutputChannel, statusBarItem?: vscode.StatusBarItem, extensionVersion: string = '0.7.3') {
    this.activityChannel = activityChannel;
    this.debugChannel = debugChannel;
    this.statusBarItem = statusBarItem;
    this.extensionVersion = extensionVersion;
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

    // 1. Identify currently active/selected model dynamically
    const configKey = config.get<string>('modelSelectionConfigKey', 'gemini.model');
    const explicitConfigModelId = vscode.workspace.getConfiguration().get<string>(configKey);

    const rawTrajectories = await this.getAllTrajectories(proc);
    const currentModelId = resolveActiveModelId(credits, state.lastModelQuotas, state.lastSelectedModel, rawTrajectories, proc.workspaceId, explicitConfigModelId);
    if (!currentModelId) {
      return;
    }

    const isDebugEnabled = vscode.workspace.getConfiguration('antigravityCreditResumer').get<boolean>('debugLogging', false);
    if (isDebugEnabled) {
      this.log(`Pid ${proc.pid}: Active Model resolved as ${currentModelId}`);
    }

    if (state.lastSelectedModel !== currentModelId) {
      this.activityChannel.appendLine(`[AutoResumer] Pid ${proc.pid}: Selected model changed to ${currentModelId}`);
      state.lastSelectedModel = currentModelId;
    }

    // Record current model quotas for delta tracking on subsequent ticks
    const currentQuotas = new Map<string, number>();
    for (const m of credits.models) {
      if (m.model && m.remainingFraction !== undefined) {
        currentQuotas.set(m.model, m.remainingFraction);
      }
    }
    state.lastModelQuotas = currentQuotas;

    // Find current model's quota info
    const currentModelQuota = credits.models.find(m => m.model === currentModelId);
    const hasRemainingFraction = currentModelQuota && currentModelQuota.remainingFraction !== undefined;
    const remainingFraction = hasRemainingFraction ? currentModelQuota!.remainingFraction! : 1.0;

    const isExhausted = remainingFraction <= 0.001; // Quota <= 0%
    const isLowQuota = remainingFraction <= 0.05; // Quota <= 5%

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
          `**Antigravity Credit Auto-Resumer (v${this.extensionVersion})**\n\n` +
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
          `👉 [Open Activity Logs](command:antigravityCreditResumer.showActivity) | [🔄 Rebuild & Update](command:antigravityCreditResumer.developerUpdate) | *v${this.extensionVersion}*`
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

    if (isLowQuota) {
      state.modelExhausted = true;

      if (!state.waitingForRefill) {
        this.log(`Pid ${proc.pid}: Model ${currentModelId} reached low quota (${(remainingFraction * 100).toFixed(1)}%)! Flagged waiting for refill.`);
        state.waitingForRefill = true;
        const now = new Date().toLocaleString();
        appendToLogFile(
          'resumer-history.md',
          `| \`${proc.pid}\` | \`${now}\` | **Quota Exhausted** | Model \`${currentModelId}\` reached ${(remainingFraction * 100).toFixed(1)}% | Suspended |\n`
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
          const success = await this.resumeActiveCascade(proc, alternateModel.model, resumePrompt);
          if (success) {
            state.waitingForRefill = false;
            state.modelExhausted = false;
          }
        } else {
          this.log(`Pid ${proc.pid}: No alternate models with available credits found. Waiting for refill...`);
        }
      }
    } else {
      // Current model has available credits
      const resetTimePassed = !currentModelQuota?.resetTime || isNaN(new Date(currentModelQuota.resetTime).getTime()) || new Date() >= new Date(currentModelQuota.resetTime);
      const isRefilled = (state.waitingForRefill || (state.lastRemainingFraction !== undefined && state.lastRemainingFraction <= 0.05)) && remainingFraction >= 0.50 && resetTimePassed;
      if (isRefilled) {
        this.log(`Pid ${proc.pid}: Model ${currentModelId} has been refilled (remainingFraction=${remainingFraction.toFixed(4)})!`);
        const now = new Date().toLocaleString();
        appendToLogFile(
          'resumer-history.md',
          `| \`${proc.pid}\` | \`${now}\` | **Quota Refilled** | Model \`${currentModelId}\` refilled to ${(remainingFraction * 100).toFixed(1)}% | Refilled |\n`
        );
        const success = await this.resumeActiveCascade(proc, currentModelId, resumePrompt);
        if (success) {
          state.waitingForRefill = false;
        } else {
          this.log(`Pid ${proc.pid}: Resume attempt failed for model ${currentModelId}. Retaining waitingForRefill state.`);
          state.waitingForRefill = true;
        }
      }
      state.modelExhausted = false;
    }
  }

  private async resumeActiveCascade(proc: DetectedProcess, modelId: string, promptText: string): Promise<boolean> {
    this.activityChannel.appendLine(`[AutoResumer] Attempting to resume active cascade for process PID ${proc.pid} using model ${modelId}...`);

    const rawTrajectories = await this.getAllTrajectories(proc);
    const map = extractTrajectoryMap(rawTrajectories);
    const allIds = Object.keys(map);

    // Filter trajectories by workspace
    let candidateEntries = allIds
      .map(id => ({ id, traj: map[id] }))
      .filter(({ traj }) => matchesWorkspace(proc.workspaceId, traj));

    this.log(`Pid ${proc.pid}: Found ${allIds.length} total trajectories from RPC, ${candidateEntries.length} matched workspace (${proc.workspaceId || 'global'}).`);

    if (candidateEntries.length === 0) {
      const diskTraj = findLatestWorkspaceTrajectoryOnDisk(proc.workspaceId);
      if (diskTraj) {
        this.log(`Pid ${proc.pid}: Discovered active workspace trajectory on disk: ${diskTraj.id}`);
        candidateEntries = [{ id: diskTraj.id, traj: { trajectoryId: diskTraj.id, lastModifiedTime: new Date(diskTraj.mtime).toISOString() } }];
      } else if (allIds.length > 0) {
        this.log(`Pid ${proc.pid}: No workspace-matched trajectories found; falling back to all available trajectories.`);
        candidateEntries = allIds.map(id => ({ id, traj: map[id] }));
      }
    }

    if (candidateEntries.length === 0) {
      this.log(`Pid ${proc.pid}: No trajectories found to resume (raw keys=${Object.keys(rawTrajectories || {}).join(',')}).`);
      const now = new Date().toLocaleString();
      appendToLogFile(
        'resumer-history.md',
        `| \`${proc.pid}\` | \`${now}\` | **Cascade Resumed** | No active trajectories found to resume | Idle |\n`
      );
      return false;
    }

    // Find the most recently modified trajectory
    let activeTrajectoryId: string | null = null;
    let maxTime = 0;

    for (const { id, traj } of candidateEntries) {
      const modTimeStr = traj?.lastModifiedTime || traj?.lastUserInputTime || traj?.trajectoryMetadata?.createdAt || '';
      if (modTimeStr) {
        const time = new Date(modTimeStr).getTime();
        if (time > maxTime) {
          maxTime = time;
          activeTrajectoryId = traj?.trajectoryId || id;
        }
      }
    }

    if (!activeTrajectoryId) {
      activeTrajectoryId = candidateEntries[0].traj?.trajectoryId || candidateEntries[0].id;
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
        return true;
      } else {
        this.activityChannel.appendLine(`[AutoResumer] Failed to resume cascade ${activeTrajectoryId}.`);
        appendToLogFile(
          'resumer-history.md',
          `| \`${proc.pid}\` | \`${now}\` | **Cascade Resumed** | Failed to resume trajectory \`${activeTrajectoryId.substring(0, 8)}\` via model \`${modelId}\` | Failure |\n`
        );
        return false;
      }
    }
    return false;
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

export function formatResetTime(resetTimeStr?: string, remainingFraction?: number): string {
  if (resetTimeStr) {
    try {
      const resetDate = new Date(resetTimeStr);
      if (!isNaN(resetDate.getTime())) {
        const now = new Date();
        const diffMs = resetDate.getTime() - now.getTime();
        if (diffMs > 0) {
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
        }
      }
    } catch (e) {}
  }

  if (remainingFraction !== undefined && remainingFraction >= 0.999) {
    return 'Full Quota';
  }

  if (resetTimeStr) {
    try {
      const resetDate = new Date(resetTimeStr);
      if (!isNaN(resetDate.getTime())) {
        const now = new Date();
        if (resetDate.getTime() - now.getTime() <= 0) {
          return 'Pending Refill';
        }
      }
    } catch (e) {}
  }

  return 'N/A';
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

export interface DiskTrajectoryInfo {
  id: string;
  mtime: number;
  transcriptPath: string;
}

export function findLatestWorkspaceTrajectoryOnDisk(workspaceId?: string, customHomeDir?: string): DiskTrajectoryInfo | null {
  try {
    const brainDir = path.join(customHomeDir || os.homedir(), '.gemini', 'antigravity-ide', 'brain');
    if (!fs.existsSync(brainDir)) return null;

    const entries = fs.readdirSync(brainDir, { withFileTypes: true });
    const candidates: DiskTrajectoryInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name.includes('media') || entry.name.includes('scratch')) continue;

      const dirPath = path.join(brainDir, entry.name);
      const candidateFiles = ['transcript.jsonl', 'transcript_full.jsonl'];
      for (const fileName of candidateFiles) {
        const transcriptPath = path.join(dirPath, '.system_generated', 'logs', fileName);
        try {
          if (fs.existsSync(transcriptPath)) {
            const stat = fs.statSync(transcriptPath);
            candidates.push({ id: entry.name, mtime: stat.mtimeMs, transcriptPath });
            break;
          }
        } catch (e) {}
      }
    }

    // Sort newest transcript file first
    candidates.sort((a, b) => b.mtime - a.mtime);

    const procNorm = normalizeWorkspaceString(workspaceId || '');

    for (const candidate of candidates.slice(0, 30)) {
      try {
        if (!procNorm || procNorm === 'global') {
          return candidate;
        }

        // Fast check: Read up to 8KB from the head of the file to inspect workspace metadata in step 0
        const fd = fs.openSync(candidate.transcriptPath, 'r');
        const buffer = Buffer.alloc(8192);
        const bytesRead = fs.readSync(fd, buffer, 0, 8192, 0);
        fs.closeSync(fd);

        if (bytesRead > 0) {
          const headText = buffer.toString('utf-8', 0, bytesRead);
          const headNorm = normalizeWorkspaceString(headText);
          if (headNorm.includes(procNorm) || procNorm.includes(headNorm)) {
            return candidate;
          }
        }
      } catch (e) {}
    }
  } catch (err) {}
  return null;
}

export function extractTrajectoryMap(rawResponse: any): Record<string, any> {
  if (!rawResponse) return {};
  if (rawResponse.trajectorySummaries && typeof rawResponse.trajectorySummaries === 'object') {
    return rawResponse.trajectorySummaries;
  }
  return typeof rawResponse === 'object' ? rawResponse : {};
}

export function normalizeWorkspaceString(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/^file:\/\//, '')
    .replace(/^file_/, '')
    .replace(/[^a-z0-9]/g, '');
}

export function matchesWorkspace(procWorkspaceId: string | undefined, traj: any): boolean {
  if (!procWorkspaceId) return true; // Global process or no workspace context

  const procNorm = normalizeWorkspaceString(procWorkspaceId);
  if (!procNorm) return true;

  const workspaceObjects = traj?.workspaces || [];
  const metadataUris = traj?.trajectoryMetadata?.workspaceUris || [];

  const uris: string[] = [
    ...workspaceObjects.map((w: any) => w.workspaceFolderAbsoluteUri || ''),
    ...metadataUris,
  ].filter(Boolean);
  if (uris.length === 0) return true; // No workspace restrictions on trajectory

  return uris.some((u) => {
    const uriNorm = normalizeWorkspaceString(u);
    return uriNorm.includes(procNorm) || procNorm.includes(uriNorm);
  });
}

export function isCurrentWorkspaceProcess(proc: DetectedProcess, currentWorkspaceFsPath?: string): boolean {
  if (!currentWorkspaceFsPath) {
    // If no workspace folder is open, match global or any process without a workspaceId
    return !proc.workspaceId || proc.workspaceId.toLowerCase() === 'global';
  }
  if (!proc.workspaceId) return false;
  const currentNorm = normalizeWorkspaceString(currentWorkspaceFsPath);
  const procNorm = normalizeWorkspaceString(proc.workspaceId);
  return currentNorm.includes(procNorm) || procNorm.includes(currentNorm);
}

export function readActiveTranscriptTail(transcriptPath: string, maxBytes: number = 65536): string | null {
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const stat = fs.statSync(transcriptPath);
    if (stat.size === 0) return null;

    const fd = fs.openSync(transcriptPath, 'r');

    if (stat.size <= maxBytes) {
      const buffer = Buffer.alloc(stat.size);
      const bytesRead = fs.readSync(fd, buffer, 0, stat.size, 0);
      fs.closeSync(fd);
      return buffer.toString('utf-8', 0, bytesRead);
    }

    // Read head 16KB for session start settings
    const headBytesToRead = Math.min(16384, stat.size);
    const headBuffer = Buffer.alloc(headBytesToRead);
    const headBytes = fs.readSync(fd, headBuffer, 0, headBytesToRead, 0);
    const headStr = headBuffer.toString('utf-8', 0, headBytes);

    // Read tail 64KB for recent turns
    const tailOffset = stat.size - maxBytes;
    const tailBuffer = Buffer.alloc(maxBytes);
    const tailBytes = fs.readSync(fd, tailBuffer, 0, maxBytes, tailOffset);
    const tailStr = tailBuffer.toString('utf-8', 0, tailBytes);

    fs.closeSync(fd);
    return `${headStr}\n${tailStr}`;
  } catch (err) {}
  return null;
}

export function parseModelFromSettingsChange(content: string, models: ModelQuotaInfo[] = []): string | null {
  if (!content) return null;

  const regex = /<USER_SETTINGS_CHANGE>[\s\S]*?`?Model Selection`?\s+from\s+.*?\s+to\s+([a-zA-Z0-9\s()._-]+?)\.(?!\d)/gi;
  const lines = content.split('\n');

  let foundJsonStep = false;

  // Scan lines backwards (latest turns first)
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj.type === 'USER_INPUT' && typeof obj.content === 'string' && obj.content.includes('USER_SETTINGS_CHANGE')) {
          foundJsonStep = true;
          regex.lastIndex = 0;
          let match: RegExpExecArray | null;
          let latestInStep: string | null = null;
          while ((match = regex.exec(obj.content)) !== null) {
            if (match[1]) {
              const rawLabel = match[1].trim().replace(/^`|`$/g, '').replace(/\.$/, '').trim();
              const mappedId = mapModelLabelToModelId(rawLabel, models);
              if (mappedId) {
                latestInStep = mappedId;
              }
            }
          }
          if (latestInStep) {
            return latestInStep;
          }
        }
      } catch (e) {}
    }
  }

  // Fallback for raw non-JSON text (e.g. unit test mocks or plain strings)
  if (!foundJsonStep) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    let lastModelId: string | null = null;
    while ((match = regex.exec(content)) !== null) {
      if (match[1]) {
        const rawLabel = match[1].trim().replace(/^`|`$/g, '').replace(/\.$/, '').trim();
        const mappedId = mapModelLabelToModelId(rawLabel, models);
        if (mappedId) {
          lastModelId = mappedId;
        }
      }
    }
    if (lastModelId) return lastModelId;
  }

  return null;
}

export function mapModelLabelToModelId(label: string, models: ModelQuotaInfo[] = []): string | null {
  if (!label) return null;
  const trimmed = label.trim();
  if (trimmed.startsWith('<') || trimmed.includes('\\') || trimmed.includes('lines of')) return null;
  
  // 1. Direct match on model ID
  const directModel = models.find(m => m.model === trimmed);
  if (directModel) return directModel.model;

  // 2. Direct match on label
  const directLabel = models.find(m => m.label?.toLowerCase() === trimmed.toLowerCase());
  if (directLabel) return directLabel.model;

  // 3. Normalized alphanumeric match
  const normLabel = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normLabel && normLabel.length >= 3) {
    for (const m of models) {
      const normMLabel = (m.label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const normMModel = (m.model || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normMLabel && (normMLabel.includes(normLabel) || normLabel.includes(normMLabel))) {
        return m.model;
      }
      if (normMModel && (normMModel.includes(normLabel) || normLabel.includes(normMModel))) {
        return m.model;
      }
    }
  }

  return null;
}

export function resolveActiveModelId(
  credits: UserCreditsStatus,
  lastModelQuotas?: Map<string, number>,
  lastActiveModelId?: string,
  rawTrajectories?: any,
  workspaceId?: string,
  explicitConfigModelId?: string,
  customHomeDir?: string
): string {
  // 1. Explicit VS Code Configuration (Highest Priority - Global UI Selection)
  if (explicitConfigModelId) {
    return explicitConfigModelId;
  }

  // 2. Active Transcript Tail (<USER_SETTINGS_CHANGE> tag from latest chat session)
  try {
    const diskTraj = findLatestWorkspaceTrajectoryOnDisk(workspaceId, customHomeDir);
    if (diskTraj?.transcriptPath) {
      const content = readActiveTranscriptTail(diskTraj.transcriptPath);
      if (content) {
        const matchedModelId = parseModelFromSettingsChange(content, credits.models);
        if (matchedModelId) {
          return matchedModelId;
        }
      }
    }
  } catch (err) {
    // Ignore transcript read errors and continue down precedence chain
  }

  // 3. Last Active Model (Sticky state)
  // Retain the current model across ticks to avoid bouncing between models in a shared quota pool.
  if (lastActiveModelId) {
    return lastActiveModelId;
  }

  // 4. Quota Delta Tracking: Find model whose remainingFraction decreased since last tick
  if (lastModelQuotas) {
    for (const m of credits.models) {
      if (m.model && m.remainingFraction !== undefined) {
        const prev = lastModelQuotas.get(m.model);
        if (prev !== undefined && m.remainingFraction < prev - 0.0001) {
          return m.model;
        }
      }
    }
  }

  // 5. Global Default Override from Language Server API
  const staticDefault = credits.rawResponse?.userStatus?.cascadeModelConfigData?.defaultOverrideModelConfig?.modelOrAlias?.model || '';
  if (staticDefault && !staticDefault.startsWith('MODEL_PLACEHOLDER_')) {
    return staticDefault;
  }

  // 6. Fallback: pick the first model from the available list
  if (credits.models.length > 0 && credits.models[0].model) {
    return credits.models[0].model;
  }

  return '';
}


