// Datenmodell, Defaults und Migration alter Datenstände.
// Alles hier ist rein (ohne DOM/Plattform) und deshalb gut testbar.

export interface Slot {
  id: string;
  title: string;
  starts_at: string; // ISO
  ends_at: string; // ISO
  capacity: number;
  archived: boolean;
  notes: string;
  /** Unbekannte Felder aus älteren/fremden Datenständen – werden unverändert mitgeführt. */
  extra?: Record<string, unknown>;
}

export interface Booking {
  id: string;
  slotId: string;
  salutation: string;
  name: string;
  phone: string;
  email: string;
  count: number;
  channel: string;
  notes: string;
  created_at: string;
  /** Kunde hat zugestimmt, nach dem Workshop um Feedback gebeten zu werden. */
  reviewConsent: boolean;
  /** Wann die Einwilligung erfasst wurde (Nachweis). */
  reviewConsentAt: string | null;
  /** Zeitpunkt, an dem die Feedback-Anfrage verschickt wurde. */
  reviewRequestedAt: string | null;
  extra?: Record<string, unknown>;
}

export interface Settings {
  confirmationTemplate: string;
  reviewTemplate: string;
  reviewEmailSubject: string;
  reviewLink: string;
  /** Feedback-Anfragen nur an Kontakte mit Einwilligung. */
  reviewRequireConsent: boolean;
  categories: string[];
  channels: string[];
}

export interface UiState {
  collapsedActive: boolean;
  collapsedArchive: boolean;
  collapsedSlots: string[];
}

export interface Meta {
  updatedAt: string | null;
  /** Wird bei jeder inhaltlichen Änderung um 1 erhöht. */
  revision: number;
  /** Revision, die zuletzt erfolgreich automatisch gesichert wurde. */
  lastBackupRevision: number | null;
  lastBackupAt: string | null;
  lastExportAt: string | null;
}

/** Einträge, die beim Import nicht als Termin/Buchung lesbar waren. Sie werden aufbewahrt, nie verworfen. */
export interface QuarantineEntry {
  kind: "slot" | "booking";
  reason: string;
  raw: unknown;
  at: string;
}

export interface AppState {
  schemaVersion: 2;
  slots: Slot[];
  bookings: Booking[];
  settings: Settings;
  ui: UiState;
  meta: Meta;
  quarantine: QuarantineEntry[];
}

export const SALUTATIONS = ["Liebe/r", "Liebe", "Lieber", "Hallo"];

export const DEFAULT_CATEGORIES = [
  "Schmuck-Workshop",
  "Kindergeburtstag",
  "JGA",
  "Mädelsabend",
  "Weihnachtsfeier",
  "Sonstiges",
];

export const DEFAULT_CHANNELS = ["Instagram", "WhatsApp", "E-Mail", "Triviar", "Telefonisch", "Persönlich"];

export const DEFAULT_CONFIRMATION_TEMPLATE = `[Anrede] [Name],

hiermit bestätige ich [Du_Dat] die Teilnahme am [Datum]
für [Anzahl] Person(en).

Ich freue mich auf [Du_Akk] und wünsche [Du_Dat] bis dahin alles Gute.

Ganz liebe Grüße
Stefanie`;

// Bewusst neutral formuliert: Google untersagt es, nur zufriedene Kunden
// zur Bewertung zu bewegen ("Review Gating").
export const DEFAULT_REVIEW_TEMPLATE = `[Anrede] [Name],

ganz herzlichen Dank, dass ich [Du_Akk] beim [Titel] am [Tag] begleiten durfte – es hat mir viel Freude gemacht!

Über eine kurze Google-Bewertung würde ich mich sehr freuen:
[Link]

Und falls [Du_Dat] sonst noch etwas auf dem Herzen liegt – Lob, Wünsche oder Ideen –, freue ich mich genauso über eine direkte Nachricht.

Ganz liebe Grüße
Stefanie`;

export const DEFAULT_REVIEW_SUBJECT = "Danke für deinen Besuch bei SeeYou";

export function defaultSettings(): Settings {
  return {
    confirmationTemplate: DEFAULT_CONFIRMATION_TEMPLATE,
    reviewTemplate: DEFAULT_REVIEW_TEMPLATE,
    reviewEmailSubject: DEFAULT_REVIEW_SUBJECT,
    reviewLink: "",
    reviewRequireConsent: true,
    categories: [...DEFAULT_CATEGORIES],
    channels: [...DEFAULT_CHANNELS],
  };
}

export function emptyState(): AppState {
  return {
    schemaVersion: 2,
    slots: [],
    bookings: [],
    settings: defaultSettings(),
    ui: { collapsedActive: false, collapsedArchive: true, collapsedSlots: [] },
    meta: { updatedAt: null, revision: 0, lastBackupRevision: null, lastBackupAt: null, lastExportAt: null },
    quarantine: [],
  };
}

export const isEmptyState = (s: AppState) => s.slots.length === 0 && s.bookings.length === 0;

export function uid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* ---------- Normalisierung / Migration ---------- */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, def = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : def);
const bool = (v: unknown, def = false): boolean =>
  typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : def;
/** ISO-String oder Zeitstempel (ms) → ISO-String; sonst null. */
const toIso = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : v;
};
const intOrNull = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.trim()) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
};
const strList = (v: unknown, def: string[]): string[] => {
  if (!Array.isArray(v)) return def;
  const list = v.map((x) => str(x).trim()).filter(Boolean);
  return list.length ? list : def;
};

const SLOT_KEYS = new Set(["id", "title", "starts_at", "ends_at", "capacity", "archived", "notes", "extra"]);
const BOOKING_KEYS = new Set([
  "id",
  "slotId",
  "salutation",
  "name",
  "phone",
  "email",
  "count",
  "channel",
  "notes",
  "created_at",
  "reviewConsent",
  "reviewConsentAt",
  "reviewRequestedAt",
  "extra",
]);

function extraFields(raw: Obj, known: Set<string>): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = isObj(raw.extra) ? { ...raw.extra } : {};
  for (const [k, v] of Object.entries(raw)) if (!known.has(k)) extra[k] = v;
  return Object.keys(extra).length ? extra : undefined;
}

export const PLACEHOLDER_NOTE =
  "Automatisch angelegt: Zu diesen Buchungen wurde beim Import kein passender Termin gefunden. Bitte prüfen und ggf. Datum/Titel ergänzen.";

export interface ImportReport {
  slotsIn: number;
  bookingsIn: number;
  slotsOut: number;
  bookingsOut: number;
  /** Nicht lesbare Einträge (aufbewahrt in state.quarantine). */
  quarantined: number;
  /** Ersatz-Termine für Buchungen ohne gültigen Termin. */
  placeholders: number;
  /** Enthielt die Quelle eigene Einstellungen (Textvorlagen usw.)? */
  hasSettings: boolean;
  /** Verständliche Hinweise zu allem, was repariert/angepasst wurde. */
  issues: string[];
}

class IssueCollector {
  private counts = new Map<string, number>();
  add(msg: string) {
    this.counts.set(msg, (this.counts.get(msg) ?? 0) + 1);
  }
  list(): string[] {
    return [...this.counts].map(([msg, n]) => (n > 1 ? `${n}× ${msg}` : msg));
  }
}

/**
 * Wandelt beliebige gespeicherte/importierte Daten in einen gültigen AppState um
 * und berichtet, was dabei angepasst wurde. Grundsatz: Es verschwindet nichts.
 *  - Unbekannte Felder bleiben in `extra` erhalten.
 *  - Ungültige Werte werden repariert, der Originalwert bleibt in `extra` erhalten.
 *  - Buchungen ohne passenden Termin bekommen einen (archivierten) Ersatz-Termin.
 *  - Völlig unlesbare Einträge landen in `quarantine` (werden mitgesichert).
 * Unterstützt:
 *  - aktuellen Stand (schemaVersion 2)
 *  - Backups der alten Web-App: { version: 1, slots, bookings }
 *  - Backups der "tempio"-Entwicklungsversion: { state: { slots, bookings } }
 *  - eigene Sicherungsdateien: { app: "seeyou-workshops", state: {...} }
 * Wirft, wenn keine Termin-/Buchungslisten erkennbar sind.
 */
export function normalizeWithReport(input: unknown, now = new Date()): { state: AppState; report: ImportReport } {
  let raw: unknown = input;
  if (isObj(raw) && isObj(raw.state) && !Array.isArray(raw.slots)) raw = raw.state;
  if (!isObj(raw) || !Array.isArray(raw.slots) || !Array.isArray(raw.bookings)) {
    throw new Error("Unbekanntes Datenformat – keine Termine/Buchungen gefunden.");
  }
  const issues = new IssueCollector();
  const nowIso = now.toISOString();
  const quarantine: QuarantineEntry[] = Array.isArray(raw.quarantine)
    ? raw.quarantine.filter(isObj).map((q) => ({
        kind: q.kind === "slot" ? "slot" : "booking",
        reason: str(q.reason, "unbekannt"),
        raw: q.raw,
        at: toIso(q.at) ?? nowIso,
      }))
    : [];
  const quarantinedBefore = quarantine.length;

  /* --- Termine --- */
  const slots: Slot[] = [];
  const slotIds = new Set<string>();
  for (const r of raw.slots) {
    if (!isObj(r)) {
      quarantine.push({ kind: "slot", reason: "Eintrag ist kein Termin-Objekt", raw: r, at: nowIso });
      issues.add("Termin-Eintrag war nicht lesbar und wurde zur Prüfung aufbewahrt");
      continue;
    }
    const extra = extraFields(r, SLOT_KEYS) ?? {};
    let id = str(r.id).trim();
    if (!id || slotIds.has(id)) {
      if (id) extra.originalId = id;
      issues.add(id ? "Termin mit doppelter ID erhielt eine neue ID" : "Termin ohne ID erhielt eine neue ID");
      id = uid();
    }
    let starts = toIso(r.starts_at);
    let title = str(r.title).trim() || "Workshop";
    if (!starts) {
      extra.originalStartsAt = r.starts_at ?? null;
      starts = new Date(0).toISOString();
      title = `${title} (Datum ungültig)`;
      issues.add("Termin ohne gültiges Datum übernommen (Titel markiert, im Archiv)");
    }
    let ends = toIso(r.ends_at);
    if (!ends || new Date(ends) < new Date(starts)) {
      if (r.ends_at !== undefined) extra.originalEndsAt = r.ends_at;
      ends = new Date(new Date(starts).getTime() + 2 * 3600_000).toISOString();
      if (r.ends_at !== undefined) issues.add("Termin mit ungültigem Ende: Ende auf Beginn + 2 Std. gesetzt");
    }
    const capRaw = intOrNull(r.capacity);
    let capacity = capRaw ?? 0;
    if (capRaw === null || capRaw < 1) {
      extra.originalCapacity = r.capacity ?? null;
      capacity = -1; // wird unten anhand der Buchungen gesetzt
      issues.add("Termin mit ungültiger Platzanzahl: auf Anzahl der Buchungen (mind. 1) gesetzt");
    }
    slotIds.add(id);
    slots.push({
      id,
      title,
      starts_at: starts,
      ends_at: ends,
      capacity,
      archived: bool(r.archived) || title.endsWith("(Datum ungültig)"),
      notes: str(r.notes),
      ...(Object.keys(extra).length ? { extra } : {}),
    });
  }

  /* --- Buchungen --- */
  const bookings: Booking[] = [];
  const bookingIds = new Set<string>();
  const orphanGroups = new Map<string, Booking[]>();
  for (const r of raw.bookings) {
    if (!isObj(r)) {
      quarantine.push({ kind: "booking", reason: "Eintrag ist kein Buchungs-Objekt", raw: r, at: nowIso });
      issues.add("Buchungs-Eintrag war nicht lesbar und wurde zur Prüfung aufbewahrt");
      continue;
    }
    const extra = extraFields(r, BOOKING_KEYS) ?? {};
    let id = str(r.id).trim();
    if (!id || bookingIds.has(id)) {
      if (id) extra.originalId = id;
      issues.add(id ? "Buchung mit doppelter ID erhielt eine neue ID" : "Buchung ohne ID erhielt eine neue ID");
      id = uid();
    }
    bookingIds.add(id);
    const countRaw = intOrNull(r.count);
    let count = countRaw ?? 1;
    if (countRaw === null || countRaw < 1) {
      extra.originalCount = r.count ?? null;
      count = 1;
      issues.add("Buchung mit ungültiger Personenzahl: auf 1 gesetzt (Originalwert gespeichert)");
    }
    const name = str(r.name).trim();
    if (!name) issues.add("Buchung ohne Namen übernommen");
    const booking: Booking = {
      id,
      slotId: str(r.slotId).trim(),
      salutation: str(r.salutation, "Liebe/r") || "Liebe/r",
      name: name || "(ohne Namen)",
      phone: str(r.phone).trim(),
      email: str(r.email).trim(),
      count,
      channel: str(r.channel),
      notes: str(r.notes),
      created_at: toIso(r.created_at) ?? new Date(0).toISOString(),
      reviewConsent: bool(r.reviewConsent),
      reviewConsentAt: bool(r.reviewConsent) ? toIso(r.reviewConsentAt) : null,
      reviewRequestedAt: toIso(r.reviewRequestedAt),
      ...(Object.keys(extra).length ? { extra } : {}),
    };
    if (!slotIds.has(booking.slotId)) {
      const key = booking.slotId || "ohne-termin";
      if (!orphanGroups.has(key)) orphanGroups.set(key, []);
      orphanGroups.get(key)!.push(booking);
    }
    bookings.push(booking);
  }

  /* --- Ersatz-Termine für Buchungen ohne Termin --- */
  for (const [key, list] of orphanGroups) {
    const id = slotIds.has(key) ? uid() : key;
    const first = list.map((b) => b.created_at).sort()[0] ?? new Date(0).toISOString();
    slots.push({
      id,
      title: "Unbekannter Termin",
      starts_at: first,
      ends_at: first,
      capacity: list.reduce((n, b) => n + b.count, 0),
      archived: true,
      notes: PLACEHOLDER_NOTE,
      extra: { placeholder: true, originalSlotId: key === "ohne-termin" ? null : key },
    });
    slotIds.add(id);
    for (const b of list) b.slotId = id;
    issues.add(`${list.length} Buchung(en) ohne passenden Termin einem Ersatz-Termin „Unbekannter Termin“ zugeordnet`);
  }

  /* --- ungültige Kapazitäten anhand der Buchungen setzen --- */
  for (const s of slots) {
    if (s.capacity === -1) {
      s.capacity = Math.max(1, bookings.filter((b) => b.slotId === s.id).reduce((n, b) => n + b.count, 0));
    }
  }

  const ui = isObj(raw.ui) ? raw.ui : {};
  const meta = isObj(raw.meta) ? raw.meta : {};
  const base = emptyState();
  const revision = intOrNull(meta.revision);
  const lastBackupRevision = intOrNull(meta.lastBackupRevision);
  const state: AppState = {
    schemaVersion: 2,
    slots,
    bookings,
    settings: normalizeSettings(raw.settings),
    ui: {
      collapsedActive: bool(ui.collapsedActive, base.ui.collapsedActive),
      collapsedArchive: bool(ui.collapsedArchive, base.ui.collapsedArchive),
      collapsedSlots: strList(ui.collapsedSlots, []).filter((id) => slotIds.has(id)),
    },
    meta: {
      updatedAt: toIso(meta.updatedAt),
      revision: revision !== null && revision >= 0 ? revision : 0,
      lastBackupRevision: lastBackupRevision !== null && lastBackupRevision >= 0 ? lastBackupRevision : null,
      lastBackupAt: toIso(meta.lastBackupAt),
      lastExportAt: toIso(meta.lastExportAt),
    },
    quarantine,
  };
  return {
    state,
    report: {
      slotsIn: raw.slots.length,
      bookingsIn: raw.bookings.length,
      slotsOut: slots.length,
      bookingsOut: bookings.length,
      quarantined: quarantine.length - quarantinedBefore,
      placeholders: orphanGroups.size,
      hasSettings: isObj(raw.settings),
      issues: issues.list(),
    },
  };
}

export const normalizeState = (input: unknown): AppState => normalizeWithReport(input).state;

function normalizeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!isObj(raw)) return d;
  const categories = strList(raw.categories, d.categories);
  if (!categories.includes("Sonstiges")) categories.push("Sonstiges");
  return {
    confirmationTemplate: str(raw.confirmationTemplate) || d.confirmationTemplate,
    reviewTemplate: str(raw.reviewTemplate) || d.reviewTemplate,
    reviewEmailSubject: str(raw.reviewEmailSubject) || d.reviewEmailSubject,
    reviewLink: str(raw.reviewLink).trim(),
    reviewRequireConsent: bool(raw.reviewRequireConsent, d.reviewRequireConsent),
    categories,
    channels: strList(raw.channels, d.channels),
  };
}

/** Liest die Schlüssel der alten Web-App (localStorage) ein. */
export function fromLegacyLocalStorage(get: (key: string) => string | null): { state: AppState; report: ImportReport } | null {
  const slotsRaw = get("seeyou_slots_v1");
  const bookingsRaw = get("seeyou_bookings_v1");
  if (!slotsRaw && !bookingsRaw) return null;
  const parse = (s: string | null, def: unknown) => {
    try {
      return s ? JSON.parse(s) : def;
    } catch {
      return def;
    }
  };
  const slots = parse(slotsRaw, null);
  const bookings = parse(bookingsRaw, null);
  // Unlesbare Altdaten nicht als "leer" behandeln – sonst würden sie überschrieben
  if ((slotsRaw && !Array.isArray(slots)) || (bookingsRaw && !Array.isArray(bookings))) {
    throw new Error("Die gespeicherten Daten der bisherigen Version sind beschädigt und wurden nicht verändert.");
  }
  const template = parse(get("seeyou_whatsapp_template_v1"), null);
  const result = normalizeWithReport({
    slots: slots ?? [],
    bookings: bookings ?? [],
    settings: typeof template === "string" && template.trim() ? { confirmationTemplate: template } : undefined,
    ui: {
      collapsedActive: parse(get("seeyou_active_collapsed_v1"), false),
      collapsedArchive: parse(get("seeyou_arch_collapsed_v1"), true),
      collapsedSlots: parse(get("seeyou_collapsed_slots_v1"), []),
    },
  });
  const lastBackupDay = get("seeyou_last_backup_v1");
  if (lastBackupDay && /^\d{4}-\d{2}-\d{2}$/.test(lastBackupDay)) {
    result.state.meta.lastExportAt = new Date(`${lastBackupDay}T12:00:00Z`).toISOString();
  }
  result.report.hasSettings = true;
  return result;
}

/* ---------- Abgeleitete Werte ---------- */

export type SlotStatus = "open" | "full" | "past" | "archived";

export const bookingsForSlot = (state: AppState, slotId: string) => state.bookings.filter((b) => b.slotId === slotId);

export const bookedCount = (state: AppState, slotId: string) =>
  bookingsForSlot(state, slotId).reduce((n, b) => n + b.count, 0);

export function slotStatus(state: AppState, slot: Slot, now = new Date()): SlotStatus {
  if (slot.archived) return "archived";
  if (new Date(slot.ends_at) < now) return "past";
  return slot.capacity - bookedCount(state, slot.id) <= 0 ? "full" : "open";
}

/** Archiviert Termine, die seit mehr als `graceDays` vorbei sind. Gibt true zurück, wenn sich etwas geändert hat. */
export function autoArchive(state: AppState, now = new Date(), graceDays = 3): boolean {
  let changed = false;
  const limit = now.getTime() - graceDays * 86_400_000;
  for (const s of state.slots) {
    if (!s.archived && new Date(s.ends_at).getTime() < limit) {
      s.archived = true;
      changed = true;
    }
  }
  return changed;
}

/** Kurzbeschreibung eines Datenstands für Bestätigungsdialoge. */
export const describeState = (s: Pick<AppState, "slots" | "bookings">) =>
  `${s.slots.length} Termine, ${s.bookings.length} Buchungen`;

export function normalizePhoneDE(raw: string): string {
  let d = (raw || "").replace(/\D+/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = "49" + d.slice(1);
  return d;
}

export const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
