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
  /** Zeitpunkt, an dem die Feedback-Anfrage verschickt wurde. */
  reviewRequestedAt: string | null;
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
  lastBackupAt: string | null;
  lastExportAt: string | null;
}

export interface AppState {
  schemaVersion: 2;
  slots: Slot[];
  bookings: Booking[];
  settings: Settings;
  ui: UiState;
  meta: Meta;
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
    meta: { updatedAt: null, lastBackupAt: null, lastExportAt: null },
  };
}

export function uid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* ---------- Normalisierung / Migration ---------- */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, def = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : def);
const bool = (v: unknown, def = false): boolean => (typeof v === "boolean" ? v : def);
const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  return Number.isNaN(new Date(v).getTime()) ? null : v;
};
const posInt = (v: unknown, def: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : def;
};
const strList = (v: unknown, def: string[]): string[] => {
  if (!Array.isArray(v)) return def;
  const list = v.map((x) => str(x).trim()).filter(Boolean);
  return list.length ? list : def;
};

function normalizeSlot(raw: unknown): Slot | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const starts = isoOrNull(raw.starts_at);
  if (!id || !starts) return null;
  const ends = isoOrNull(raw.ends_at) ?? new Date(new Date(starts).getTime() + 2 * 3600_000).toISOString();
  return {
    id,
    title: str(raw.title, "Workshop").trim() || "Workshop",
    starts_at: starts,
    ends_at: ends,
    capacity: posInt(raw.capacity, 1),
    archived: bool(raw.archived),
    notes: str(raw.notes),
  };
}

function normalizeBooking(raw: unknown): Booking | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const slotId = str(raw.slotId);
  if (!id || !slotId) return null;
  return {
    id,
    slotId,
    salutation: str(raw.salutation, "Liebe/r") || "Liebe/r",
    name: str(raw.name).trim(),
    phone: str(raw.phone).trim(),
    email: str(raw.email).trim(),
    count: posInt(raw.count, 1),
    channel: str(raw.channel),
    notes: str(raw.notes),
    created_at: isoOrNull(raw.created_at) ?? new Date(0).toISOString(),
    reviewConsent: bool(raw.reviewConsent),
    reviewRequestedAt: isoOrNull(raw.reviewRequestedAt),
  };
}

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

/**
 * Wandelt beliebige gespeicherte/importierte Daten in einen gültigen AppState um.
 * Unterstützt:
 *  - aktuellen Stand (schemaVersion 2)
 *  - Backups der alten Web-App: { version: 1, slots, bookings }
 *  - Backups der "tempio"-Entwicklungsversion: { state: { slots, bookings } }
 * Wirft, wenn keine Termin-/Buchungslisten erkennbar sind.
 */
export function normalizeState(input: unknown): AppState {
  let raw: unknown = input;
  if (isObj(raw) && isObj(raw.state) && !Array.isArray(raw.slots)) raw = raw.state;
  if (!isObj(raw) || !Array.isArray(raw.slots) || !Array.isArray(raw.bookings)) {
    throw new Error("Unbekanntes Datenformat – keine Termine/Buchungen gefunden.");
  }
  const base = emptyState();
  const slots = raw.slots.map(normalizeSlot).filter((s): s is Slot => s !== null);
  const slotIds = new Set(slots.map((s) => s.id));
  const bookings = raw.bookings
    .map(normalizeBooking)
    .filter((b): b is Booking => b !== null && slotIds.has(b.slotId));
  const ui = isObj(raw.ui) ? raw.ui : {};
  const meta = isObj(raw.meta) ? raw.meta : {};
  return {
    ...base,
    slots,
    bookings,
    settings: normalizeSettings(raw.settings),
    ui: {
      collapsedActive: bool(ui.collapsedActive, base.ui.collapsedActive),
      collapsedArchive: bool(ui.collapsedArchive, base.ui.collapsedArchive),
      collapsedSlots: strList(ui.collapsedSlots, []).filter((id) => slotIds.has(id)),
    },
    meta: {
      updatedAt: isoOrNull(meta.updatedAt),
      lastBackupAt: isoOrNull(meta.lastBackupAt),
      lastExportAt: isoOrNull(meta.lastExportAt),
    },
  };
}

/** Liest die Schlüssel der alten Web-App (localStorage) ein. */
export function fromLegacyLocalStorage(get: (key: string) => string | null): AppState | null {
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
  const state = normalizeState({
    slots: parse(slotsRaw, []),
    bookings: parse(bookingsRaw, []),
    ui: {
      collapsedActive: parse(get("seeyou_active_collapsed_v1"), false),
      collapsedArchive: parse(get("seeyou_arch_collapsed_v1"), true),
      collapsedSlots: parse(get("seeyou_collapsed_slots_v1"), []),
    },
  });
  const template = parse(get("seeyou_whatsapp_template_v1"), null);
  if (typeof template === "string" && template.trim()) state.settings.confirmationTemplate = template;
  return state;
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

export function normalizePhoneDE(raw: string): string {
  let d = (raw || "").replace(/\D+/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = "49" + d.slice(1);
  return d;
}

export const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
