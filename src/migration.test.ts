import { describe, expect, it } from "vitest";
import { fromLegacyLocalStorage, normalizeWithReport, PLACEHOLDER_NOTE } from "./model";
import { buildCsv } from "./format";

// Nachbau einer realistischen Sicherung der alten Web-App (exportBackup() in der alten app.js)
const OLD_BACKUP = {
  version: 1,
  exported_at: "2026-09-30T08:00:00.000Z",
  slots: [
    { id: "lq2x1", title: "Schmuck-Workshop", starts_at: "2026-10-10T15:00:00.000Z", ends_at: "2026-10-10T17:00:00.000Z", capacity: 10, archived: false },
    { id: "lq2x2", title: "Kindergeburtstag", starts_at: "2026-09-01T13:00:00.000Z", ends_at: "2026-09-01T15:00:00.000Z", capacity: 8, archived: true },
    { id: "lq2x3", title: "Firmen-Event „Herbst“", starts_at: "2026-11-02T16:00:00.000Z", ends_at: "2026-11-02T19:00:00.000Z", capacity: "12", archived: false },
  ],
  bookings: [
    { id: "b1", slotId: "lq2x1", salutation: "Liebe", name: "Anna Müller", phone: "0170 1234567", notes: "vegan; bringt Freundin mit", count: 2, channel: "Instagram", created_at: "2026-09-01T10:00:00.000Z" },
    { id: "b2", slotId: "lq2x1", salutation: "Lieber", name: "Jörg O'Neil", phone: "+49 171 2222", notes: "", count: 1, channel: "", created_at: "2026-09-02T10:00:00.000Z" },
    { id: "b3", slotId: "lq2x2", salutation: "Liebe/r", name: "Familie Schmidt", phone: "0172 333", notes: "Kind: Mia, 7 J.\nAllergie: Nüsse", count: 6, channel: "WhatsApp", created_at: "2026-08-01T10:00:00.000Z" },
    { id: "b4", slotId: "lq2x3", salutation: "Liebe", name: "<b>Test</b>", phone: "0173 444", notes: "", count: "3", channel: "E-Mail", created_at: "2026-09-20T10:00:00.000Z" },
  ],
};

const FIELDS = ["id", "slotId", "salutation", "name", "phone", "notes", "channel", "created_at"] as const;

describe("Migration der alten Sicherungsdatei", () => {
  const { state, report } = normalizeWithReport(structuredClone(OLD_BACKUP));

  it("übernimmt alle Termine mit allen Feldern unverändert", () => {
    expect(state.slots).toHaveLength(OLD_BACKUP.slots.length);
    for (const old of OLD_BACKUP.slots) {
      const s = state.slots.find((x) => x.id === old.id)!;
      expect(s).toMatchObject({ title: old.title, starts_at: old.starts_at, ends_at: old.ends_at, capacity: Number(old.capacity), archived: old.archived });
    }
  });

  it("übernimmt alle Buchungen mit allen Feldern unverändert", () => {
    expect(state.bookings).toHaveLength(OLD_BACKUP.bookings.length);
    for (const old of OLD_BACKUP.bookings) {
      const b = state.bookings.find((x) => x.id === old.id)!;
      for (const f of FIELDS) expect(b[f], `${old.id}.${f}`).toBe(old[f]);
      expect(b.count).toBe(Number(old.count));
    }
  });

  it("meldet keine Probleme bei sauberen Altdaten, weist aber auf fehlende Einstellungen hin", () => {
    expect(report.issues).toEqual([]);
    expect(report.quarantined).toBe(0);
    expect(report.placeholders).toBe(0);
    expect(report.hasSettings).toBe(false);
    expect(report).toMatchObject({ slotsIn: 3, slotsOut: 3, bookingsIn: 4, bookingsOut: 4 });
  });

  it("Rundreise: Export → Import ergibt exakt denselben Stand", () => {
    const again = normalizeWithReport(JSON.parse(JSON.stringify({ state }))).state;
    expect(again).toEqual(state);
  });

  it("CSV-Export enthält alle Buchungen", () => {
    const csv = buildCsv(state);
    for (const b of OLD_BACKUP.bookings) expect(csv).toContain(b.phone);
  });
});

describe("Migration: problematische Datensätze verschwinden nicht", () => {
  const broken = {
    slots: [
      { id: "a", title: "Ok", starts_at: "2026-01-01T10:00:00Z", ends_at: "2026-01-01T12:00:00Z", capacity: 5, farbe: "rot" },
      { id: "a", title: "Doppelte ID", starts_at: "2026-01-02T10:00:00Z", capacity: 5 },
      { id: "c", title: "Kein Datum", capacity: 4 },
      { id: "d", title: "Kapazität kaputt", starts_at: "2026-01-03T10:00:00Z", ends_at: "2026-01-03T12:00:00Z", capacity: "viele" },
      { title: "Ohne ID", starts_at: 1767261600000 },
      "Müll",
    ],
    bookings: [
      { id: "x1", slotId: "a", name: "Eva", phone: "1", count: 2, lieblingsfarbe: "blau" },
      { id: "x1", slotId: "a", name: "Doppel-ID", phone: "2", count: 1 },
      { id: "x3", slotId: "weg", name: "Waise 1", phone: "3", count: 1, created_at: "2025-12-01T00:00:00Z" },
      { id: "x4", slotId: "weg", name: "Waise 2", phone: "4", count: 1 },
      { id: "x5", name: "Ohne Termin", phone: "5", count: 0 },
      { id: "x6", slotId: "d", name: "", phone: "6", count: 3 },
      7,
    ],
  };
  const { state, report } = normalizeWithReport(structuredClone(broken));

  it("jeder Termin und jede Buchung ist noch da (oder in der Quarantäne)", () => {
    const realSlots = state.slots.filter((s) => !s.extra?.placeholder).length;
    const qSlots = state.quarantine.filter((q) => q.kind === "slot").length;
    const qBookings = state.quarantine.filter((q) => q.kind === "booking").length;
    expect(realSlots + qSlots).toBe(broken.slots.length);
    expect(state.bookings.length + qBookings).toBe(broken.bookings.length);
    expect(state.quarantine.map((q) => q.raw)).toEqual(["Müll", 7]);
  });

  it("unbekannte Felder bleiben erhalten", () => {
    expect(state.slots.find((s) => s.id === "a")!.extra).toEqual({ farbe: "rot" });
    expect(state.bookings.find((b) => b.name === "Eva")!.extra).toEqual({ lieblingsfarbe: "blau" });
  });

  it("doppelte IDs werden aufgelöst, der Originalwert bleibt vermerkt", () => {
    const dup = state.slots.find((s) => s.title === "Doppelte ID")!;
    expect(dup.id).not.toBe("a");
    expect(dup.extra?.originalId).toBe("a");
    expect(new Set(state.bookings.map((b) => b.id)).size).toBe(state.bookings.length);
  });

  it("verwaiste Buchungen landen gemeinsam in einem Ersatz-Termin", () => {
    const w1 = state.bookings.find((b) => b.name === "Waise 1")!;
    const w2 = state.bookings.find((b) => b.name === "Waise 2")!;
    expect(w1.slotId).toBe(w2.slotId);
    const ph = state.slots.find((s) => s.id === w1.slotId)!;
    expect(ph).toMatchObject({ title: "Unbekannter Termin", archived: true, notes: PLACEHOLDER_NOTE });
    expect(ph.extra).toMatchObject({ placeholder: true, originalSlotId: "weg" });
    expect(report.placeholders).toBe(2); // "weg" und "ohne Termin"
  });

  it("ungültige Werte werden repariert und der Originalwert aufbewahrt", () => {
    const x5 = state.bookings.find((b) => b.id === "x5")!;
    expect(x5.count).toBe(1);
    expect(x5.extra?.originalCount).toBe(0);
    const d = state.slots.find((s) => s.id === "d")!;
    expect(d.capacity).toBe(3); // = gebuchte Personen
    expect(d.extra?.originalCapacity).toBe("viele");
    expect(state.bookings.find((b) => b.id === "x6")!.name).toBe("(ohne Namen)");
    const c = state.slots.find((s) => s.id === "c")!;
    expect(c.title).toContain("Datum ungültig");
    const ts = state.slots.find((s) => s.title === "Ohne ID")!;
    expect(ts.starts_at).toBe(new Date(1767261600000).toISOString());
  });

  it("der Bericht nennt die Anpassungen verständlich", () => {
    const text = report.issues.join("\n");
    expect(text).toMatch(/doppelter ID/);
    expect(text).toMatch(/ohne passenden Termin/);
    expect(text).toMatch(/Personenzahl/);
    expect(text).toMatch(/nicht lesbar/);
  });

  it("ist stabil: zweite Normalisierung ändert nichts und meldet nichts mehr", () => {
    const again = normalizeWithReport(JSON.parse(JSON.stringify(state)));
    expect(again.state).toEqual(state);
    expect(again.report.quarantined).toBe(0);
    expect(again.report.placeholders).toBe(0);
  });
});

describe("Übernahme aus dem localStorage der alten Web-App", () => {
  it("übernimmt Vorlage, Klappzustände und letztes Backup-Datum", () => {
    const ls: Record<string, string> = {
      seeyou_slots_v1: JSON.stringify(OLD_BACKUP.slots),
      seeyou_bookings_v1: JSON.stringify(OLD_BACKUP.bookings),
      seeyou_whatsapp_template_v1: JSON.stringify("Hallo [Name], bis [Datum]!\nStefanie"),
      seeyou_active_collapsed_v1: "true",
      seeyou_arch_collapsed_v1: "false",
      seeyou_collapsed_slots_v1: JSON.stringify(["lq2x2"]),
      seeyou_last_backup_v1: "2026-09-29",
    };
    const { state, report } = fromLegacyLocalStorage((k) => ls[k] ?? null)!;
    expect(state.settings.confirmationTemplate).toBe("Hallo [Name], bis [Datum]!\nStefanie");
    expect(state.ui).toEqual({ collapsedActive: true, collapsedArchive: false, collapsedSlots: ["lq2x2"] });
    expect(state.meta.lastExportAt).toBe("2026-09-29T12:00:00.000Z");
    expect(state.bookings).toHaveLength(4);
    expect(report.hasSettings).toBe(true);
  });

  it("bricht bei beschädigten Altdaten ab, statt sie als leer zu behandeln", () => {
    const ls: Record<string, string> = { seeyou_slots_v1: "{kaputt", seeyou_bookings_v1: "[]" };
    expect(() => fromLegacyLocalStorage((k) => ls[k] ?? null)).toThrow(/beschädigt/);
  });
});
