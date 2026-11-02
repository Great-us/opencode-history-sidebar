/**
 * Native OpenCode executable discovery and selection (backend-internal).
 *
 * The engine is the installed `@opencode/cli` native exe (inventory probe:
 * `%APPDATA%/npm/node_modules/@opencode/cli/bin/opencode.exe`,
 * package 2.2.5). Resolution order:
 *
 * 1. an explicit selection persisted by `setEnginePath` (private to this
 *    extension, under the constructor storage path);
 * 2. the npm global install root derived from the effective `APPDATA`;
 * 3. an `opencode.exe` / `opencode` found on `PATH`.
 *
 * Discovery only checks that a file exists; it never launches anything and is
 * fully independent of history/service operations. Failures throw clear
 * errors — there is no silent "no engine" placeholder.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { effectiveEnv } from "./paths";

const ENGINE_STORE = "engine-choice.json";

async function existsFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Persisted explicit choice (or null when the user never picked one). */
export async function loadEngineChoice(storagePath: string): Promise<string | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(storagePath, ENGINE_STORE), "utf8"));
    if (value && typeof value === "object" && typeof (value as { path?: unknown }).path === "string") {
      return (value as { path: string }).path;
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveEngineChoice(storagePath: string, enginePath: string): Promise<void> {
  await mkdir(storagePath, { recursive: true });
  await writeFile(join(storagePath, ENGINE_STORE), JSON.stringify({ path: enginePath }, null, 2), "utf8");
}

function npmGlobalCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const appdata = env.APPDATA;
  if (appdata) candidates.push(join(appdata, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe"));
  const home = env.USERPROFILE || env.HOME;
  if (home) candidates.push(join(home, ".npm-global", "node_modules", "@opencode", "cli", "bin", "opencode.exe"));
  return candidates;
}

/**
 * PATH probe via plain fs (simpler equivalent implementation, cold-start fix):
 * the previous probe piped `if exist "<path>" (exit 0) else (exit 1)` through
 * cmd.exe, but node's Windows argument escaping turns the embedded quotes
 * into `\"` which cmd cannot parse, so the probe failed for EVERY path —
 * quoted or not — and PATH discovery never succeeded (proven by the isolated
 * cold-start regression: `if exist "C:\Windows\notepad.exe"` returned NO).
 * A plain fs existence check answers the same question with no shell.
 */
async function pathLookup(env: NodeJS.ProcessEnv): Promise<string | null> {
  const separator = process.platform === "win32" ? ";" : ":";
  const names = process.platform === "win32" ? ["opencode.exe", "opencode"] : ["opencode"];
  const directories = (env.PATH ?? "").split(separator).filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = resolve(directory, name);
      if (await existsFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve the native engine. Returns the absolute exe path, or null when
 * nothing verifiable exists on this machine (callers turn that into their own
 * honest error/warning; discovery never guesses a path into existence).
 */
export async function discoverEngine(env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const candidate of npmGlobalCandidates(env)) {
    if (await existsFile(candidate)) return resolve(candidate);
  }
  return pathLookup(env);
}
