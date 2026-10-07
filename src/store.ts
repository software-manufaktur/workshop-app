// Zentraler Zustand: Laden, Speichern, Migration und automatische Sicherung.
import { autoArchive, emptyState, fromLegacyLocalStorage, normalizeState, type AppState } from "./model";
import { dateStamp } from "./format";
import { ICloudBackup, isNative, legacyGet, loadRaw, saveRaw, type BackupFile } from "./platform";

let state: AppState = emptyState();
const listeners = new Set<(s: AppState) => void>();

export const getState = () => state;
export const subscribe = (fn: (s: AppState) => void) => listeners.add(fn);

export async function initStore(): Promise<{ migrated: boolean }> {
  const raw = await loadRaw();
  let migrated = false;
  if (raw) {
    state = normalizeState(JSON.parse(raw));
  } else {
    const legacy = fromLegacyLocalStorage(legacyGet);
    if (legacy) {
      state = legacy;
      migrated = true;
    }
  }
  const archived = autoArchive(state);
  if (migrated || archived) await persist();
  return { migrated };
}

/**
 * Ändert den Zustand atomar: Die Mutation läuft auf einer Kopie, erst nach
 * erfolgreichem Speichern wird sie übernommen.
 */
export async function update(mutator: (draft: AppState) => void, opts: { silent?: boolean } = {}): Promise<void> {
  const draft = structuredClone(state);
  mutator(draft);
  if (!opts.silent) draft.meta.updatedAt = new Date().toISOString();
  await saveRaw(JSON.stringify(draft));
  state = draft;
  listeners.forEach((fn) => fn(state));
  if (!opts.silent) scheduleBackup();
}

async function persist() {
  await saveRaw(JSON.stringify(state));
}

export async function replaceState(next: AppState): Promise<void> {
  await update((draft) => {
    const keepMeta = draft.meta;
    Object.assign(draft, structuredClone(next));
    draft.meta = { ...next.meta, lastBackupAt: keepMeta.lastBackupAt };
  });
}

/* ---------- Backup-Datei ---------- */

export function backupJson(s: AppState = state): string {
  return JSON.stringify({ app: "seeyou-workshops", exported_at: new Date().toISOString(), state: s }, null, 2);
}

export function parseBackup(text: string): AppState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Die Datei ist keine gültige Sicherung (kein JSON).");
  }
  return normalizeState(parsed);
}

/* ---------- Automatische iCloud-Sicherung (nur iOS-App) ---------- */

export const BACKUP_PREFIX = "SeeYou-Sicherung-";
const LATEST_NAME = "SeeYou-Sicherung-aktuell.json";
const KEEP_DAILY = 60;
const BACKUP_DEBOUNCE_MS = 2500;

let backupTimer: ReturnType<typeof setTimeout> | null = null;
let backupRunning: Promise<void> | null = null;
const backupListeners = new Set<(info: BackupStatus) => void>();

export interface BackupStatus {
  ok: boolean;
  at: string | null;
  location: "icloud" | "local" | null;
  error?: string;
}
let lastStatus: BackupStatus = { ok: true, at: null, location: null };
export const getBackupStatus = () => lastStatus;
export const onBackupStatus = (fn: (info: BackupStatus) => void) => backupListeners.add(fn);

export function scheduleBackup(delay = BACKUP_DEBOUNCE_MS) {
  if (!isNative) return;
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => void runBackup(), delay);
}

/** Sofort sichern (z. B. wenn die App in den Hintergrund geht). */
export async function flushBackup(): Promise<void> {
  if (!isNative) return;
  if (backupTimer) {
    clearTimeout(backupTimer);
    backupTimer = null;
    await runBackup();
  } else if (backupRunning) {
    await backupRunning;
  }
}

export async function runBackup(): Promise<void> {
  if (!isNative) return;
  if (backupRunning) return backupRunning;
  backupRunning = (async () => {
    try {
      const data = backupJson();
      const daily = `${BACKUP_PREFIX}${dateStamp()}.json`;
      const res = await ICloudBackup.write({ name: daily, data });
      await ICloudBackup.write({ name: LATEST_NAME, data });
      await pruneBackups();
      const at = new Date().toISOString();
      lastStatus = { ok: true, at, location: res.location };
      await update((d) => (d.meta.lastBackupAt = at), { silent: true });
    } catch (err) {
      lastStatus = { ...lastStatus, ok: false, error: (err as Error).message };
    } finally {
      backupRunning = null;
      backupListeners.forEach((fn) => fn(lastStatus));
    }
  })();
  return backupRunning;
}

async function pruneBackups() {
  const { files } = await ICloudBackup.list();
  const daily = files
    .filter((f) => /^SeeYou-Sicherung-\d{4}-\d{2}-\d{2}\.json$/.test(f.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  for (const f of daily.slice(KEEP_DAILY)) await ICloudBackup.remove({ name: f.name });
}

export async function listBackups(): Promise<BackupFile[]> {
  if (!isNative) return [];
  const { files } = await ICloudBackup.list();
  return files.filter((f) => f.name.startsWith(BACKUP_PREFIX)).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function readBackup(name: string): Promise<AppState> {
  const { data } = await ICloudBackup.read({ name });
  return parseBackup(data);
}
