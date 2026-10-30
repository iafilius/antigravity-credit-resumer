import { DetectedProcess, postConnectRpc } from './process-detector';

export interface ModelQuotaInfo {
  label: string;
  model: string;
  modelId?: string;
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

async function queryGetUserStatus(port: number, csrfToken: string): Promise<any | null> {
  const payload = JSON.stringify({
    metadata: {
      ideName: 'antigravity',
      extensionName: 'antigravity',
      locale: 'en',
    },
  });

  const res = await postConnectRpc(
    port,
    csrfToken,
    '/exa.language_server_pb.LanguageServerService/GetUserStatus',
    payload,
    2000
  );

  if (res && res.statusCode === 200 && res.body) {
    try {
      return JSON.parse(res.body);
    } catch {
      return null;
    }
  }
  return null;
}

function parseModelQuotas(status: any): ModelQuotaInfo[] {
  const models: ModelQuotaInfo[] = [];
  const seenKeys = new Set<string>();
  const configs = status?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];

  for (const config of configs) {
    const label = config.label || '';
    const model = config.modelOrAlias?.model || '';
    const quotaInfo = config.quotaInfo;

    const dedupeKey = (label || model).trim();
    if (!dedupeKey || seenKeys.has(dedupeKey)) {
      continue;
    }
    seenKeys.add(dedupeKey);

    models.push({
      label,
      model,
      modelId: config.modelId || undefined,
      remainingFraction: quotaInfo?.remainingFraction,
      resetTime: quotaInfo?.resetTime,
    });
  }

  return models;
}
