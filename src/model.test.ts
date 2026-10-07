import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIRMATION_TEMPLATE,
  autoArchive,
  emptyState,
  fromLegacyLocalStorage,
  normalizePhoneDE,
  normalizeState,
  slotStatus,
} from "./model";
import { buildCsv, buildIcs, esc, fillTemplate, mailtoUrl } from "./format";

// Ausschnitt einer echten Sicherung der alten Web-App (Format version 1)
const legacyBackup = {
  version: 1,
  exported_at: "2025-09-16T10:00:00.000Z",
  slots: [
    { id: "s1", title: "Schmuck-Workshop", starts_at: "2025-09-20T15:00:00.000Z", ends_at: "2025-09-20T17:00:00.000Z", capacity: 10, archived: false },
    { id: "s2", title: "Firmenfeier", starts_at: "2025-10-01T15:00:00.000Z", ends_at: "2025-10-01T17:00:00.000Z", capacity: "8", archived: true },
  ],
  bookings: [
    { id: "b1", slotId: "s1", salutation: "Liebe", name: "Anna", phone: "0170 1234567", notes: "", count: 2, channel: "Instagram", created_at: "2025-09-01T10:00:00.000Z" },
    { id: "b2", slotId: "s2", name: "Ben", phone: "+49 171 2222", count: 1 },
    { id: "b3", slotId: "gibt-es-nicht", name: "Waise", phone: "1", count: 1 },
  ],
};

describe("normalizeState", () => {
  it("übernimmt Sicherungen der alten Web-App vollständig", () => {
    const s = normalizeState(legacyBackup);
    expect(s.schemaVersion).toBe(2);
    expect(s.slots).toHaveLength(2);
    expect(s.slots[1].capacity).toBe(8);
    expect(s.bookings.map((b) => b.id)).toEqual(["b1", "b2"]); // verwaiste Buchung fällt weg
    expect(s.bookings[0]).toMatchObject({ name: "Anna", salutation: "Liebe", count: 2, email: "", reviewConsent: false, reviewRequestedAt: null });
    expect(s.bookings[1].salutation).toBe("Liebe/r");
    expect(s.settings.confirmationTemplate).toBe(DEFAULT_CONFIRMATION_TEMPLATE);
  });

  it("versteht das Format der tempio-Entwicklungsversion", () => {
    const s = normalizeState({ version: 1, state: { slots: legacyBackup.slots, bookings: legacyBackup.bookings } });
    expect(s.slots).toHaveLength(2);
  });

  it("ist idempotent für den aktuellen Stand", () => {
    const once = normalizeState(legacyBackup);
    expect(normalizeState(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it("lehnt fremde Dateien ab", () => {
    expect(() => normalizeState({ foo: 1 })).toThrow(/Datenformat/);
    expect(() => normalizeState(null)).toThrow();
  });

  it("verwirft kaputte Einträge statt abzustürzen", () => {
    const s = normalizeState({ slots: [{ id: "x" }, null, { id: "y", starts_at: "2025-01-01T10:00:00Z" }], bookings: [42] });
    expect(s.slots.map((x) => x.id)).toEqual(["y"]);
    expect(s.slots[0].ends_at).toBe("2025-01-01T12:00:00.000Z");
  });

  it("stellt sicher, dass 'Sonstiges' als Kategorie existiert", () => {
    const s = normalizeState({ slots: [], bookings: [], settings: { categories: ["A", "B"] } });
    expect(s.settings.categories).toEqual(["A", "B", "Sonstiges"]);
  });
});

describe("fromLegacyLocalStorage", () => {
  it("liest die alten Schlüssel inkl. eigener WhatsApp-Vorlage", () => {
    const store: Record<string, string> = {
      seeyou_slots_v1: JSON.stringify(legacyBackup.slots),
      seeyou_bookings_v1: JSON.stringify(legacyBackup.bookings),
      seeyou_whatsapp_template_v1: JSON.stringify("Hallo [Name]!"),
      seeyou_collapsed_slots_v1: JSON.stringify(["s1", "weg"]),
    };
    const s = fromLegacyLocalStorage((k) => store[k] ?? null)!;
    expect(s.bookings).toHaveLength(2);
    expect(s.settings.confirmationTemplate).toBe("Hallo [Name]!");
    expect(s.ui.collapsedSlots).toEqual(["s1"]);
  });

  it("gibt null zurück, wenn es keine alten Daten gibt", () => {
    expect(fromLegacyLocalStorage(() => null)).toBeNull();
  });
});

describe("Status & Archiv", () => {
  const state = normalizeState(legacyBackup);
  it("berechnet den Status", () => {
    expect(slotStatus(state, state.slots[0], new Date("2025-09-19T00:00:00Z"))).toBe("open");
    expect(slotStatus(state, state.slots[0], new Date("2025-09-21T00:00:00Z"))).toBe("past");
    expect(slotStatus(state, state.slots[1])).toBe("archived");
  });
  it("archiviert erst nach der Karenzzeit (damit Feedback angefragt werden kann)", () => {
    const s = structuredClone(state);
    expect(autoArchive(s, new Date("2025-09-22T00:00:00Z"))).toBe(false);
    expect(autoArchive(s, new Date("2025-09-24T00:00:00Z"))).toBe(true);
    expect(s.slots[0].archived).toBe(true);
  });
});

describe("Telefonnummern", () => {
  it.each([
    ["0170 1234567", "491701234567"],
    ["+49 (170) 123-4567", "491701234567"],
    ["0049 170 1234567", "491701234567"],
    ["+43 660 1234", "436601234"],
  ])("%s → %s", (input, out) => expect(normalizePhoneDE(input)).toBe(out));
});

describe("Vorlagen", () => {
  const slot = normalizeState(legacyBackup).slots[0];
  it("setzt Einzahl/Mehrzahl korrekt ein", () => {
    const tpl = "[Anrede] [Name], danke [Du_Dat]! Ich habe [Du_Akk] gern begleitet, [Du_Nom] wart toll. [Link] [Unbekannt]";
    expect(fillTemplate(tpl, { salutation: "Liebe", name: "Anna", count: 1 }, slot, "https://x")).toBe(
      "Liebe Anna, danke dir! Ich habe dich gern begleitet, du wart toll. https://x [Unbekannt]",
    );
    expect(fillTemplate("[Du_Dat]/[Du_Akk]/[Du_Nom]", { salutation: "", name: "", count: 3 }, slot)).toBe("euch/euch/ihr");
  });
});

describe("Escaping & Export", () => {
  it("escaped HTML", () => {
    expect(esc(`<img src=x onerror="alert('x')">`)).toBe("&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;");
  });

  it("CSV: Anführungszeichen, Semikolon und Formel-Injection", () => {
    const s = normalizeState(legacyBackup);
    s.bookings[0].name = '=HYPERLINK("x")';
    s.bookings[0].notes = 'sagt "hallo"; tschüss';
    const csv = buildCsv(s);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(`"sagt ""hallo""; tschüss"`);
    const rows = csv.trim().split("\r\n");
    const cols = rows[0].split(";").length;
    expect(rows.every((r) => r.match(/"(?:[^"]|"")*"/g)!.length === cols)).toBe(true);
  });

  it("ICS: gültige Zeiten und escapter Text", () => {
    const s = normalizeState(legacyBackup);
    s.slots[0].title = "Ringe, Ketten; mehr";
    const ics = buildIcs(s.slots[0], s.bookings.slice(0, 1), new Date("2025-09-01T00:00:00Z"));
    expect(ics).toContain("DTSTART:20250920T150000Z");
    expect(ics).toContain("SUMMARY:Ringe\\, Ketten\\; mehr");
    expect(ics).toContain("Teilnehmer: Anna (2)");
  });

  it("mailto mit BCC und CRLF", () => {
    const url = mailtoUrl({ bcc: ["a@b.de", "c@d.de"], subject: "Hallo & Danke", body: "Zeile 1\nZeile 2" });
    expect(url).toBe("mailto:?bcc=a%40b.de,c%40d.de&subject=Hallo%20%26%20Danke&body=Zeile%201%0D%0AZeile%202");
  });
});

it("emptyState ist gültig", () => {
  expect(normalizeState(emptyState())).toEqual(emptyState());
});
