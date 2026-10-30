import { exec } from 'child_process';
import * as https from 'https';
import * as http from 'http';

export interface DetectedProcess {
  pid: number;
  csrfToken: string;
  extensionServerPort: number;
  extensionServerCsrfToken: string;
  workspaceId?: string;
  workspacePaths?: string[];
  ports: number[];
}

export function parseLsofOutput(stdout: string): Map<number, number[]> {
  const map = new Map<number, number[]>();
  const lines = stdout.split('\n');
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 9 && parts[parts.length - 1] === '(LISTEN)') {
      const pid = parseInt(parts[1], 10);
      const addr = parts[parts.length - 2];
      const portMatch = addr.match(/:(\d+)$/);
      if (pid && portMatch) {
        const port = parseInt(portMatch[1], 10);
        if (!map.has(pid)) {
          map.set(pid, []);
        }
        const list = map.get(pid)!;
        if (!list.includes(port)) {
          list.push(port);
        }
      }
    }
  }
  return map;
}

export function parseNetstatOutput(stdout: string): Map<number, number[]> {
  const map = new Map<number, number[]>();
  const lines = stdout.split('\n');
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 5 && parts[0].toUpperCase() === 'TCP' && parts[3].toUpperCase() === 'LISTENING') {
      const addr = parts[1];
      const pid = parseInt(parts[4], 10);
      const portMatch = addr.match(/:(\d+)$/);
      if (pid && portMatch) {
        const port = parseInt(portMatch[1], 10);
        if (!map.has(pid)) {
          map.set(pid, []);
        }
        const list = map.get(pid)!;
        if (!list.includes(port)) {
          list.push(port);
        }
      }
    }
  }
  return map;
}

export function getListeningPortsByPid(isWindows: boolean = process.platform === 'win32'): Promise<Map<number, number[]>> {
  return new Promise((resolve) => {
    const cmd = isWindows ? 'netstat -ano -p tcp' : 'lsof -nP -iTCP -sTCP:LISTEN';
    exec(cmd, (error, stdout) => {
      if (error || !stdout) {
        resolve(new Map());
        return;
      }
      try {
        const map = isWindows ? parseNetstatOutput(stdout) : parseLsofOutput(stdout);
        resolve(map);
      } catch (e) {
        resolve(new Map());
      }
    });
  });
}

export function parseCandidateFromCommandLine(pid: number, commandLine: string): {
  pid: number;
  csrfToken: string;
  extensionServerPort: number;
  extensionServerCsrfToken: string;
  workspaceId?: string;
  workspacePaths?: string[];
  hubPort?: number;
} | null {
  const csrfTokenMatch = commandLine.match(/--csrf_token(?:=|\s+)([^\s"']+)/);
  if (!csrfTokenMatch) {
    return null;
  }

  const extPortMatch = commandLine.match(/--extension_server_port(?:=|\s+)(\d+)/);
  const hubPortMatch = commandLine.match(/--hub-port(?:=|\s+)(\d+)/);
  const extCsrfMatch = commandLine.match(/--extension_server_csrf_token(?:=|\s+)([^\s"']+)/);
  const workspaceIdMatch = commandLine.match(/--workspace_id(?:=|\s+)([^\s"']+)/);

  const workspacePaths: string[] = [];
  const addDirRegex = /--add-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
  let addDirMatch: RegExpExecArray | null;
  while ((addDirMatch = addDirRegex.exec(commandLine)) !== null) {
    const rawDir = (addDirMatch[1] || addDirMatch[2] || addDirMatch[3] || '').trim();
    if (rawDir && !workspacePaths.includes(rawDir)) {
      workspacePaths.push(rawDir);
    }
  }

  const hubPort = hubPortMatch ? parseInt(hubPortMatch[1], 10) : undefined;
  const extPort = extPortMatch ? parseInt(extPortMatch[1], 10) : (hubPort || 0);
  const workspaceId = workspaceIdMatch
    ? workspaceIdMatch[1]
    : (workspacePaths.length > 0 ? workspacePaths[0] : undefined);

  return {
    pid,
    csrfToken: csrfTokenMatch[1],
    extensionServerPort: extPort,
    extensionServerCsrfToken: extCsrfMatch ? extCsrfMatch[1] : '',
    workspaceId,
    workspacePaths: workspacePaths.length > 0 ? workspacePaths : undefined,
    hubPort,
  };
}

export function detectProcesses(): Promise<DetectedProcess[]> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows
      ? 'wmic process where "name like \'language_server%\' or name like \'agy%\'" get ProcessId, CommandLine'
      : 'ps -ax -o pid,command';

    exec(cmd, async (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }

      const candidateList: NonNullable<ReturnType<typeof parseCandidateFromCommandLine>>[] = [];
      const lines = stdout.split('\n');

      for (const line of lines) {
        const parsed = parseProcessLine(line, isWindows);
        if (!parsed) {
          continue;
        }

        const candidate = parseCandidateFromCommandLine(parsed.pid, parsed.commandLine);
        if (candidate) {
          candidateList.push(candidate);
        }
      }

      if (candidateList.length === 0) {
        resolve([]);
        return;
      }

      // Fast OS socket inspection for all listening ports
      const osPortMap = await getListeningPortsByPid(isWindows);

      const processes = await Promise.all(
        candidateList.map(async (candidate) => {
          const osPorts = osPortMap.get(candidate.pid) || [];
          let ports = [...osPorts];
          if (candidate.hubPort && candidate.hubPort > 0 && !ports.includes(candidate.hubPort)) {
            ports.unshift(candidate.hubPort);
          }
          if (ports.length === 0) {
            // Graceful fallback to pure Node candidate probing if OS lookup yielded no ports
            ports = await resolvePortsForCandidate(candidate.extensionServerPort, candidate.csrfToken);
          }
          const { hubPort: _hubPort, ...rest } = candidate;
          return {
            ...rest,
            ports,
          };
        })
      );

      resolve(processes);
    });
  });
}

export async function resolvePortsForCandidate(extensionServerPort: number, csrfToken: string): Promise<number[]> {
  if (!extensionServerPort || !csrfToken) {
    return [];
  }

  const base = extensionServerPort;

  // Tier 0: Direct base port check (e.g. when --hub-port IS the Connect-RPC port)
  const directHit = await probeHttpsPort(base, csrfToken);
  if (directHit !== null) {
    return [directHit];
  }

  // Tier 1: Most immediate adjacent offsets (+1 to +10, and -5 to -1)
  const tier1: number[] = [];
  for (let offset = 1; offset <= 10; offset++) {
    tier1.push(base + offset);
  }
  for (let offset = -5; offset <= -1; offset++) {
    const p = base + offset;
    if (p > 0) {
      tier1.push(p);
    }
  }

  const tier1Found = (await Promise.all(tier1.map(p => probeHttpsPort(p, csrfToken)))).filter((p): p is number => p !== null);
  if (tier1Found.length > 0) {
    return tier1Found;
  }

  // Tier 2: Wider positive offset range (+11 to +120) probed in small parallel chunks
  const tier2: number[] = [];
  for (let offset = 11; offset <= 120; offset++) {
    tier2.push(base + offset);
  }

  const chunkSize = 25;
  for (let i = 0; i < tier2.length; i += chunkSize) {
    const chunk = tier2.slice(i, i + chunkSize);
    const chunkFound = (await Promise.all(chunk.map(p => probeHttpsPort(p, csrfToken)))).filter((p): p is number => p !== null);
    if (chunkFound.length > 0) {
      return chunkFound;
    }
  }

  return [];
}

export function postConnectRpc(
  port: number,
  csrfToken: string,
  rpcPath: string,
  payload: string,
  timeoutMs: number = 2000
): Promise<{ statusCode: number; body: string } | null> {
  return new Promise((resolve) => {
    const requestOptions: https.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path: rpcPath,
      method: 'POST',
      rejectUnauthorized: false,
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': csrfToken,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    };

    const tryHttpFallback = () => {
      try {
        const httpReq = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: rpcPath,
            method: 'POST',
            agent: false,
            headers: requestOptions.headers,
            timeout: timeoutMs,
          },
          (res) => {
            let data = '';
            res.on('data', (c) => {
              data += c;
            });
            res.on('end', () => {
              resolve({ statusCode: res.statusCode || 0, body: data });
            });
          }
        );
        httpReq.on('error', () => resolve(null));
        httpReq.on('timeout', () => {
          httpReq.destroy();
          resolve(null);
        });
        httpReq.write(payload);
        httpReq.end();
      } catch {
        resolve(null);
      }
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, body: data });
      });
    });

    req.on('error', () => {
      tryHttpFallback();
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
}

export async function probeHttpsPort(port: number, csrfToken: string): Promise<number | null> {
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
    250
  );
  if (res && res.statusCode === 200) {
    return port;
  }
  return null;
}

export function parseProcessLine(line: string, isWindows: boolean): { pid: number; commandLine: string } | null {
  if (!line.includes('--csrf_token')) {
    return null;
  }

  const isLegacyLanguageServer = line.includes('language_server');
  const isAgyHub = line.includes('--hub') || /(?:^|[/\\]|\s)agy(?:\.exe)?(?:\s|$)/i.test(line);
  if (!isLegacyLanguageServer && !isAgyHub) {
    return null;
  }

  let pid: number | undefined;
  let commandLine = line;

  if (isWindows) {
    // WMIC format: CommandLine  ProcessId
    const match = line.trim().match(/^(.*?)\s+(\d+)$/);
    if (match) {
      commandLine = match[1];
      pid = parseInt(match[2], 10);
    }
  } else {
    // ps format: PID COMMAND
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (match) {
      pid = parseInt(match[1], 10);
      commandLine = match[2];
    }
  }

  if (!pid) {
    return null;
  }

  return { pid, commandLine };
}

export function hasProcessOpenFileInWorkspace(pid: number, workspaceFsPath?: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!workspaceFsPath || !pid || pid <= 0) {
      resolve(false);
      return;
    }

    if (process.platform === 'win32') {
      // Windows file handle inspection fallback
      resolve(false);
      return;
    }

    const normWorkspace = workspaceFsPath.replace(/[/\\]+$/, '');
    exec(`lsof -p ${pid} -Fn 2>/dev/null`, { timeout: 1500 }, (err, stdout) => {
      if (err || !stdout) {
        resolve(false);
        return;
      }
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.startsWith('n/')) {
          const filePath = line.substring(1);
          if (filePath.startsWith(normWorkspace) || filePath.includes(normWorkspace)) {
            resolve(true);
            return;
          }
        }
      }
      resolve(false);
    });
  });
}
