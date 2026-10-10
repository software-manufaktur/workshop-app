import { describe, expect, it } from "vitest";
import { Store, StoreLockedError } from "./store";
import { emptyState, normalizeState, uid } from "./model";
import { MemStateStorage } from "./test/fakes";

const slot = (title = "Workshop") => ({
  id: uid(),
  title,
  starts_at: "2030-01-01T10:00:00.000Z",
  ends_at: "2030-01-01T12:00:00.000Z",
  capacity: 10,
  archived: false,
  notes: "",
});

async function freshStore(storage = new MemStateStorage()) {
  const store = new Store(storage);
  await store.init();
  return { store, storage };
}

describe("Store: Serialisierung", () => {
  it("verliert bei vielen gleichzeitigen Änderungen keine einzige", async () => {
    const storage = new MemStateStorage();
    storage.delayMs = 5; // zufällig langsame Speicherzugriffe
    const { store } = await freshStore(storage);
    await Promise.all(Array.from({ length: 40 }, (_, i) => store.update((d) => void d.slots.push(slot(`T${i}`)))));
    expect(store.get().slots).toHaveLength(40);
    // Gespeicherter Stand = Stand im Speicher (kein veralteter Schreibvorgang gewinnt)
    expect(JSON.parse(storage.data!).slots).toHaveLength(40);
    expect(store.get().meta.revision).toBe(40);
  });

  it("jede Mutation sieht das Ergebnis der vorherigen", async () => {
    const { store } = await freshStore();
    const seen: number[] = [];
    await Promise.all(
      Array.from({ length: 10 }, () =>
        store.update((d) => {
          seen.push(d.slots.length);
          d.slots.push(slot());
        }),
      ),
    );
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("übernimmt nichts, wenn Speichern fehlschlägt, und arbeitet danach normal weiter", async () => {
    const { store, storage } = await freshStore();
    await store.update((d) => void d.slots.push(slot("A")));
    storage.failNextSaves = 1;
    await expect(store.update((d) => void d.slots.push(slot("B")))).rejects.toThrow("Speicher voll");
    expect(store.get().slots.map((s) => s.title)).toEqual(["A"]);
    await store.update((d) => void d.slots.push(slot("C")));
    expect(store.get().slots.map((s) => s.title)).toEqual(["A", "C"]);
    expect(JSON.parse(storage.data!).slots.map((s: { title: string }) => s.title)).toEqual(["A", "C"]);
  });

  it("ein Fehler in der Mutation verändert nichts", async () => {
    const { store, storage } = await freshStore();
    const saves = storage.saves;
    await expect(
      store.update((d) => {
        d.slots.push(slot());
        throw new Error("Bug");
      }),
    ).rejects.toThrow("Bug");
    expect(store.get().slots).toHaveLength(0);
    expect(storage.saves).toBe(saves);
  });

  it("erhöht die Revision nur bei inhaltlichen Änderungen", async () => {
    const { store } = await freshStore();
    const changes: number[] = [];
    store.onContentChange((s) => changes.push(s.meta.revision));
    await store.update((d) => void d.slots.push(slot()));
    await store.update((d) => void (d.ui.collapsedActive = true));
    await store.update((d) => void (d.meta.lastExportAt = new Date().toISOString()));
    expect(store.get().meta.revision).toBe(1);
    expect(changes).toEqual([1]);
  });
});

describe("Store: Laden & Beschädigung", () => {
  it("lädt den vorherigen Stand, wenn der aktuelle unlesbar ist, und hebt den kaputten auf", async () => {
    const storage = new MemStateStorage();
    const good = emptyState();
    good.slots.push(slot("Gut"));
    storage.previous = JSON.stringify(good);
    storage.data = '{"schemaVersion":2,"slots":[{"id":';
    const store = new Store(storage);
    const r = await store.init();
    expect(r.recoveredFromPrevious).toBe(true);
    expect(store.get().slots[0].title).toBe("Gut");
    expect(storage.corrupt).toHaveLength(1);
  });

  it("sperrt Änderungen, wenn nichts lesbar ist – die Daten werden nie überschrieben", async () => {
    const storage = new MemStateStorage();
    storage.data = "kaputt";
    const store = new Store(storage);
    const r = await store.init();
    expect(r.fatalError).toBeTruthy();
    expect(store.locked).toBe(true);
    await expect(store.update((d) => void d.slots.push(slot()))).rejects.toBeInstanceOf(StoreLockedError);
    expect(storage.data).toBe("kaputt");
    // Bewusstes Wiederherstellen ist erlaubt und hebt die Sperre auf
    const restored = normalizeState({ slots: [slot("Aus Sicherung")], bookings: [] });
    await store.replaceAll(restored);
    expect(store.locked).toBe(false);
    expect(store.get().slots[0].title).toBe("Aus Sicherung");
    expect(storage.corrupt).toEqual(["kaputt"]);
  });

  it("übernimmt Altdaten aus dem localStorage genau einmal", async () => {
    const storage = new MemStateStorage();
    const ls: Record<string, string> = {
      seeyou_slots_v1: JSON.stringify([slot("Alt")]),
      seeyou_bookings_v1: "[]",
    };
    const store = new Store(storage, { legacyGet: (k) => ls[k] ?? null });
    const r = await store.init();
    expect(r.migration?.slotsOut).toBe(1);
    expect(store.get().meta.revision).toBe(1);
    await store.update((d) => void d.slots.push(slot("Neu")));
    // Zweiter Start: es wird der neue Stand geladen, nicht erneut migriert
    const store2 = new Store(storage, { legacyGet: (k) => ls[k] ?? null });
    const r2 = await store2.init();
    expect(r2.migration).toBeNull();
    expect(store2.get().slots.map((s) => s.title)).toEqual(["Alt", "Neu"]);
  });

  it("archiviert beim Start vergangene Termine und zählt das als Änderung", async () => {
    const storage = new MemStateStorage();
    const st = emptyState();
    st.slots.push({ ...slot("Alt"), starts_at: "2020-01-01T10:00:00.000Z", ends_at: "2020-01-01T12:00:00.000Z" });
    storage.data = JSON.stringify(st);
    const store = new Store(storage);
    await store.init();
    expect(store.get().slots[0].archived).toBe(true);
    expect(store.get().meta.revision).toBe(1);
  });
});

describe("Store: Ersetzen (Import/Wiederherstellung)", () => {
  it("erhöht die Revision über beide Stände hinaus und erzwingt eine neue Sicherung", async () => {
    const { store } = await freshStore();
    await store.update((d) => void d.slots.push(slot()));
    await store.update((d) => {
      d.meta.lastBackupRevision = d.meta.revision;
      d.meta.lastExportAt = "2026-01-01T00:00:00.000Z";
    });
    const imported = normalizeState({ slots: [slot("I")], bookings: [], meta: { revision: 50 } });
    await store.replaceAll(imported);
    expect(store.get().meta.revision).toBe(51);
    expect(store.get().meta.lastBackupRevision).toBeNull();
    expect(store.get().meta.lastExportAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
