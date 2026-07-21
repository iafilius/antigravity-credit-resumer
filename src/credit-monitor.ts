import * as https from 'https';
import { DetectedProcess } from './process-detector';

export interface ModelQuotaInfo {
  label: string;
  model: string;
  remainingFraction?: number;
  resetTime?: string;
}

export interface UserCreditsStatus {
  port: number;
  availablePromptCredits: number;
  availableFlowCredits: number;
  monthlyPromptCredits?: number;
  monthlyFlowCredits?: number;
  models: ModelQuotaInfo[];
  rawResponse: any;
}

export function queryCreditStatusForProcess(proc: DetectedProcess): Promise<UserCreditsStatus | null> {
  return new Promise(async (resolve) => {
    // Try all candidate ports for this process
    for (const port of proc.ports) {
      const status = await queryGetUserStatus(port, proc.csrfToken);
      if (status) {
        resolve({
          port,
          availablePromptCredits: status?.userStatus?.planStatus?.availablePromptCredits ?? 0,
          availableFlowCredits: status?.userStatus?.planStatus?.availableFlowCredits ?? 0,
          monthlyPromptCredits: status?.userStatus?.planStatus?.planInfo?.monthlyPromptCredits,
          monthlyFlowCredits: status?.userStatus?.planStatus?.planInfo?.monthlyFlowCredits,
          models: parseModelQuotas(status),
          rawResponse: status,
        });
        return;
      }
    }
    resolve(null);
  });
}

function queryGetUserStatus(port: number, csrfToken: string): Promise<any | null> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      metadata: {
        ideName: 'antigravity',
        extensionName: 'antigravity',
        locale: 'en',
      },
    });

    const options: https.RequestOptions = {
      hostname: '127.0.0.1',
      port: port,
      path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
      method: 'POST',
      rejectUnauthorized: false, // Local self-signed certificates
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': csrfToken,
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
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (e) {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });
    });

    req.on('error', () => {
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
}

function parseModelQuotas(status: any): ModelQuotaInfo[] {
  const models: ModelQuotaInfo[] = [];
  const configs = status?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];

  for (const config of configs) {
    const label = config.label || '';
    const model = config.modelOrAlias?.model || '';
    const quotaInfo = config.quotaInfo;

    models.push({
      label,
      model,
      remainingFraction: quotaInfo?.remainingFraction,
      resetTime: quotaInfo?.resetTime,
    });
  }

  return models;
}
