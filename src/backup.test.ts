import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupManager, RETRY_DELAYS_MS, classify, parseBackupText, selectForPruning } from "./backup";
import { Store } from "./store";
import { normalizeState, uid, type AppState } from "./model";
import { FakeBackupDriver, MemStateStorage } from "./test/fakes";

const slot = (title = "Workshop") => ({
  id: uid(),
  title,
  starts_at: "2030-01-01T10:00:00.000Z",
  ends_at: "2030-01-01T12:00:00.000Z",
  capacity: 10,
  archived: false,
  notes: "",
});

let clock = new Date("2026-10-08T09:00:00");
const now = () => clock;

async function setup(opts: { driver?: FakeBackupDriver; storage?: MemStateStorage } = {}) {
  const driver = opts.driver ?? new FakeBackupDriver();
  driver.clock = now;
  const storage = opts.storage ?? new MemStateStorage();
  const store = new Store(storage, { now });
  await store.init();
  const mgr = new BackupManager(
    driver,
    () => store.get(),
    async (rev, at) => {
      await store.update((d) => {
        d.meta.lastBackupRevision = rev;
        d.meta.lastBackupAt = at;
      });
    },
    { now },
  );
  store.onContentChange(() => mgr.schedule());
  return { driver, storage, store, mgr };
}

const fileState = (driver: FakeBackupDriver, name: string, loc: "icloud" | "local" = "icloud"): AppState =>
  parseBackupText(driver.files[loc].get(name)!.data).state;

beforeEach(() => {
  clock = new Date("2026-10-08T09:00:00");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => vi.useRealTimers());

describe("Automatische Sicherung", () => {
  it("sichert nach einer Änderung (entprellt) als Tagessicherung", async () => {
    const { driver, store } = await setup();
    await store.update((d) => void d.slots.push(slot("A")));
    await store.update((d) => void d.slots.push(slot("B")));
    expect(driver.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(driver.names()).toEqual(["SeeYou-Sicherung-2026-10-08.json"]);
    expect(driver.writes).toHaveLength(1); // beide Änderungen in einer Sicherung
    expect(fileState(driver, "SeeYou-Sicherung-2026-10-08.json").slots).toHaveLength(2);
    expect(store.get().meta.lastBackupRevision).toBe(store.get().meta.revision);
  });

  it("sichert niemals einen leeren Datenstand (Schutz nach Neuinstallation)", async () => {
    const { driver, mgr } = await setup();
    const st = await mgr.run(true);
    expect(st.phase).toBe("skipped");
    expect(driver.writes).toHaveLength(0);
  });

  it("schreibt ohne Änderung keine neue Datei", async () => {
    const { driver, store, mgr } = await setup();
    await store.update((d) => void d.slots.push(slot()));
    await mgr.run();
    clock = new Date("2026-10-09T09:00:00");
    await mgr.run();
    expect(driver.writes).toHaveLength(1);
  });

  it("legt pro Tag mit Änderungen eine Datei an", async () => {
    const { driver, store, mgr } = await setup();
    await store.update((d) => void d.slots.push(slot()));
    await mgr.run();
    clock = new Date("2026-10-09T09:00:00");
    await store.update((d) => void d.slots.push(slot()));
    await mgr.run();
    expect(driver.names()).toEqual(["SeeYou-Sicherung-2026-10-08.json", "SeeYou-Sicherung-2026-10-09.json"]);
    expect(fileState(driver, "SeeYou-Sicherung-2026-10-08.json").slots).toHaveLength(1);
  });

  it("sichert erneut, wenn sich während der Sicherung etwas ändert", async () => {
    const { driver, store, mgr } = await setup();
    await store.update((d) => void d.slots.push(slot()));
    const run = mgr.run();
    await store.update((d) => void d.slots.push(slot()));
    await run;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fileState(driver, "SeeYou-Sicherung-2026-10-08.json").slots).toHaveLength(2);
    expect(mgr.isDirty()).toBe(false);
  });

  it("flush() schreibt ausstehende Änderungen sofort (App geht in den Hintergrund)", async () => {
    const { driver, store, mgr } = await setup();
    await store.update((d) => void d.slots.push(slot()));
    await mgr.flush();
    expect(driver.writes).toHaveLength(1);
  });
});

describe("Fehler und Wiederholung", () => {
  it("meldet Fehler und wiederholt mit wachsendem Abstand, bis es klappt", async () => {
    const { driver, store, mgr } = await setup();
    driver.failWrites = 2;
    await store.update((d) => void d.slots.push(slot()));
    await vi.advanceTimersByTimeAsync(3000);
    expect(mgr.status.phase).toBe("error");
    expect(mgr.status.failures).toBe(1);
    expect(mgr.status.message).toMatch(/iCloud nicht erreichbar/);
    expect(mgr.isDirty()).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    expect(mgr.status.failures).toBe(2);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1] - 1000);
    expect(driver.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mgr.status.phase).toBe("ok");
    expect(mgr.status.failures).toBe(0);
    expect(driver.names()).toEqual(["SeeYou-Sicherung-2026-10-08.json"]);
    expect(mgr.isDirty()).toBe(false);
  });

  it("markiert eine fehlgeschlagene Sicherung nicht als erledigt (wird beim nächsten Start nachgeholt)", async () => {
    const storage = new MemStateStorage();
    const first = await setup({ storage });
    first.driver.failWrites = 99;
    await first.store.update((d) => void d.slots.push(slot()));
    await first.mgr.run();
    first.mgr.dispose();
    const second = await setup({ storage });
    expect(second.mgr.isDirty()).toBe(true);
    await second.mgr.run();
    expect(second.driver.names()).toHaveLength(1);
  });
});

describe("Keine unbemerkten Überschreibungen", () => {
  it("hebt den alten Tagesstand als Wiederherstellungspunkt auf, wenn Einträge wegfallen", async () => {
    const { driver, store, mgr } = await setup();
    await store.update((d) => void d.slots.push(slot("A"), slot("B")));
    await mgr.run();
    await store.update((d) => void d.slots.pop());
    await mgr.run();
    const names = driver.names();
    const point = names.find((n) => n.includes("vor-Ueberschreiben"))!;
    expect(point).toMatch(/^SeeYou-Wiederherstellungspunkt-2026-10-08_09-00-00_vor-Ueberschreiben\.json$/);
    expect(fileState(driver, point).slots).toHaveLength(2);
    expect(fileState(driver, "SeeYou-Sicherung-2026-10-08.json").slots).toHaveLength(1);
  });

  it("überschreibt nach einer Neuinstallation nie eine neuere vorhandene Sicherung", async () => {
    // Altes iPhone hat heute schon gesichert (Revision 40, 25 Termine)
    const driver = new FakeBackupDriver();
    const old = normalizeState({ slots: Array.from({ length: 25 }, () => slot()), bookings: [], meta: { revision: 40 } });
    driver.files.icloud.set("SeeYou-Sicherung-2026-10-08.json", { data: JSON.stringify({ state: old }), mtime: clock.toISOString(), downloaded: true });
    // Neu installierte App: Nutzerin legt versehentlich einen Termin an, bevor sie wiederherstellt
    const { store, mgr } = await setup({ driver });
    await store.update((d) => void d.slots.push(slot("Neu")));
    await mgr.run();
    expect(fileState(driver, "SeeYou-Sicherung-2026-10-08.json").slots).toHaveLength(25);
    const point = driver.names().find((n) => n.includes("abweichender-Stand"))!;
    expect(fileState(driver, point).slots).toHaveLength(1);
    expect(mgr.status.message).toMatch(/neuer als die Daten in der App/);
  });

  it("überschreibt keine unlesbare Tagessicherung", async () => {
    const driver = new FakeBackupDriver();
    driver.files.icloud.set("SeeYou-Sicherung-2026-10-08.json", { data: "{kaputt", mtime: clock.toISOString(), downloaded: true });
    const { store, mgr } = await setup({ driver });
    await store.update((d) => void d.slots.push(slot()));
    await mgr.run();
    expect(driver.files.icloud.get("SeeYou-Sicherung-2026-10-08.json")!.data).toBe("{kaputt");
    expect(driver.names().some((n) => n.includes("abweichender-Stand"))).toBe(true);
  });

  it("Wiederherstellungspunkte sind unveränderlich – gleiche Sekunde ergibt eine zweite Datei", async () => {
    const { driver, store, mgr } = await setup();
    await store.update((d) => void d.slots.push(slot("A")));
    const n1 = await mgr.createRestorePoint("vor-Import", store.get());
    await store.update((d) => void d.slots.push(slot("B")));
    const n2 = await mgr.createRestorePoint("vor-Import", store.get());
    expect(n1).not.toBe(n2);
    expect(n2).toMatch(/-2\.json$/);
    expect(fileState(driver, n1).slots).toHaveLength(1);
    expect(fileState(driver, n2).slots).toHaveLength(2);
    expect(driver.writes.filter((w) => w.name.startsWith("SeeYou-Wiederherstellungspunkt")).every((w) => w.mode === "create")).toBe(true);
  });
});

describe("Lokaler Fallback & Übertragung nach iCloud", () => {
  it("sichert lokal, wenn iCloud fehlt, und überträgt später ohne zu überschreiben", async () => {
    const { driver, store, mgr } = await setup();
    driver.icloud = false;
    await store.update((d) => void d.slots.push(slot()));
    await mgr.run();
    expect(mgr.status.location).toBe("local");
    expect(mgr.status.message).toMatch(/iCloud Drive ist nicht verfügbar/);
    expect(driver.names("local")).toEqual(["SeeYou-Sicherung-2026-10-08.json"]);

    // In der Zwischenzeit existiert in iCloud bereits eine andere Datei gleichen Namens
    driver.files.icloud.set("SeeYou-Sicherung-2026-10-08.json", {
      data: JSON.stringify({ state: normalizeState({ slots: [slot(), slot(), slot()], bookings: [], meta: { revision: 1 } }) }),
      mtime: clock.toISOString(),
      downloaded: true,
    });
    driver.icloud = true;
    clock = new Date("2026-10-09T09:00:00");
    await store.update((d) => void d.slots.push(slot()));
    await mgr.run();
    expect(driver.names("local")).toEqual([]);
    expect(driver.names()).toEqual([
      "SeeYou-Sicherung-2026-10-08-lokal.json",
      "SeeYou-Sicherung-2026-10-08.json",
      "SeeYou-Sicherung-2026-10-09.json",
    ]);
    expect(fileState(driver, "SeeYou-Sicherung-2026-10-08.json").slots).toHaveLength(3); // unverändert
    expect(mgr.status.location).toBe("icloud");
  });
});

describe("Rotation", () => {
  const entry = (name: string) => classify({ name, modifiedAt: "", size: 1, location: "icloud", downloaded: true });

  it("behält 60 Tage und mindestens 10 Dateien je Art", () => {
    const now = new Date("2026-10-08T12:00:00");
    const days = Array.from({ length: 80 }, (_, i) => {
      const d = new Date(now.getTime() - i * 86_400_000);
      return entry(`SeeYou-Sicherung-${d.toISOString().slice(0, 10)}.json`);
    });
    const del = selectForPruning(days, now, { keepDays: 60, minKeep: 10 });
    expect(del).toHaveLength(80 - 61);
    expect(del.every((e) => e.day! < "2026-08-09")).toBe(true);
  });

  it("löscht bei langer Pause nicht die letzten Sicherungen", () => {
    const old = ["2025-01-01", "2025-01-02", "2025-01-03"].map((d) => entry(`SeeYou-Sicherung-${d}.json`));
    expect(selectForPruning(old, new Date("2026-10-08"), { keepDays: 60, minKeep: 10 })).toEqual([]);
  });

  it("rührt fremde Dateien nie an", () => {
    const e = [entry("Notizen.json"), entry("SeeYou-Export-2020-01-01.json")];
    expect(selectForPruning(e, new Date("2026-10-08"), { keepDays: 1, minKeep: 0 })).toEqual([]);
  });

  it("räumt bei der Sicherung alte Dateien auf", async () => {
    const driver = new FakeBackupDriver();
    for (let i = 1; i <= 70; i++) {
      const d = new Date(new Date("2026-10-08T12:00:00").getTime() - i * 86_400_000).toISOString().slice(0, 10);
      driver.files.icloud.set(`SeeYou-Sicherung-${d}.json`, { data: "{}", mtime: "", downloaded: true });
    }
    const { store, mgr } = await setup({ driver });
    await store.update((d) => void d.slots.push(slot()));
    await mgr.run();
    const left = driver.names();
    expect(left).toHaveLength(61); // heute + 60 Tage
    expect(left[0]).toBe("SeeYou-Sicherung-2026-08-09.json");
  });
});

describe("Wiederherstellung nach Neuinstallation", () => {
  it("findet die neueste lesbare Sicherung mit Daten, ohne etwas zu ändern", async () => {
    const driver = new FakeBackupDriver();
    const good = normalizeState({ slots: [slot("Echt")], bookings: [] });
    driver.files.icloud.set("SeeYou-Sicherung-2026-10-06.json", { data: JSON.stringify({ state: good }), mtime: "2026-10-06T10:00:00.000Z", downloaded: true });
    driver.files.icloud.set("SeeYou-Sicherung-2026-10-07.json", { data: "{kaputt", mtime: "2026-10-07T10:00:00.000Z", downloaded: true });
    const { store, mgr } = await setup({ driver });
    const c = await mgr.findRestoreCandidate();
    expect(c?.entry.name).toBe("SeeYou-Sicherung-2026-10-06.json");
    expect(c?.state.slots[0].title).toBe("Echt");
    expect(store.get().slots).toHaveLength(0); // nichts automatisch übernommen
    expect(driver.writes).toHaveLength(0);
  });

  it("vollständiger Ablauf: Wiederherstellungspunkt → Ersetzen → neue Tagessicherung", async () => {
    const { driver, store, mgr } = await setup();
    await store.update((d) => void d.slots.push(slot("Aktuell")));
    await mgr.run();
    const fromFile = parseBackupText(JSON.stringify({ state: normalizeState({ slots: [slot("X"), slot("Y")], bookings: [] }) })).state;
    const point = await mgr.createRestorePoint("vor-Wiederherstellung", store.get());
    await store.replaceAll(fromFile);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fileState(driver, point).slots.map((s) => s.title)).toEqual(["Aktuell"]);
    expect(fileState(driver, "SeeYou-Sicherung-2026-10-08.json").slots.map((s) => s.title)).toEqual(["X", "Y"]);
  });
});

describe("Web: nur Wiederherstellungspunkte", () => {
  it("schreibt keine Tagessicherungen und begrenzt die Anzahl der Punkte", async () => {
    const driver = new FakeBackupDriver();
    driver.icloud = false;
    driver.clock = now;
    const store = new Store(new MemStateStorage(), { now });
    await store.init();
    await store.update((d) => void d.slots.push(slot()));
    const mgr = new BackupManager(driver, () => store.get(), async () => {}, { now, dailyEnabled: false, maxRestorePoints: 5, minKeep: 0 });
    await mgr.run(true);
    expect(driver.writes).toHaveLength(0);
    for (let i = 0; i < 8; i++) {
      clock = new Date(clock.getTime() + 1000);
      await mgr.createRestorePoint("vor-Import", store.get());
    }
    expect(driver.names("local")).toHaveLength(5);
  });
});
