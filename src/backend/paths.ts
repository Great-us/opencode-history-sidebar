/**
 * OpenCode on-disk layout resolution (backend-internal).
 *
 * Every path comes from the effective environment (constructor `env`, falling
 * back to `process.env`) so isolated test homes and the real machine resolve
 * through the same rules the installed 2.2.5 binary uses (inventory probe:
 * `opencode debug paths`; real DB `~/.local/share/opencode/opencode.db`,
 * shared-service discovery file `~/.local/state/opencode/service.json`).
 *
 * `OPENCODE_DB` (absolute file path) wins, then the XDG variable of the
 * platform, then the `~/.local/...` default built from the environment's home.
 */
import { isAbsolute, join, resolve } from "node:path";

/** Effective environment: explicit override first, then the process env. */
export function effectiveEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env ?? process.env;
}

function homeDirectory(env: NodeJS.ProcessEnv): string {
  const home = env.USERPROFILE || env.HOME || "";
  if (home && isAbsolute(home)) return home;
  throw new Error("Cannot determine the user home directory (USERPROFILE/HOME missing or not absolute).");
}

function xdg(env: NodeJS.ProcessEnv, variable: "XDG_DATA_HOME" | "XDG_STATE_HOME", fallback: string): string {
  const value = env[variable];
  if (value && isAbsolute(value)) return value;
  return join(homeDirectory(env), ".local", fallback);
}

/** Directory that holds `opencode.db` (the data root; never the file itself). */
export function dataRoot(env?: NodeJS.ProcessEnv): string {
  const e = effectiveEnv(env);
  const dbFile = e.OPENCODE_DB;
  if (dbFile && isAbsolute(dbFile)) return resolve(dirnameOf(dbFile));
  return resolve(join(xdg(e, "XDG_DATA_HOME", "share"), "opencode"));
}

/** Absolute path of the shared SQLite database file. */
export function databaseFile(env?: NodeJS.ProcessEnv): string {
  const e = effectiveEnv(env);
  const dbFile = e.OPENCODE_DB;
  if (dbFile && isAbsolute(dbFile)) return resolve(dbFile);
  return join(dataRoot(env), "opencode.db");
}

/** Directory holding the shared background-service discovery file. */
export function stateRoot(env?: NodeJS.ProcessEnv): string {
  return resolve(join(xdg(effectiveEnv(env), "XDG_STATE_HOME", "state"), "opencode"));
}

/** The shared background-service discovery file (url/pid/password). */
export function serviceFile(env?: NodeJS.ProcessEnv): string {
  return join(stateRoot(env), "service.json");
}

function dirnameOf(file: string): string {
  const normalized = file.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  if (index <= 0) return ".";
  return normalized.slice(0, index);
}
