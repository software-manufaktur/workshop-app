// Automatische Sicherung und Wiederherstellungspunkte.
//
// Dateien (im iCloud-Drive-Ordner „SeeYou Workshops“, sonst lokal):
//   SeeYou-Sicherung-JJJJ-MM-TT.json                         Tagessicherung (neuester Stand des Tages)
//   SeeYou-Wiederherstellungspunkt-JJJJ-MM-TT_hh-mm-ss_grund.json   unveränderlich, vor kritischen Aktionen
//
// Grundsätze:
//   - Ein leerer Datenstand wird nie automatisch gesichert (Schutz nach Neuinstallation).
//   - Eine vorhandene Tagessicherung wird nie durch einen älteren oder kleineren Stand
//     ersetzt, ohne dass ihr Inhalt vorher als Wiederherstellungspunkt erhalten bleibt.
//   - Wiederherstellungspunkte werden nur neu angelegt, nie überschrieben.
//   - Fehlgeschlagene Sicherungen werden mit wachsendem Abstand wiederholt.
import { isEmptyState, normalizeWithReport, type AppState, type ImportReport } from "./model";
import { dateStamp } from "./format";
import { BackupExistsError, type BackupDriver, type BackupFileInfo, type BackupLocation } from "./storage";

export const DAILY_PREFIX = "SeeYou-Sicherung-";
export const POINT_PREFIX = "SeeYou-Wiederherstellungspunkt-";
const DAILY_RE = /^SeeYou-Sicherung-(\d{4}-\d{2}-\d{2})(?:-lokal(?:-\d+)?)?\.json$/;
const POINT_RE = /^SeeYou-Wiederherstellungspunkt-(\d{4}-\d{2}-\d{2})_[\w-]+\.json$/;

export const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];

export type RestorePointReason =
  | "vor-Import"
  | "vor-Wiederherstellung"
  | "vor-Loeschen"
  | "vor-Ueberschreiben"
  | "abweichender-Stand";

export interface BackupStatus {
  phase: "idle" | "running" | "ok" | "error" | "skipped";
  lastSuccessAt: string | null;
  location: BackupLocation | null;
  message: string | null;
  failures: number;
  nextRetryAt: string | null;
}

export type BackupKind = "daily" | "restore-point" | "other";

export interface BackupEntry extends BackupFileInfo {
  kind: BackupKind;
  /** Datum aus dem Dateinamen (JJJJ-MM-TT). */
  day: string | null;
}

export interface BackupOptions {
  /** Tagessicherungen schreiben (nur iOS-App). */
  dailyEnabled: boolean;
  keepDays: number;
  /** Mindestanzahl je Art, die unabhängig vom Alter behalten wird. */
  minKeep: number;
  /** Höchstanzahl Wiederherstellungspunkte (Web: Speicherplatz begrenzt). */
  maxRestorePoints?: number;
  debounceMs: number;
  now?: () => Date;
}

const DEFAULTS: BackupOptions = { dailyEnabled: true, keepDays: 60, minKeep: 10, debounceMs: 2500 };

export function backupFileContent(state: AppState, kind: BackupKind | "export", reason?: string, now = new Date()): string {
  return JSON.stringify(
    {
      app: "seeyou-workshops",
      kind,
      ...(reason ? { reason } : {}),
      exported_at: now.toISOString(),
      revision: state.meta.revision,
      counts: { slots: state.slots.length, bookings: state.bookings.length },
      state,
    },
    null,
    2,
  );
}

export function parseBackupText(text: string): { state: AppState; report: ImportReport } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Die Datei ist keine gültige Sicherung (kein lesbares JSON).");
  }
  return normalizeWithReport(parsed);
}

export function classify(f: BackupFileInfo): BackupEntry {
  const d = DAILY_RE.exec(f.name);
  if (d) return { ...f, kind: "daily", day: d[1] };
  const p = POINT_RE.exec(f.name);
  if (p) return { ...f, kind: "restore-point", day: p[1] };
  return { ...f, kind: "other", day: null };
}

const recordCount = (s: AppState) => s.slots.length + s.bookings.length;

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dateStamp(d)}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * Welche Dateien dürfen gelöscht werden? Rein und separat testbar.
 * Behalten wird: alles, was jünger als keepDays ist, und je Art mindestens minKeep Dateien.
 */
export function selectForPruning(entries: BackupEntry[], now: Date, opts: Pick<BackupOptions, "keepDays" | "minKeep" | "maxRestorePoints">): BackupEntry[] {
  const limit = dateStamp(new Date(now.getTime() - opts.keepDays * 86_400_000));
  const out: BackupEntry[] = [];
  for (const kind of ["daily", "restore-point"] as const) {
    const list = entries
      .filter((e) => e.kind === kind && e.day)
      .sort((a, b) => b.name.localeCompare(a.name) || (a.location === "icloud" ? -1 : 1));
    list.forEach((e, i) => {
      const tooOld = e.day! < limit;
      const overMax = kind === "restore-point" && opts.maxRestorePoints !== undefined && i >= opts.maxRestorePoints;
      if (i >= opts.minKeep && tooOld) out.push(e);
      else if (overMax) out.push(e);
    });
  }
  return out;
}

export class BackupManager {
  private opts: BackupOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<BackupStatus> | null = null;
  private listeners = new Set<(s: BackupStatus) => void>();
  status: BackupStatus = { phase: "idle", lastSuccessAt: null, location: null, message: null, failures: 0, nextRetryAt: null };

  constructor(
    private driver: BackupDriver,
    private getState: () => AppState,
    /** Speichert, welche Revision gesichert ist (darf nicht als Inhaltsänderung zählen). */
    private markBackedUp: (revision: number, at: string) => Promise<void>,
    opts: Partial<BackupOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.status.lastSuccessAt = getState().meta.lastBackupAt;
  }

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  onStatus(fn: (s: BackupStatus) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setStatus(patch: Partial<BackupStatus>) {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) fn(this.status);
  }

  /** Gibt es Änderungen, die noch nicht gesichert sind? */
  isDirty(): boolean {
    const s = this.getState();
    return !isEmptyState(s) && s.meta.lastBackupRevision !== s.meta.revision;
  }

  schedule(delay = this.opts.debounceMs) {
    if (!this.opts.dailyEnabled) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }

  /** Sofort sichern, falls etwas aussteht (z. B. wenn die App in den Hintergrund geht). */
  async flush(): Promise<void> {
    if (!this.opts.dailyEnabled) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) await this.running;
    if (this.isDirty()) await this.run();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Führt eine Sicherung aus. `force` sichert auch ohne Änderung seit der letzten Sicherung. */
  run(force = false): Promise<BackupStatus> {
    if (!this.opts.dailyEnabled) return Promise.resolve(this.status);
    if (this.running) return this.running;
    this.running = this.doRun(force).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doRun(force: boolean): Promise<BackupStatus> {
    const state = this.getState();
    const revision = state.meta.revision;
    if (isEmptyState(state)) {
      this.setStatus({ phase: "skipped", message: "Keine Daten – es wird nichts gesichert." });
      return this.status;
    }
    if (!force && state.meta.lastBackupRevision === revision) {
      this.setStatus({ phase: "ok", message: null, failures: 0, nextRetryAt: null });
      return this.status;
    }
    this.setStatus({ phase: "running" });
    const notes: string[] = [];
    try {
      const now = this.now();
      const { icloud } = await this.driver.status();
      const name = `${DAILY_PREFIX}${dateStamp(now)}.json`;
      const data = backupFileContent(state, "daily", undefined, now);
      const files = (await this.driver.list()).map(classify);
      // In iCloud bevorzugt; ist iCloud aus, zählt die lokale Datei
      const target: BackupLocation = icloud ? "icloud" : "local";
      const existing = files.find((f) => f.name === name && f.location === target);

      let location: BackupLocation;
      if (!existing) {
        location = await this.writeDailyCreate(name, data, state, notes);
      } else {
        location = await this.replaceDailySafely(existing, name, data, state, notes);
      }

      if (icloud && files.some((f) => f.location === "local" && f.kind !== "other")) {
        try {
          const t = await this.driver.transferLocalToICloud();
          if (t.moved + t.renamed > 0) notes.push(`${t.moved + t.renamed} lokale Sicherung(en) nach iCloud übertragen`);
        } catch (err) {
          notes.push(`Übertragung lokaler Sicherungen nach iCloud fehlgeschlagen: ${(err as Error).message}`);
        }
      }
      await this.prune(notes);

      const at = now.toISOString();
      await this.markBackedUp(revision, at);
      this.setStatus({
        phase: "ok",
        lastSuccessAt: at,
        location,
        failures: 0,
        nextRetryAt: null,
        message: [location === "local" ? "iCloud Drive ist nicht verfügbar – vorerst auf dem iPhone gesichert. Wird automatisch nach iCloud übertragen, sobald möglich." : null, ...notes]
          .filter(Boolean)
          .join(" ") || null,
      });
      // Während der Sicherung geändert? Dann gleich noch einmal.
      if (this.getState().meta.revision !== revision) this.schedule();
    } catch (err) {
      const failures = this.status.failures + 1;
      const delay = RETRY_DELAYS_MS[Math.min(failures - 1, RETRY_DELAYS_MS.length - 1)];
      this.setStatus({
        phase: "error",
        failures,
        message: (err as Error).message || "Unbekannter Fehler",
        nextRetryAt: new Date(this.now().getTime() + delay).toISOString(),
      });
      this.schedule(delay);
    }
    return this.status;
  }

  private async writeDailyCreate(name: string, data: string, state: AppState, notes: string[]): Promise<BackupLocation> {
    try {
      return (await this.driver.write(name, data, "create")).location;
    } catch (err) {
      if (!(err instanceof BackupExistsError) && (err as { code?: string }).code !== "EXISTS") throw err;
      // Datei ist inzwischen entstanden (z. B. iCloud-Abgleich) – mit Schutzprüfung ersetzen
      const files = (await this.driver.list()).map(classify);
      const existing = files.find((f) => f.name === name);
      if (!existing) throw err;
      return this.replaceDailySafely(existing, name, data, state, notes);
    }
  }

  /** Ersetzt die heutige Tagessicherung nur, wenn dabei nichts verloren geht. */
  private async replaceDailySafely(existing: BackupEntry, name: string, data: string, state: AppState, notes: string[]): Promise<BackupLocation> {
    let previousText: string | null = null;
    let previous: AppState | null = null;
    try {
      previousText = await this.driver.read(existing.name, existing.location);
      previous = parseBackupText(previousText).state;
    } catch {
      previous = null;
    }
    if (!previous) {
      // Vorhandene Datei unlesbar (oder nicht ladbar): nicht anfassen, aktuellen Stand separat sichern
      const point = await this.createRestorePoint("abweichender-Stand", state);
      notes.push(`Die heutige Sicherung war nicht lesbar und wurde nicht überschrieben; aktueller Stand liegt in „${point}“.`);
      return existing.location;
    }
    if (previous.meta.revision > state.meta.revision) {
      // Vorhandene Sicherung ist neuer als die App-Daten (z. B. nach Neuinstallation) – nicht ersetzen
      const point = await this.createRestorePoint("abweichender-Stand", state);
      notes.push(`Die vorhandene Tagessicherung ist neuer als die Daten in der App und bleibt erhalten; aktueller Stand liegt in „${point}“.`);
      return existing.location;
    }
    if (recordCount(previous) > recordCount(state)) {
      // Es würden Einträge aus der Sicherung verschwinden – alten Inhalt vorher unveränderlich ablegen
      await this.writeRestorePointRaw("vor-Ueberschreiben", previousText!);
    }
    return (await this.driver.write(name, data, "replace")).location;
  }

  /** Legt einen unveränderlichen Wiederherstellungspunkt an und gibt den Dateinamen zurück. */
  async createRestorePoint(reason: RestorePointReason, state: AppState): Promise<string> {
    const now = this.now();
    return this.writeRestorePointRaw(reason, backupFileContent(state, "restore-point", reason, now));
  }

  private async writeRestorePointRaw(reason: RestorePointReason, data: string): Promise<string> {
    const base = `${POINT_PREFIX}${stamp(this.now())}_${reason}`;
    for (let i = 1; i <= 20; i++) {
      const name = i === 1 ? `${base}.json` : `${base}-${i}.json`;
      try {
        await this.driver.write(name, data, "create");
        if (this.opts.maxRestorePoints !== undefined) await this.prune([]);
        return name;
      } catch (err) {
        if (err instanceof BackupExistsError || (err as { code?: string }).code === "EXISTS") continue;
        throw err;
      }
    }
    throw new Error("Wiederherstellungspunkt konnte nicht angelegt werden (Name belegt).");
  }

  private async prune(notes: string[]) {
    try {
      const entries = (await this.driver.list()).map(classify);
      for (const e of selectForPruning(entries, this.now(), this.opts)) await this.driver.remove(e.name, e.location);
    } catch (err) {
      notes.push(`Alte Sicherungen konnten nicht aufgeräumt werden: ${(err as Error).message}`);
    }
  }

  async list(): Promise<BackupEntry[]> {
    const entries = (await this.driver.list()).map(classify).filter((e) => e.kind !== "other" || e.name.endsWith(".json"));
    return entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || b.name.localeCompare(a.name));
  }

  async read(entry: Pick<BackupEntry, "name" | "location">): Promise<{ state: AppState; report: ImportReport }> {
    return parseBackupText(await this.driver.read(entry.name, entry.location));
  }

  /**
   * Sucht nach einer Neuinstallation die neueste lesbare Sicherung mit Daten.
   * Ändert nichts – die Wiederherstellung erfolgt nur nach Bestätigung.
   */
  async findRestoreCandidate(): Promise<{ entry: BackupEntry; state: AppState } | null> {
    const entries = (await this.list()).filter((e) => e.kind !== "other");
    for (const entry of entries.slice(0, 15)) {
      try {
        const { state } = await this.read(entry);
        if (!isEmptyState(state)) return { entry, state };
      } catch {
        /* nächste probieren */
      }
    }
    return null;
  }
}
