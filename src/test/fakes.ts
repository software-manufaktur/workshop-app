// Test-Doubles für Speicher und iCloud – bilden das Verhalten des Swift-Plugins nach.
import { BackupExistsError, type BackupDriver, type BackupFileInfo, type BackupLocation, type StateStorage, type StoredState } from "../storage";

export class MemStateStorage implements StateStorage {
  data: string | null = null;
  previous: string | null = null;
  corrupt: string[] = [];
  saves = 0;
  failNextSaves = 0;
  delayMs = 0;

  async load(): Promise<StoredState> {
    return { data: this.data, previous: this.previous };
  }
  async save(json: string) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs * Math.random()));
    if (this.failNextSaves > 0) {
      this.failNextSaves--;
      throw new Error("Speicher voll");
    }
    if (this.data !== null) this.previous = this.data;
    this.data = json;
    this.saves++;
  }
  async preserveCorrupt(raw: string) {
    this.corrupt.push(raw);
  }
}

interface FakeFile {
  data: string;
  mtime: string;
  downloaded: boolean;
}

export class FakeBackupDriver implements BackupDriver {
  icloud = true;
  files = { icloud: new Map<string, FakeFile>(), local: new Map<string, FakeFile>() };
  failWrites = 0;
  failReads = new Set<string>();
  writes: { name: string; mode: string; location: BackupLocation }[] = [];
  clock: () => Date = () => new Date();

  async status() {
    return { icloud: this.icloud };
  }
  async write(name: string, data: string, mode: "create" | "replace") {
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error("iCloud nicht erreichbar");
    }
    const location: BackupLocation = this.icloud ? "icloud" : "local";
    const dir = this.files[location];
    if (mode === "create" && dir.has(name)) throw new BackupExistsError(name);
    dir.set(name, { data, mtime: this.clock().toISOString(), downloaded: true });
    this.writes.push({ name, mode, location });
    return { location };
  }
  async list(): Promise<BackupFileInfo[]> {
    const out: BackupFileInfo[] = [];
    for (const location of ["icloud", "local"] as const) {
      if (location === "icloud" && !this.icloud) continue;
      for (const [name, f] of this.files[location]) out.push({ name, modifiedAt: f.mtime, size: f.data.length, location, downloaded: f.downloaded });
    }
    return out;
  }
  async read(name: string, location: BackupLocation) {
    if (this.failReads.has(name)) throw new Error("nicht lesbar");
    const f = this.files[location].get(name);
    if (!f) throw new Error("nicht gefunden");
    return f.data;
  }
  async remove(name: string, location: BackupLocation) {
    this.files[location].delete(name);
  }
  async transferLocalToICloud() {
    let moved = 0,
      renamed = 0,
      duplicates = 0;
    for (const [name, f] of [...this.files.local]) {
      const existing = this.files.icloud.get(name);
      if (!existing) {
        this.files.icloud.set(name, f);
        moved++;
      } else if (existing.data === f.data) {
        duplicates++;
      } else {
        let i = 1;
        let target = name.replace(/\.json$/, "-lokal.json");
        while (this.files.icloud.has(target)) target = name.replace(/\.json$/, `-lokal-${++i}.json`);
        this.files.icloud.set(target, f);
        renamed++;
      }
      this.files.local.delete(name);
    }
    return { moved, renamed, duplicates };
  }
  names(location: BackupLocation = "icloud") {
    return [...this.files[location].keys()].sort();
  }
}

export const legacySlots = (iso: (h: number) => string) => [
  { id: "s1", title: "Schmuck-Workshop", starts_at: iso(48), ends_at: iso(50), capacity: 10, archived: false },
  { id: "s2", title: "JGA", starts_at: iso(-26), ends_at: iso(-24), capacity: 6, archived: false },
];
