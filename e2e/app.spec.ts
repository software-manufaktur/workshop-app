import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Eigenes ASCII-Verzeichnis: Chromium übernimmt Upload-Dateien aus Pfaden mit
// Sonderzeichen (z. B. "–" im Testtitel) stillschweigend nicht.
const tmp = (name: string) => join(mkdtempSync(join(tmpdir(), "seeyou-e2e-")), name);

const iso = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();

const LEGACY_SLOTS = [
  { id: "old1", title: "Schmuck-Workshop", starts_at: iso(48), ends_at: iso(50), capacity: 10, archived: false },
  { id: "old2", title: "JGA", starts_at: iso(-26), ends_at: iso(-24), capacity: 6, archived: false },
  { id: "old3", title: "Weihnachtsfeier", starts_at: iso(-2000), ends_at: iso(-1998), capacity: 6, archived: true },
];
const LEGACY_BOOKINGS = [
  { id: "b1", slotId: "old1", salutation: "Liebe", name: "Anna Alt", phone: "0170 1111111", count: 2, notes: "vegan", channel: "Instagram", created_at: iso(-100) },
  { id: "b2", slotId: "old2", salutation: "Lieber", name: "Ben", phone: "0171 2222222", count: 1, notes: "", channel: "", created_at: iso(-200) },
  { id: "b3", slotId: "old2", salutation: "Liebe", name: "Clara", phone: "0172 3333333", count: 3, notes: "", channel: "", created_at: iso(-210) },
  { id: "b4", slotId: "geloescht", salutation: "Liebe", name: "Waltraud Waise", phone: "0174 4444444", count: 1, notes: "", channel: "", created_at: iso(-300) },
];

/** Simuliert die alte Web-App: Daten liegen unter den alten localStorage-Schlüsseln. */
async function seedLegacy(page: Page) {
  await page.goto("/");
  await page.evaluate(
    ({ slots, bookings }) => {
      localStorage.clear();
      localStorage.setItem("seeyou_slots_v1", JSON.stringify(slots));
      localStorage.setItem("seeyou_bookings_v1", JSON.stringify(bookings));
      localStorage.setItem("seeyou_whatsapp_template_v1", JSON.stringify("[Anrede] [Name], bis bald am [Datum]!"));
    },
    { slots: LEGACY_SLOTS, bookings: LEGACY_BOOKINGS },
  );
  await page.reload();
  await expect(page.getByText("Anna Alt")).toBeVisible();
}

const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("seeyou_state_v2")!));

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "canShare", { value: undefined });
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = (u?: string | URL) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(u));
      return null;
    };
  });
});
test.afterEach(() => expect(errors).toEqual([]));

test("übernimmt die Daten der alten Web-App vollständig und meldet Auffälligkeiten", async ({ page }) => {
  await seedLegacy(page);
  await expect(page.locator("#dlgConfirm")).toBeVisible();
  await expect(page.locator("#cf_text")).toContainText("ohne passenden Termin");
  await page.click("#cf_ok");
  const s = await stored(page);
  expect(s.slots.filter((x: { extra?: { placeholder?: boolean } }) => !x.extra?.placeholder)).toHaveLength(3);
  expect(s.bookings).toHaveLength(4); // auch die Buchung ohne Termin
  expect(s.settings.confirmationTemplate).toBe("[Anrede] [Name], bis bald am [Datum]!");
  // Altdaten bleiben unangetastet als Rückfallebene
  expect(await page.evaluate(() => localStorage.getItem("seeyou_slots_v1"))).not.toBeNull();
  // Die verwaiste Buchung ist im Archiv unter "Unbekannter Termin" sichtbar
  await page.locator("#archSection > summary").click();
  await expect(page.getByText("Waltraud Waise")).toBeVisible();
});

test("Buchungen: Pflichtfelder, Doppelte, Kapazität, kein HTML-Einschleusen", async ({ page }) => {
  await seedLegacy(page);
  await page.click("#cf_ok");
  await page.click('[data-action="new-booking"][data-id="old1"]');
  await page.fill("#bk_name", '<img src=x onerror="window.__xss=1">Eva');
  await page.fill("#bk_phone", "0170 1111111");
  await page.fill("#bk_count", "3");
  await page.click("#formBooking button[type=submit]");
  await expect(page.locator("#cf_text")).toContainText("Anna Alt ist mit dieser Nummer bereits");
  await page.click("#cf_ok");
  await expect(page.locator("#dlgBooking")).not.toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await expect(page.getByText('<img src=x onerror="window.__xss=1">Eva')).toBeVisible();

  await page.click('[data-action="new-booking"][data-id="old1"]');
  await page.fill("#bk_name", "Zu viele");
  await page.fill("#bk_phone", "0175 5");
  await page.fill("#bk_count", "9");
  await page.click("#formBooking button[type=submit]");
  await expect(page.locator("#toast")).toContainText("nur noch 5 Plätze");
});

test("Feedback-Anfrage: Einwilligung, Link, korrekte WhatsApp-Nachrichten", async ({ page }) => {
  await seedLegacy(page);
  await page.click("#cf_ok");
  await page.click('[data-action="review"][data-id="old2"]');
  await expect(page.locator("#rv_warning")).toContainText("Noch kein Link");
  await expect(page.locator("#rv_next")).toBeDisabled(); // keine Einwilligung → nichts senden
  await page.click('#rv_warning [data-action="settings"]');
  await page.fill("#st_reviewLink", "https://g.page/r/TEST/review");
  await page.click("#formSettings button[type=submit]");
  await page.click('[data-action="review"][data-id="old2"]');
  await page.click('[data-action="rv-consent"][data-id="b2"]');
  await page.click('[data-action="rv-consent"][data-id="b3"]');
  await page.click("#rv_next");
  await page.click("#rv_next");
  await expect(page.locator("#rv_next")).toHaveText("Alle angefragt ✓");
  const opened: string[] = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
  expect(opened).toHaveLength(2);
  const [ben, clara] = opened.map((u) => decodeURIComponent(u));
  expect(ben).toMatch(/^https:\/\/wa\.me\/491712222222\?text=Lieber Ben,/);
  expect(ben).toContain("dass ich dich beim JGA");
  expect(clara).toContain("dass ich euch beim JGA"); // 3 Personen → Mehrzahl
  expect(clara).toContain("https://g.page/r/TEST/review");
  const s = await stored(page);
  expect(s.bookings.filter((b: { reviewRequestedAt: string | null }) => b.reviewRequestedAt)).toHaveLength(2);
  // Einwilligung wird mit Zeitpunkt festgehalten (Nachweis)
  expect(s.bookings.filter((b: { reviewConsentAt: string | null }) => b.reviewConsentAt)).toHaveLength(2);
});

test("WhatsApp-Bestätigung nutzt die übernommene eigene Vorlage", async ({ page }) => {
  await seedLegacy(page);
  await page.click("#cf_ok");
  await page.click('[data-action="edit-booking"][data-id="b1"]');
  await page.click("#btnWhatsappConfirm");
  const url = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened.at(-1)!);
  expect(decodeURIComponent(url)).toMatch(/^https:\/\/wa\.me\/491701111111\?text=Liebe Anna Alt, bis bald am \d\d\.\d\d\.\d\d, \d\d:\d\d!$/);
});

test("Import einer alten Sicherungsdatei legt vorher einen Wiederherstellungspunkt an – und der funktioniert", async ({ page }) => {
  await seedLegacy(page);
  await page.click("#cf_ok");
  // Datei im Format der alten App ("Backup"-Button)
  const file = tmp("seeyou_backup_2026-10-01.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      exported_at: "2026-10-01T10:00:00Z",
      slots: [{ id: "n1", title: "Kindergeburtstag", starts_at: iso(100), ends_at: iso(102), capacity: 8, archived: false }],
      bookings: [{ id: "nb1", slotId: "n1", name: "Neu", phone: "1", count: 2 }],
    }),
  );
  await page.click("#btnMenu");
  await page.click('[data-action="backup"]');
  await page.setInputFiles("#bkp_import", file);
  await expect(page.locator("#cf_text")).toContainText("enthält 1 Termine, 1 Buchungen");
  await expect(page.locator("#cf_text")).toContainText("keine Einstellungen");
  await page.click("#cf_ok");
  await expect(page.getByText("Neu (2)")).toBeVisible();
  await expect(page.getByText("Anna Alt")).toHaveCount(0);
  // Vorlage aus der alten App bleibt erhalten, da die Datei keine Einstellungen enthält
  expect((await stored(page)).settings.confirmationTemplate).toBe("[Anrede] [Name], bis bald am [Datum]!");

  // Rückweg über den automatisch angelegten Wiederherstellungspunkt
  await page.click("#btnMenu");
  await page.click('[data-action="backup"]');
  const item = page.locator("#bkp_list li", { hasText: "vor Import" });
  await expect(item).toHaveCount(1);
  await item.getByRole("button", { name: "Wiederherstellen" }).click();
  await expect(page.locator("#cf_text")).toContainText("enthält 4 Termine, 4 Buchungen") // 3 Termine + Ersatz-Termin;
  await page.click("#cf_ok");
  await expect(page.getByText("Anna Alt")).toBeVisible();
});

test("Löschen eines Termins ist über den Wiederherstellungspunkt umkehrbar", async ({ page }) => {
  await seedLegacy(page);
  await page.click("#cf_ok");
  await page.click('[data-action="delete-slot"][data-id="old1"]');
  await page.click("#cf_ok");
  await expect(page.getByText("Anna Alt")).toHaveCount(0);
  await page.click("#btnMenu");
  await page.click('[data-action="backup"]');
  await page.locator("#bkp_list li", { hasText: "vor Löschen" }).getByRole("button").click();
  await page.click("#cf_ok");
  await expect(page.getByText("Anna Alt")).toBeVisible();
});

test("beschädigte Daten werden nie überschrieben; Wiederherstellung per Datei hebt die Sperre auf", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("seeyou_state_v2", '{"schemaVersion":2,"slots":[{"id":"x"');
  });
  await page.reload();
  await expect(page.locator("#backupStatus")).toContainText("nicht lesbar");
  await page.locator("#dlgBackup [data-close]").click();
  await page.click("#btnNewSlot");
  await page.click("#formSlot button[type=submit]");
  await expect(page.locator("#toast")).toContainText("nicht gelesen werden");
  await page.locator("#dlgSlot [data-close]").first().click();
  expect(await page.evaluate(() => localStorage.getItem("seeyou_state_v2"))).toBe('{"schemaVersion":2,"slots":[{"id":"x"');
  const file = tmp("export.json");
  writeFileSync(file, JSON.stringify({ slots: LEGACY_SLOTS, bookings: LEGACY_BOOKINGS.slice(0, 3) }));
  await page.click("#btnMenu");
  await page.click('[data-action="backup"]');
  await page.setInputFiles("#bkp_import", file);
  await page.click("#cf_ok");
  await expect(page.getByText("Anna Alt")).toBeVisible();
  // Die unlesbare Fassung wurde beiseitegelegt, nicht gelöscht
  const corrupt = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("seeyou_state_corrupt_")));
  expect(corrupt).toHaveLength(1);
});

test("Export → Import ergibt denselben Datenstand", async ({ page }) => {
  await seedLegacy(page);
  await page.click("#cf_ok");
  const before = await stored(page);
  await page.click("#btnMenu");
  await page.click('[data-action="backup"]');
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#bkp_export")]);
  const p = tmp("export.json");
  await dl.saveAs(p);
  expect(dl.suggestedFilename()).toMatch(/^SeeYou-Export-\d{4}-\d{2}-\d{2}\.json$/);
  await page.setInputFiles("#bkp_import", p);
  await page.click("#cf_ok");
  const after = await stored(page);
  expect(after.slots).toEqual(before.slots);
  expect(after.bookings).toEqual(before.bookings);
  expect(after.settings).toEqual(before.settings);
});

test("Suche, Termin anlegen mit eigener Kategorie, Archiv, CSV- und Kalender-Export", async ({ page }) => {
  await seedLegacy(page);
  await page.click("#cf_ok");
  await page.click("#btnNewSlot");
  await page.selectOption("#sl_category", "Sonstiges");
  await page.fill("#sl_title_other", "Firmen-Event");
  await page.click("#formSlot button[type=submit]");
  await expect(page.getByText("Firmen-Event")).toBeVisible();
  await page.fill("#search", "clara");
  await expect(page.locator("details[data-slot]")).toHaveCount(1);
  await page.fill("#search", "");
  await page.click("#btnMenu");
  await page.click('[data-action="archive"]');
  await expect(page.locator("#archSection")).toHaveAttribute("open", "");
  await page.click("#btnMenu");
  const [csv] = await Promise.all([page.waitForEvent("download"), page.click('[data-action="csv"]')]);
  expect(csv.suggestedFilename()).toMatch(/\.csv$/);
  const [ics] = await Promise.all([page.waitForEvent("download"), page.click('[data-action="ics"][data-id="old1"]')]);
  expect(ics.suggestedFilename()).toMatch(/Schmuck-Workshop\.ics$/);
});

test("Ansicht stabil: kein Speichern in Endlosschleife", async ({ page }) => {
  await seedLegacy(page);
  await page.click("#cf_ok");
  const a = await page.evaluate(() => localStorage.getItem("seeyou_state_v2"));
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => localStorage.getItem("seeyou_state_v2"))).toBe(a);
});
