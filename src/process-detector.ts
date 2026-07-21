import { exec } from 'child_process';
import * as path from 'path';

export interface DetectedProcess {
  pid: number;
  csrfToken: string;
  extensionServerPort: number;
  extensionServerCsrfToken: string;
  workspaceId?: string;
  ports: number[];
}

export function detectProcesses(): Promise<DetectedProcess[]> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows
      ? 'wmic process where "name like \'language_server%\'" get ProcessId, CommandLine'
      : 'ps -ax -o pid,command';

    exec(cmd, async (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }

      const processes: DetectedProcess[] = [];
      const lines = stdout.split('\n');

      for (const line of lines) {
        const parsed = parseProcessLine(line, isWindows);
        if (!parsed) {
          continue;
        }

        const { pid, commandLine } = parsed;

        const csrfTokenMatch = commandLine.match(/--csrf_token\s+([^\s]+)/);
        const extPortMatch = commandLine.match(/--extension_server_port\s+(\d+)/);
        const extCsrfMatch = commandLine.match(/--extension_server_csrf_token\s+([^\s]+)/);
        const workspaceIdMatch = commandLine.match(/--workspace_id\s+([^\s]+)/);

        if (csrfTokenMatch) {
          const csrfToken = csrfTokenMatch[1];
          const extensionServerPort = extPortMatch ? parseInt(extPortMatch[1], 10) : 0;
          const extensionServerCsrfToken = extCsrfMatch ? extCsrfMatch[1] : '';
          const workspaceId = workspaceIdMatch ? workspaceIdMatch[1] : undefined;

          // Resolve ports for this process PID
          const ports = await resolvePortsForPid(pid);

          processes.push({
            pid,
            csrfToken,
            extensionServerPort,
            extensionServerCsrfToken,
            workspaceId,
            ports,
          });
        }
      }

      resolve(processes);
    });
  });
}

function resolvePortsForPid(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows
      ? `netstat -ano`
      : `lsof -nP -iTCP -sTCP:LISTEN -p ${pid}`;

    exec(cmd, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }

      const portsSet = new Set<number>();
      const lines = stdout.split('\n');

      for (const line of lines) {
        if (isWindows) {
          // netstat format: TCP  127.0.0.1:61028  0.0.0.0:0  LISTENING  33878
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5 && parts[3] === 'LISTENING') {
            const lastPartPid = parseInt(parts[4], 10);
            if (lastPartPid === pid) {
              const localAddr = parts[1];
              const portMatch = localAddr.match(/:(\d+)$/);
              if (portMatch) {
                portsSet.add(parseInt(portMatch[1], 10));
              }
            }
          }
        } else {
          // lsof format: language_ 46530 arjan 6u IPv4 ... TCP 127.0.0.1:53855 (LISTEN)
          if (line.includes('LISTEN')) {
            const match = line.match(/:(\d+)\s+\(LISTEN\)/);
            if (match) {
              portsSet.add(parseInt(match[1], 10));
            }
          }
        }
      }

      resolve(Array.from(portsSet));
    });
  });
}

export function parseProcessLine(line: string, isWindows: boolean): { pid: number; commandLine: string } | null {
  if (!line.includes('language_server') || !line.includes('--csrf_token')) {
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
