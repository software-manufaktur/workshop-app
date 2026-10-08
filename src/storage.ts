// Treiber für die Persistenz des App-Zustands und der Sicherungsdateien.
// Die Logik (store.ts / backup.ts) kennt nur diese Schnittstellen und ist
// dadurch ohne iPhone vollständig testbar.

export interface StoredState {
  data: string | null;
  /** Vorheriger Stand (eine Speicherung zurück), Rückfallebene bei Beschädigung. */
  previous: string | null;
}

export interface StateStorage {
  load(): Promise<StoredState>;
  /** Muss atomar sein: Entweder ist danach der neue Stand gespeichert oder der alte unverändert. */
  save(json: string): Promise<void>;
  /** Legt eine unlesbare Datei zur späteren Analyse beiseite, bevor sie ersetzt wird. */
  preserveCorrupt(raw: string): Promise<void>;
}

export type BackupLocation = "icloud" | "local";

export interface BackupFileInfo {
  name: string;
  modifiedAt: string;
  size: number;
  location: BackupLocation;
  /** false = liegt nur in iCloud und wird beim Lesen erst heruntergeladen. */
  downloaded: boolean;
}

export class BackupExistsError extends Error {
  code = "EXISTS";
  constructor(name: string) {
    super(`Sicherung „${name}“ existiert bereits`);
  }
}

export interface BackupDriver {
  /** Ob iCloud Drive aktuell verfügbar ist. */
  status(): Promise<{ icloud: boolean }>;
  /**
   * Schreibt eine Sicherungsdatei (iCloud, sonst lokal).
   * mode "create" schlägt mit BackupExistsError fehl, wenn die Datei schon existiert.
   */
  write(name: string, data: string, mode: "create" | "replace"): Promise<{ location: BackupLocation }>;
  list(): Promise<BackupFileInfo[]>;
  read(name: string, location: BackupLocation): Promise<string>;
  remove(name: string, location: BackupLocation): Promise<void>;
  /** Verschiebt lokale Ersatzsicherungen nach iCloud, ohne dort etwas zu überschreiben. */
  transferLocalToICloud(): Promise<{ moved: number; renamed: number; duplicates: number }>;
}

/* ---------- Web: localStorage ---------- */

const KEY = "seeyou_state_v2";
const KEY_PREV = "seeyou_state_v2_prev";

export class WebStateStorage implements StateStorage {
  constructor(private ls: Storage = localStorage) {}

  async load(): Promise<StoredState> {
    return { data: this.ls.getItem(KEY), previous: this.ls.getItem(KEY_PREV) };
  }

  async save(json: string): Promise<void> {
    const current = this.ls.getItem(KEY);
    try {
      if (current !== null && current !== json) this.ls.setItem(KEY_PREV, current);
      this.ls.setItem(KEY, json);
    } catch (err) {
      // z. B. Speicher voll: alten Stand wiederherstellen, Fehler melden
      if (current !== null) this.ls.setItem(KEY, current);
      throw new Error(`Speichern auf dem Gerät fehlgeschlagen: ${(err as Error).message}`);
    }
    if (this.ls.getItem(KEY) !== json) throw new Error("Speichern auf dem Gerät fehlgeschlagen (Prüfung)");
  }

  async preserveCorrupt(raw: string): Promise<void> {
    try {
      this.ls.setItem(`seeyou_state_corrupt_${Date.now()}`, raw);
    } catch {
      /* Platz reicht nicht – Original bleibt dann im Hauptschlüssel, bis bewusst ersetzt wird */
    }
  }
}

/**
 * Web-Version: Es gibt keine automatischen Dateisicherungen, aber
 * Wiederherstellungspunkte vor kritischen Aktionen werden im Browser abgelegt.
 */
export class WebRestorePointDriver implements BackupDriver {
  private prefix = "seeyou_backup::";
  constructor(private ls: Storage = localStorage) {}

  async status() {
    return { icloud: false };
  }
  async write(name: string, data: string, mode: "create" | "replace") {
    const key = this.prefix + name;
    if (mode === "create" && this.ls.getItem(key) !== null) throw new BackupExistsError(name);
    this.ls.setItem(key, data);
    this.ls.setItem(`${key}::mtime`, new Date().toISOString());
    return { location: "local" as const };
  }
  async list(): Promise<BackupFileInfo[]> {
    const out: BackupFileInfo[] = [];
    for (let i = 0; i < this.ls.length; i++) {
      const k = this.ls.key(i);
      if (!k?.startsWith(this.prefix) || k.endsWith("::mtime")) continue;
      const name = k.slice(this.prefix.length);
      out.push({
        name,
        modifiedAt: this.ls.getItem(`${k}::mtime`) ?? new Date(0).toISOString(),
        size: this.ls.getItem(k)?.length ?? 0,
        location: "local",
        downloaded: true,
      });
    }
    return out;
  }
  async read(name: string) {
    const v = this.ls.getItem(this.prefix + name);
    if (v === null) throw new Error(`Sicherung „${name}“ nicht gefunden`);
    return v;
  }
  async remove(name: string) {
    this.ls.removeItem(this.prefix + name);
    this.ls.removeItem(`${this.prefix}${name}::mtime`);
  }
  async transferLocalToICloud() {
    return { moved: 0, renamed: 0, duplicates: 0 };
  }
}
