import type { AppState, Booking, Slot } from "./model";

/* ---------- HTML-Escaping ---------- */

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/* ---------- Datum ---------- */

const dtFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" });
const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
const dateOnlyFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });

export const fmtDateTime = (iso: string) => dtFmt.format(new Date(iso));
export const fmtDate = (iso: string) => dateOnlyFmt.format(new Date(iso));
export const fmtTime = (iso: string) => timeFmt.format(new Date(iso));

export function fmtRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const sameDay = s.toDateString() === e.toDateString();
  return sameDay
    ? `${dayFmt.format(s)}, ${timeFmt.format(s)} – ${timeFmt.format(e)} Uhr`
    : `${dayFmt.format(s)}, ${timeFmt.format(s)} – ${dayFmt.format(e)}, ${timeFmt.format(e)} Uhr`;
}

/** Wert für <input type="datetime-local"> in lokaler Zeit. */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function dateStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- Textvorlagen ---------- */

export const TEMPLATE_PLACEHOLDERS =
  "[Anrede], [Name], [Titel], [Datum] (Datum + Uhrzeit), [Tag] (nur Datum), [Uhrzeit], [Anzahl], [Du_Nom] (ihr/du), [Du_Akk] (euch/dich), [Du_Dat] (euch/dir), [Link] (Bewertungslink)";

type TemplateBooking = Pick<Booking, "salutation" | "name" | "count">;

export function fillTemplate(tpl: string, booking: TemplateBooking, slot: Slot, link = ""): string {
  const plural = booking.count > 1;
  const values: Record<string, string> = {
    Anrede: booking.salutation || "Liebe/r",
    Name: booking.name,
    Titel: slot.title,
    Datum: fmtDateTime(slot.starts_at),
    Tag: fmtDate(slot.starts_at),
    Uhrzeit: fmtTime(slot.starts_at),
    Anzahl: String(booking.count),
    Du_Nom: plural ? "ihr" : "du",
    Du_Akk: plural ? "euch" : "dich",
    Du_Dat: plural ? "euch" : "dir",
    Link: link,
  };
  return tpl.replace(/\[(\w+)\]/g, (m, key: string) => (key in values ? values[key] : m)).replace(/\n{3,}/g, "\n\n");
}

/* ---------- Links ---------- */

export function whatsappUrl(phoneE164Digits: string, text: string): string {
  return `https://wa.me/${phoneE164Digits}?text=${encodeURIComponent(text)}`;
}

export function mailtoUrl(opts: { to?: string[]; bcc?: string[]; subject: string; body: string }): string {
  const params: string[] = [];
  if (opts.bcc?.length) params.push(`bcc=${opts.bcc.map(encodeURIComponent).join(",")}`);
  params.push(`subject=${encodeURIComponent(opts.subject)}`);
  // RFC 6068: Zeilenumbrüche als CRLF
  params.push(`body=${encodeURIComponent(opts.body.replace(/\r?\n/g, "\r\n"))}`);
  return `mailto:${(opts.to ?? []).map(encodeURIComponent).join(",")}?${params.join("&")}`;
}

/* ---------- CSV ---------- */

const csvCell = (v: unknown) => {
  let s = String(v ?? "");
  // Schutz vor Formel-Injection in Excel/Numbers
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};

export function buildCsv(state: AppState): string {
  const header = [
    "Termin",
    "Beginn",
    "Ende",
    "Kapazität",
    "Archiviert",
    "Anrede",
    "Name",
    "Telefon",
    "E-Mail",
    "Personen",
    "Kanal",
    "Notiz",
    "Feedback-Einwilligung",
    "Feedback angefragt",
    "Gebucht am",
  ];
  const rows: unknown[][] = [];
  const slots = [...state.slots].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  for (const s of slots) {
    const base = [s.title, fmtDateTime(s.starts_at), fmtDateTime(s.ends_at), s.capacity, s.archived ? "ja" : "nein"];
    const list = state.bookings.filter((b) => b.slotId === s.id);
    if (!list.length) rows.push([...base, "", "", "", "", "", "", "", "", ""]);
    for (const b of list) {
      rows.push([
        ...base,
        b.salutation,
        b.name,
        b.phone,
        b.email,
        b.count,
        b.channel,
        b.notes,
        b.reviewConsent ? (b.reviewConsentAt ? `ja (${fmtDateTime(b.reviewConsentAt)})` : "ja") : "nein",
        b.reviewRequestedAt ? fmtDateTime(b.reviewRequestedAt) : "",
        b.created_at && !b.created_at.startsWith("1970") ? fmtDateTime(b.created_at) : "",
      ]);
    }
  }
  // BOM, damit Excel Umlaute korrekt erkennt; Semikolon für deutsche Excel-Versionen
  return "\uFEFF" + [header, ...rows].map((r) => r.map(csvCell).join(";")).join("\r\n") + "\r\n";
}

/* ---------- ICS ---------- */

const icsDate = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

export function buildIcs(slot: Slot, bookings: Booking[], now = new Date()): string {
  const participants = bookings.map((b) => `${b.name} (${b.count})`).join(", ");
  const booked = bookings.reduce((n, b) => n + b.count, 0);
  const description = `Belegt: ${booked}/${slot.capacity}${participants ? `\nTeilnehmer: ${participants}` : ""}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SeeYou Workshops//DE",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${slot.id}@seeyou-workshops`,
    `DTSTAMP:${icsDate(now.toISOString())}`,
    `DTSTART:${icsDate(slot.starts_at)}`,
    `DTEND:${icsDate(slot.ends_at)}`,
    `SUMMARY:${icsText(slot.title)}`,
    `DESCRIPTION:${icsText(description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

export const safeFileName = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 60) || "termin";
