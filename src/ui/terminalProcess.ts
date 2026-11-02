import { execFile } from 'node:child_process';
import { join } from 'node:path';

export interface ProcessIdentity { executablePath: string; commandLine: string; creationDate: string }

/** Query only a PID obtained from one of our own terminal receipts, never enumerate processes. */
export async function terminalProcessIdentity(pid: number): Promise<ProcessIdentity> {
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $p=Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}'; if($null -eq $p){throw 'Owned terminal process no longer exists'}; [pscustomobject]@{executablePath=$p.ExecutablePath;commandLine=$p.CommandLine;creationDate=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress`;
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 65536, encoding: 'utf8' }, (error, output) => { if (error) reject(error); else resolve(output); });
  });
  const value: unknown = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object') throw new Error('无法读取本扩展终端进程的身份。');
  const identity = value as Record<string, unknown>;
  if (typeof identity.executablePath !== 'string' || typeof identity.commandLine !== 'string' || typeof identity.creationDate !== 'string' || !identity.creationDate) throw new Error('本扩展终端进程的身份信息不完整。');
  return identity as unknown as ProcessIdentity;
}
