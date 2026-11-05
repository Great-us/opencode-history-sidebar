/**
 * Moves one folder to the Windows Recycle Bin (backend-internal).
 *
 * Uses the shell's SHFileOperation with FOF_ALLOWUNDO (recycle) and
 * FOF_WANTNUKEWARNING: if Windows cannot recycle an item it asks before
 * deleting it permanently instead of destroying it silently. Afterwards the
 * folder must be gone AND an entry with its name and original location must
 * exist in the Recycle Bin; anything else is reported, never assumed.
 * The path travels in an environment variable, never interpolated into code.
 */
import { execFile } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";

const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OhsRecycle {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHFILEOPSTRUCT { public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags; public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
  public static string Recycle(string path) {
    var op = new SHFILEOPSTRUCT();
    op.wFunc = 3; // FO_DELETE
    op.pFrom = path + "\0\0";
    op.fFlags = (ushort)(0x0040 | 0x0010 | 0x0004 | 0x4000); // ALLOWUNDO | NOCONFIRMATION | SILENT | WANTNUKEWARNING
    int code = SHFileOperation(ref op);
    return code + "|" + op.fAnyOperationsAborted;
  }
}
'@
$target = $env:OHS_RECYCLE_TARGET
$result = [OhsRecycle]::Recycle($target)
$parts = $result.Split('|')
$gone = -not (Test-Path -LiteralPath $target)
$name = Split-Path -Leaf $target
$parent = Split-Path -Parent $target
$bin = (New-Object -ComObject Shell.Application).Namespace(10)
$inBin = $false
foreach ($item in $bin.Items()) { if ($item.Name -eq $name -and $item.ExtendedProperty('System.Recycle.DeletedFrom') -eq $parent) { $inBin = $true; break } }
[pscustomobject]@{ code = [int]$parts[0]; aborted = ($parts[1] -eq 'True'); gone = $gone; inBin = $inBin } | ConvertTo-Json -Compress
`;

export interface RecycleOutcome { ok: boolean; gone: boolean; inBin: boolean; message: string }

export function moveFolderToRecycleBin(folder: string, env: NodeJS.ProcessEnv = process.env): Promise<RecycleOutcome> {
  const target = resolve(folder);
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? process.env.SystemRoot ?? "C:\\Windows";
  return new Promise(done => {
    execFile(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: { ...env, OHS_RECYCLE_TARGET: target }, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        let parsed: { code?: number; aborted?: boolean; gone?: boolean; inBin?: boolean } = {};
        try { parsed = JSON.parse(String(stdout).trim().replace(/^\uFEFF/, "")); } catch { /* reported below */ }
        const gone = parsed.gone === true;
        const inBin = parsed.inBin === true;
        if (gone && inBin) { done({ ok: true, gone, inBin, message: `Moved "${basename(target)}" to the Windows Recycle Bin (original location ${dirname(target)}).` }); return; }
        const reason = error ? error.message : parsed.aborted ? "the operation was cancelled" : `shell result ${parsed.code ?? "unknown"}`;
        done({ ok: false, gone, inBin, message: gone
          ? `The folder left ${dirname(target)} but no Recycle Bin entry could be confirmed (${reason}).`
          : `The folder could not be moved to the Windows Recycle Bin (${reason}); it is still at ${target}.` });
      });
  });
}
