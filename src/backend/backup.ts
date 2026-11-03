/**
 * Private local recovery backups (backend-internal).
 *
 * A backup is the set of official export envelopes (`{info, messages}`) of
 * every member of the deleted scope, parent first, written under the
 * extension's private global storage. The JSON therefore contains the
 * original conversation text (supervisor decision 2026-11-02: keep it solely
 * here, explain the scope in the delete confirmation, no purge command).
 *
 * The manifest records enough to restore honestly: member order, parent
 * links, the original location directory (restore MUST pass it explicitly —
 * the probe proved the server otherwise rewrites projectID to its cwd), the
 * live message-id baseline captured before deletion, and the outcome status.
 * Files are never deleted by this code; there is no cleanup path.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionExport } from "./opencodeApi";

export interface BackupMember {
  session_id: string;
  parent_session_id: string | null;
  directory: string;
  file: string;
  archived: boolean;
  /** Live message ids observed via the API right before export (baseline). */
  message_ids: string[];
}

export interface BackupManifest {
  backup_id: string;
  created_at: string;
  title: string;
  session_ids: string[];
  status: "available" | "partial" | "restored";
  message: string;
  members: BackupMember[];
}

export class BackupStore {
  constructor(private readonly storagePath: string) {}

  private root(): string {
    return join(this.storagePath, "backups");
  }

  private dir(backupId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(backupId)) throw new Error(`Invalid backup identifier: ${backupId}`);
    return join(this.root(), backupId);
  }

  /** Persist a new backup: manifest plus one envelope file per member, parents first. */
  async create(title: string, envelopes: readonly SessionExport[], baselines: ReadonlyMap<string, string[]>): Promise<BackupManifest> {
    const backupId = `bk-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const dir = this.dir(backupId);
    await mkdir(dir, { recursive: true });
    const members: BackupMember[] = [];
    let index = 0;
    for (const envelope of envelopes) {
      const file = `member-${String(index).padStart(3, "0")}.json`;
      await writeFile(join(dir, file), JSON.stringify(envelope, null, 2), "utf8");
      members.push({
        session_id: envelope.info.id,
        parent_session_id: envelope.info.parentID ?? null,
        directory: envelope.info.location?.directory ?? "",
        file,
        archived: typeof envelope.info.time?.archived === "number",
        message_ids: baselines.get(envelope.info.id) ?? [],
      });
      index += 1;
    }
    const manifest: BackupManifest = {
      backup_id: backupId,
      created_at: new Date().toISOString(),
      title,
      session_ids: members.map(member => member.session_id),
      status: "available",
      message: "",
      members,
    };
    await this.write(manifest);
    return manifest;
  }

  async write(manifest: BackupManifest): Promise<void> {
    const dir = this.dir(manifest.backup_id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  }

  /** All manifests, newest first; a missing store is empty, other I/O errors surface. */
  async list(): Promise<BackupManifest[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.root(), { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      // Permission/I/O failures must not silently hide existing backups.
      throw new Error(`Cannot read the recovery backup directory ${this.root()}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const manifests: BackupManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        manifests.push(await this.read(entry.name));
      } catch {
        // A damaged manifest stays visible as a partial row so nothing hides.
        manifests.push({
          backup_id: entry.name,
          created_at: "",
          session_ids: [],
          title: "(unreadable backup)",
          status: "partial",
          message: "The backup manifest cannot be read. The original files are still in the extension's private storage.",
          members: [],
        });
      }
    }
    return manifests.sort((a, b) => b.backup_id.localeCompare(a.backup_id));
  }

  async read(backupId: string): Promise<BackupManifest> {
    const value: unknown = JSON.parse(await readFile(join(this.dir(backupId), "manifest.json"), "utf8"));
    if (value === null || typeof value !== "object" || !Array.isArray((value as BackupManifest).members)) {
      throw new Error(`The manifest of backup ${backupId} has an invalid format.`);
    }
    return value as BackupManifest;
  }

  /** Load one member's export envelope exactly as it was written. */
  async envelope(backupId: string, member: BackupMember): Promise<SessionExport> {
    const value: unknown = JSON.parse(await readFile(join(this.dir(backupId), member.file), "utf8"));
    const envelope = value as SessionExport;
    if (envelope === null || typeof envelope !== "object" || !envelope.info || !Array.isArray(envelope.messages)) {
      throw new Error(`The export file for session ${member.session_id} in backup ${backupId} is invalid.`);
    }
    return envelope;
  }
}
