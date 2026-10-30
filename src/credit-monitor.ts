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
  schemaDriftReason?: string;
}

/**
 * Validates that a parsed GetUserStatus JSON response conforms to the expected Protobuf structure.
 * Returns undefined if valid, or a human-readable diagnostic reason if the schema drifted.
 */
export function validateUserStatusSchema(raw: any): string | undefined {
  if (!raw || typeof raw !== 'object') {
    return 'GetUserStatus returned empty or non-object JSON payload';
  }
  if (!raw.userStatus || typeof raw.userStatus !== 'object') {
    return 'GetUserStatus payload missing "userStatus" root object';
  }
  const configs = raw.userStatus?.cascadeModelConfigData?.clientModelConfigs;
  if (!Array.isArray(configs) || configs.length === 0) {
    return 'GetUserStatus payload missing or empty "userStatus.cascadeModelConfigData.clientModelConfigs" array';
  }
  const hasValidModelEntry = configs.some(
    (c: any) => c && typeof c === 'object' && (Boolean(c.label) || Boolean(c.modelOrAlias?.model))
  );
  if (!hasValidModelEntry) {
    return 'GetUserStatus "clientModelConfigs" items missing "label" and "modelOrAlias.model" fields';
  }
  return undefined;
}

interface GetUserStatusQueryResult {
  status?: any;
  schemaDriftReason?: string;
}

export function queryCreditStatusForProcess(proc: DetectedProcess): Promise<UserCreditsStatus | null> {
  return new Promise(async (resolve) => {
    let firstDriftResult: { port: number; reason: string; raw?: any } | undefined;

    // Try all candidate ports for this process
    for (const port of proc.ports) {
      const result = await queryGetUserStatus(port, proc.csrfToken);
      if (result && result.status && !result.schemaDriftReason) {
        resolve({
          port,
          availablePromptCredits: result.status?.userStatus?.planStatus?.availablePromptCredits ?? 0,
          availableFlowCredits: result.status?.userStatus?.planStatus?.availableFlowCredits ?? 0,
          monthlyPromptCredits: result.status?.userStatus?.planStatus?.planInfo?.monthlyPromptCredits,
          monthlyFlowCredits: result.status?.userStatus?.planStatus?.planInfo?.monthlyFlowCredits,
          models: parseModelQuotas(result.status),
          rawResponse: result.status,
        });
        return;
      }
      if (result && result.schemaDriftReason && !firstDriftResult) {
        firstDriftResult = { port, reason: result.schemaDriftReason, raw: result.status };
      }
    }

    if (firstDriftResult) {
      resolve({
        port: firstDriftResult.port,
        availablePromptCredits: 0,
        availableFlowCredits: 0,
        models: [],
        rawResponse: firstDriftResult.raw ?? {},
        schemaDriftReason: firstDriftResult.reason,
      });
      return;
    }

    resolve(null);
  });
}

async function queryGetUserStatus(port: number, csrfToken: string): Promise<GetUserStatusQueryResult | null> {
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

  if (!res) {
    return null;
  }

  if (res.statusCode === 400 || res.statusCode === 404 || res.statusCode === 501) {
    return {
      schemaDriftReason: `GetUserStatus returned HTTP ${res.statusCode} on port ${port} (RPC endpoint or request schema changed)`,
    };
  }

  if (res.statusCode === 200 && res.body) {
    try {
      const parsed = JSON.parse(res.body);
      const driftReason = validateUserStatusSchema(parsed);
      return {
        status: parsed,
        schemaDriftReason: driftReason,
      };
    } catch {
      return {
        schemaDriftReason: `GetUserStatus returned malformed JSON on HTTP 200 (port ${port})`,
      };
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
