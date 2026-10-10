// Zentraler Zustand: Laden, serialisiertes Speichern, Migration.
import {
  autoArchive,
  emptyState,
  fromLegacyLocalStorage,
  normalizeWithReport,
  type AppState,
  type ImportReport,
} from "./model";
import type { StateStorage } from "./storage";

export interface InitResult {
  /** Daten wurden aus der alten Web-App übernommen. */
  migration: ImportReport | null;
  /** Der Hauptspeicher war unlesbar, es wurde der vorherige Stand geladen. */
  recoveredFromPrevious: boolean;
  /** Daten sind unlesbar: Die App ist gesperrt, bis eine Sicherung wiederhergestellt wird. */
  fatalError: string | null;
}

export interface UpdateOptions {
  /** Nur speichern, wenn sich tatsächlich etwas geändert hat. */
  onlyIfChanged?: boolean;
}

export class StoreLockedError extends Error {
  constructor() {
    super("Die gespeicherten Daten konnten nicht gelesen werden. Bitte zuerst eine Sicherung wiederherstellen.");
  }
}

export class Store {
  private state: AppState = emptyState();
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(s: AppState) => void>();
  private contentListeners = new Set<(s: AppState) => void>();
  /** Gesetzt, wenn die gespeicherten Daten unlesbar sind – schützt sie vor dem Überschreiben. */
  locked = false;

  constructor(
    private storage: StateStorage,
    private opts: { legacyGet?: (key: string) => string | null; now?: () => Date } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  get(): AppState {
    return this.state;
  }

  /** Bei jeder gespeicherten Änderung (auch Ansicht). */
  subscribe(fn: (s: AppState) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Nur bei inhaltlichen Änderungen (Auslöser für Sicherungen). */
  onContentChange(fn: (s: AppState) => void) {
    this.contentListeners.add(fn);
    return () => this.contentListeners.delete(fn);
  }

  /** Führt Aufgaben strikt nacheinander aus; ein Fehler blockiert nachfolgende Aufgaben nicht. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async init(): Promise<InitResult> {
    return this.enqueue(async () => {
      const result: InitResult = { migration: null, recoveredFromPrevious: false, fatalError: null };
      const { data, previous } = await this.storage.load();
      if (data !== null) {
        const parsed = tryParse(data);
        if (parsed) {
          this.state = parsed;
        } else {
          const prev = previous !== null ? tryParse(previous) : null;
          await this.storage.preserveCorrupt(data);
          if (prev) {
            this.state = prev;
            result.recoveredFromPrevious = true;
            await this.storage.save(JSON.stringify(this.state));
          } else {
            this.locked = true;
            result.fatalError = "Die gespeicherten Daten sind beschädigt.";
            return result;
          }
        }
      } else if (this.opts.legacyGet) {
        try {
          const legacy = fromLegacyLocalStorage(this.opts.legacyGet);
          if (legacy) {
            this.state = legacy.state;
            this.state.meta.revision = 1;
            this.state.meta.updatedAt = this.now().toISOString();
            result.migration = legacy.report;
            await this.storage.save(JSON.stringify(this.state));
          }
        } catch (err) {
          this.locked = true;
          result.fatalError = (err as Error).message;
          return result;
        }
      }
      return result;
    }).then(async (result) => {
      if (!this.locked) await this.update((d) => void autoArchive(d, this.now()), { onlyIfChanged: true });
      this.emit(false);
      return result;
    });
  }

  /**
   * Ändert den Zustand. Änderungen werden serialisiert: Jede Mutation sieht das
   * Ergebnis der vorherigen. Der neue Zustand wird erst übernommen, wenn er
   * erfolgreich gespeichert ist – schlägt das fehl, bleibt alles beim Alten.
   */
  update(
    mutator: (draft: AppState) => void,
    opts: UpdateOptions = {},
  ): Promise<AppState> {
    return this.enqueue(async () => {
      if (this.locked) throw new StoreLockedError();
      const before = this.state;
      const draft = structuredClone(before);
      mutator(draft);
      const contentChanged = contentFingerprint(draft) !== contentFingerprint(before);
      if (opts.onlyIfChanged && JSON.stringify(draft) === JSON.stringify(before)) return before;
      // Ob etwas gesichert werden muss, entscheidet allein der Inhalt – nicht der Aufrufer.
      // So kann keine inhaltliche Änderung versehentlich "still" an der Sicherung vorbeilaufen.
      const isContent = contentChanged;
      if (isContent) {
        draft.meta.revision = before.meta.revision + 1;
        draft.meta.updatedAt = this.now().toISOString();
      }
      await this.storage.save(JSON.stringify(draft));
      this.state = draft;
      this.emit(isContent);
      return draft;
    });
  }

  /**
   * Ersetzt alle Daten (Import/Wiederherstellung). Die Revision steigt immer,
   * damit der neue Stand sicher als neueste Sicherung geschrieben wird.
   */
  replaceAll(next: AppState): Promise<AppState> {
    return this.enqueue(async () => {
      const cur = this.state;
      const draft: AppState = structuredClone(next);
      draft.meta = {
        ...draft.meta,
        revision: Math.max(cur.meta.revision, next.meta.revision) + 1,
        updatedAt: this.now().toISOString(),
        lastBackupRevision: null,
        lastBackupAt: cur.meta.lastBackupAt,
        lastExportAt: cur.meta.lastExportAt,
      };
      await this.storage.save(JSON.stringify(draft));
      this.state = draft;
      this.locked = false;
      this.emit(true);
      return draft;
    });
  }

  /** Lädt den gespeicherten Stand neu (z. B. wenn ein anderer Browser-Tab gespeichert hat). */
  reload(): Promise<void> {
    return this.enqueue(async () => {
      const { data } = await this.storage.load();
      const parsed = data ? tryParse(data) : null;
      if (parsed && parsed.meta.revision >= this.state.meta.revision) {
        this.state = parsed;
        this.emit(false);
      }
    });
  }

  /** Wartet, bis alle angestoßenen Speichervorgänge abgeschlossen sind. */
  async idle(): Promise<void> {
    await this.queue;
  }

  private emit(content: boolean) {
    for (const fn of this.listeners) fn(this.state);
    if (content) for (const fn of this.contentListeners) fn(this.state);
  }
}

function tryParse(raw: string): AppState | null {
  try {
    return normalizeWithReport(JSON.parse(raw)).state;
  } catch {
    return null;
  }
}

/** Alles, was gesichert werden muss – ohne Ansichtszustand und Sicherungs-Metadaten. */
function contentFingerprint(s: AppState): string {
  return JSON.stringify([s.slots, s.bookings, s.settings, s.quarantine]);
}
