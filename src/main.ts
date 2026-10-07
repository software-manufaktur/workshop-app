import "./style.css";
import { App } from "@capacitor/app";
import {
  SALUTATIONS,
  autoArchive,
  bookedCount,
  bookingsForSlot,
  defaultSettings,
  isValidEmail,
  normalizePhoneDE,
  slotStatus,
  uid,
  type AppState,
  type Booking,
  type Slot,
  type SlotStatus,
} from "./model";
import {
  TEMPLATE_PLACEHOLDERS,
  buildCsv,
  buildIcs,
  dateStamp,
  esc,
  fillTemplate,
  fmtDateTime,
  fmtRange,
  mailtoUrl,
  safeFileName,
  toLocalInput,
  whatsappUrl,
} from "./format";
import { isNative, openExternal, requestPersistentStorage, shareFile } from "./platform";
import {
  backupJson,
  flushBackup,
  getBackupStatus,
  getState,
  initStore,
  listBackups,
  onBackupStatus,
  parseBackup,
  readBackup,
  replaceState,
  runBackup,
  subscribe,
  update,
} from "./store";

const APP_VERSION = __APP_VERSION__;

/* ---------- DOM-Helfer ---------- */

function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Element fehlt: ${sel}`);
  return el;
}
const input = (sel: string) => $<HTMLInputElement>(sel);
const select = (sel: string) => $<HTMLSelectElement>(sel);
const textarea = (sel: string) => $<HTMLTextAreaElement>(sel);

const listEl = $("#list");
const dlgSlot = $<HTMLDialogElement>("#dlgSlot");
const dlgBooking = $<HTMLDialogElement>("#dlgBooking");
const dlgReview = $<HTMLDialogElement>("#dlgReview");
const dlgBackup = $<HTMLDialogElement>("#dlgBackup");
const dlgSettings = $<HTMLDialogElement>("#dlgSettings");
const dlgConfirm = $<HTMLDialogElement>("#dlgConfirm");

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string, type: "info" | "success" | "error" = "info") {
  const el = $("#toast");
  el.textContent = msg;
  el.dataset.type = type;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), type === "error" ? 6000 : 3500);
}

function confirmDialog(title: string, text: string, okLabel = "OK", danger = true): Promise<boolean> {
  $("#cf_title").textContent = title;
  $("#cf_text").textContent = text;
  const ok = $<HTMLButtonElement>("#cf_ok");
  ok.textContent = okLabel;
  ok.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
  dlgConfirm.showModal();
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      ok.onclick = null;
      $("#cf_cancel").onclick = null;
      dlgConfirm.onclose = null;
      if (dlgConfirm.open) dlgConfirm.close();
      resolve(v);
    };
    ok.onclick = () => done(true);
    $("#cf_cancel").onclick = () => done(false);
    dlgConfirm.onclose = () => done(false);
  });
}

async function safely(action: () => Promise<void> | void, errorPrefix = "Fehler") {
  try {
    await action();
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    console.error(err);
    toast(`${errorPrefix}: ${(err as Error).message}`, "error");
  }
}

function relTime(iso: string | null): string {
  if (!iso) return "noch nie";
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  return d === 1 ? "gestern" : `vor ${d} Tagen`;
}

const options = (list: string[], selected = "") =>
  list.map((v) => `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(v || "–")}</option>`).join("");

/* ---------- Rendering ---------- */

const STATUS_BADGE: Record<SlotStatus, (left: number) => string> = {
  archived: () => `<span class="badge bg-slate-300">Archiv</span>`,
  past: () => `<span class="badge bg-gray-300">vorbei</span>`,
  full: () => `<span class="badge bg-rose-200">voll</span>`,
  open: (left) => `<span class="badge ${left <= 2 ? "bg-amber-200" : "bg-emerald-200"}">${left} frei</span>`,
};
const BAR_COLOR: Record<SlotStatus, string> = {
  archived: "bg-slate-300",
  past: "bg-gray-300",
  full: "bg-rose-400",
  open: "bg-emerald-500",
};

function matchesSearch(state: AppState, slot: Slot, q: string): boolean {
  if (!q) return true;
  const hay = [slot.title, fmtRange(slot.starts_at, slot.ends_at), slot.notes];
  for (const b of bookingsForSlot(state, slot.id)) hay.push(b.name, b.phone, b.email, b.notes);
  return hay.join(" ").toLowerCase().includes(q);
}

function renderBookings(state: AppState, slot: Slot): string {
  const list = bookingsForSlot(state, slot.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (!list.length) return `<p class="text-xs text-slate-500 mt-3">Noch keine Buchungen.</p>`;
  const items = list
    .map(
      (b) => `
      <li>
        <button type="button" data-action="edit-booking" data-id="${esc(b.id)}"
          class="w-full flex items-center justify-between gap-2 text-left bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 hover:bg-gray-100">
          <span class="min-w-0">
            <span class="font-medium">${esc(b.name)}</span> <span class="text-slate-500">(${b.count})</span>
            <span class="block text-xs text-slate-500 truncate">${esc(b.phone)}${b.email ? ` · ${esc(b.email)}` : ""}${b.notes ? ` · ${esc(b.notes)}` : ""}</span>
          </span>
          <span class="shrink-0 text-xs text-slate-400">${b.reviewRequestedAt ? "⭐ angefragt" : b.channel ? esc(b.channel) : ""} ›</span>
        </button>
      </li>`,
    )
    .join("");
  return `<ul class="mt-3 space-y-1.5 text-sm">${items}</ul>`;
}

function renderCard(state: AppState, slot: Slot, now: Date): string {
  const booked = bookedCount(state, slot.id);
  const left = Math.max(0, slot.capacity - booked);
  const status = slotStatus(state, slot, now);
  const bar = Math.min(100, Math.round((100 * booked) / Math.max(1, slot.capacity)));
  const barColor = status === "open" && left <= 2 ? "bg-amber-400" : BAR_COLOR[status];
  const ended = new Date(slot.ends_at) < now;
  const bookings = bookingsForSlot(state, slot.id);
  const pendingReview = bookings.filter((b) => !b.reviewRequestedAt).length;
  const collapsed = state.ui.collapsedSlots.includes(slot.id);

  const actions = [
    !ended && !slot.archived
      ? `<button type="button" class="btn btn-sm btn-primary" data-action="new-booking" data-id="${esc(slot.id)}">+ Buchung</button>`
      : "",
    ended && bookings.length
      ? `<button type="button" class="btn btn-sm ${pendingReview ? "btn-primary" : "btn-soft"}" data-action="review" data-id="${esc(slot.id)}">⭐ Feedback anfragen${pendingReview ? ` (${pendingReview})` : ""}</button>`
      : "",
    `<button type="button" class="btn btn-sm btn-soft" data-action="edit-slot" data-id="${esc(slot.id)}">Bearbeiten</button>`,
    `<button type="button" class="btn btn-sm btn-soft" data-action="ics" data-id="${esc(slot.id)}">Kalender</button>`,
    `<button type="button" class="btn btn-sm btn-soft" data-action="toggle-archive" data-id="${esc(slot.id)}">${slot.archived ? "Reaktivieren" : "Archivieren"}</button>`,
    `<button type="button" class="btn btn-sm btn-danger" data-action="delete-slot" data-id="${esc(slot.id)}">Löschen</button>`,
  ].join("");

  return `
  <details class="rounded-2xl bg-white/85 backdrop-blur border border-gray-200 shadow-sm" data-slot="${esc(slot.id)}" ${collapsed ? "" : "open"}>
    <summary class="list-none cursor-pointer p-4 flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div>${STATUS_BADGE[status](left)}</div>
        <div class="mt-1 font-semibold text-lg leading-snug text-brand break-words">${esc(slot.title)}</div>
        <div class="text-sm">${esc(fmtRange(slot.starts_at, slot.ends_at))}</div>
      </div>
      <span class="chevron text-2xl text-slate-400 transition-transform">›</span>
    </summary>
    <div class="px-4 pb-4">
      <div class="text-sm">Plätze: ${slot.capacity} · Gebucht: ${booked} · Frei: ${left}</div>
      <div class="h-2 mt-2 bg-gray-100 rounded-full overflow-hidden"><div class="h-2 ${barColor}" style="width:${bar}%"></div></div>
      ${slot.notes ? `<p class="mt-2 text-sm text-slate-600 whitespace-pre-line">${esc(slot.notes)}</p>` : ""}
      ${renderBookings(state, slot)}
      <div class="mt-4 flex flex-wrap gap-2">${actions}</div>
    </div>
  </details>`;
}

function renderSection(id: string, title: string, cards: string[], collapsed: boolean, empty: string): string {
  return `
  <details id="${id}" class="mb-6" ${collapsed ? "" : "open"}>
    <summary class="list-none cursor-pointer select-none rounded-xl px-3 py-2.5 bg-slate-200/70 hover:bg-slate-300/70 flex items-center justify-between shadow-sm">
      <span class="font-medium">${title} (${cards.length})</span>
      <span class="chevron text-slate-500 transition-transform">›</span>
    </summary>
    <div class="mt-3 space-y-3">${cards.length ? cards.join("") : `<div class="text-slate-600 bg-white/80 p-4 rounded-2xl">${empty}</div>`}</div>
  </details>`;
}

let onboardingHtml = "";

function render() {
  const state = getState();
  const now = new Date();
  const q = input("#search").value.toLowerCase().trim();
  const filter = select("#filterStatus").value;
  const visible = state.slots.filter(
    (s) => matchesSearch(state, s, q) && (!filter || slotStatus(state, s, now) === filter),
  );
  const active = visible.filter((s) => !s.archived).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const archived = visible.filter((s) => s.archived).sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  const emptyHint = q || filter ? "Keine Treffer." : "Noch keine Termine – oben auf „+ Termin“ tippen.";

  listEl.innerHTML =
    (state.slots.length ? "" : onboardingHtml) +
    renderSection(
      "activeSection",
      "Aktuell",
      active.map((s) => renderCard(state, s, now)),
      state.ui.collapsedActive,
      emptyHint,
    ) +
    (archived.length
      ? renderSection(
          "archSection",
          "Archiv",
          archived.map((s) => renderCard(state, s, now)),
          state.ui.collapsedArchive && !q && filter !== "archived",
          "",
        )
      : "");
  renderBackupStatus();
}

function renderBackupStatus() {
  const el = $("#backupStatus");
  const state = getState();
  if (isNative) {
    const st = getBackupStatus();
    const at = st.at ?? state.meta.lastBackupAt;
    if (!st.ok) {
      el.className = "mb-2 text-sm rounded-xl px-3 py-2 bg-rose-100 text-rose-900 flex items-center justify-between gap-2";
      el.innerHTML = `<span>⚠️ Sicherung fehlgeschlagen: ${esc(st.error ?? "")}</span><button type="button" class="btn btn-sm btn-soft" data-action="backup">Details</button>`;
    } else {
      const where = st.location === "local" ? "auf dem iPhone (iCloud nicht verfügbar)" : "in iCloud";
      el.className = "mb-2 text-xs text-slate-500 px-1";
      el.textContent = at ? `☁️ Automatisch ${where} gesichert · ${relTime(at)}` : "☁️ Automatische iCloud-Sicherung aktiv";
    }
    el.classList.remove("hidden");
    return;
  }
  // Web: Erinnerung, wenn es ungesicherte Änderungen gibt und die letzte Sicherung > 7 Tage her ist
  const { updatedAt, lastExportAt } = state.meta;
  const stale =
    state.slots.length > 0 &&
    updatedAt &&
    (!lastExportAt ||
      (updatedAt > lastExportAt && Date.now() - new Date(lastExportAt).getTime() > 7 * 86_400_000));
  if (stale) {
    el.className = "mb-2 text-sm rounded-xl px-3 py-2 bg-amber-100 text-amber-900 flex items-center justify-between gap-2";
    el.innerHTML = `<span>💡 Letzte Sicherung: ${esc(relTime(lastExportAt))}</span><button type="button" class="btn btn-sm btn-primary" data-action="export">Jetzt sichern</button>`;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

/* ---------- Termine ---------- */

let editingSlotId: string | null = null;

function fillCategorySelect(selected: string) {
  const cats = getState().settings.categories;
  const known = cats.includes(selected);
  select("#sl_category").innerHTML = options(cats, known ? selected : "Sonstiges");
  $("#row_title_other").classList.toggle("hidden", known);
  input("#sl_title_other").value = known ? "" : selected;
}

function openSlotDialog(slot?: Slot) {
  editingSlotId = slot?.id ?? null;
  $("#dlgSlotTitle").textContent = slot ? "Termin bearbeiten" : "Neuer Termin";
  if (slot) {
    fillCategorySelect(slot.title);
    input("#sl_starts").value = toLocalInput(new Date(slot.starts_at));
    input("#sl_ends").value = toLocalInput(new Date(slot.ends_at));
    input("#sl_capacity").value = String(slot.capacity);
    textarea("#sl_notes").value = slot.notes;
  } else {
    fillCategorySelect(getState().settings.categories[0]);
    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(17, 0, 0, 0);
    input("#sl_starts").value = toLocalInput(start);
    input("#sl_ends").value = toLocalInput(new Date(start.getTime() + 2 * 3600_000));
    input("#sl_capacity").value = "10";
    textarea("#sl_notes").value = "";
  }
  dlgSlot.showModal();
}

select("#sl_category").addEventListener("change", (e) => {
  const other = (e.target as HTMLSelectElement).value === "Sonstiges";
  $("#row_title_other").classList.toggle("hidden", !other);
  if (other) input("#sl_title_other").focus();
});

input("#sl_starts").addEventListener("change", () => {
  const s = input("#sl_starts").value;
  const e = input("#sl_ends");
  if (!s) return;
  const start = new Date(s);
  const end = new Date(e.value);
  if (!e.value || end <= start) e.value = toLocalInput(new Date(start.getTime() + 2 * 3600_000));
});

$("#formSlot").addEventListener("submit", (ev) => {
  ev.preventDefault();
  void safely(async () => {
    const cat = select("#sl_category").value;
    const title = cat === "Sonstiges" ? input("#sl_title_other").value.trim() || "Workshop" : cat;
    const starts = new Date(input("#sl_starts").value);
    const ends = new Date(input("#sl_ends").value);
    const capacity = Math.floor(Number(input("#sl_capacity").value));
    if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) return toast("Bitte Beginn und Ende angeben.", "error");
    if (ends <= starts) return toast("Das Ende muss nach dem Beginn liegen.", "error");
    if (!(capacity >= 1)) return toast("Bitte mindestens 1 Platz angeben.", "error");
    if (editingSlotId) {
      const booked = bookedCount(getState(), editingSlotId);
      if (capacity < booked && !(await confirmDialog("Weniger Plätze als Buchungen", `Es sind bereits ${booked} Plätze gebucht. Trotzdem auf ${capacity} reduzieren?`, "Trotzdem speichern", false))) return;
    }
    const data = {
      title,
      starts_at: starts.toISOString(),
      ends_at: ends.toISOString(),
      capacity,
      notes: textarea("#sl_notes").value.trim(),
    };
    const id = editingSlotId;
    await update((d) => {
      if (id) {
        const s = d.slots.find((x) => x.id === id);
        if (s) {
          Object.assign(s, data);
          if (s.archived && ends > new Date()) s.archived = false;
        }
      } else {
        d.slots.push({ id: uid(), archived: false, ...data });
      }
    });
    dlgSlot.close();
    toast(id ? "Termin aktualisiert" : "Termin angelegt", "success");
  }, "Speichern fehlgeschlagen");
});

async function deleteSlot(slot: Slot) {
  const n = bookingsForSlot(getState(), slot.id).length;
  const ok = await confirmDialog(
    "Termin löschen?",
    `„${slot.title}“ am ${fmtDateTime(slot.starts_at)}${n ? ` und ${n} Buchung(en)` : ""} endgültig löschen?`,
    "Endgültig löschen",
  );
  if (!ok) return;
  await update((d) => {
    d.slots = d.slots.filter((s) => s.id !== slot.id);
    d.bookings = d.bookings.filter((b) => b.slotId !== slot.id);
    d.ui.collapsedSlots = d.ui.collapsedSlots.filter((id) => id !== slot.id);
  });
  toast("Termin gelöscht", "success");
}

async function exportIcs(slot: Slot) {
  const ics = buildIcs(slot, bookingsForSlot(getState(), slot.id));
  await shareFile(`${dateStamp(new Date(slot.starts_at))}_${safeFileName(slot.title)}.ics`, ics, "text/calendar");
}

/* ---------- Buchungen ---------- */

let bookingCtx: { slotId: string; bookingId: string | null } = { slotId: "", bookingId: null };

function openBookingDialog(slotId: string, booking?: Booking) {
  const state = getState();
  const slot = state.slots.find((s) => s.id === slotId);
  if (!slot) return;
  bookingCtx = { slotId, bookingId: booking?.id ?? null };
  $("#dlgBookingTitle").textContent = booking ? "Buchung bearbeiten" : "Neue Buchung";
  $("#bk_slotInfo").textContent = `${slot.title} · ${fmtRange(slot.starts_at, slot.ends_at)}`;
  select("#bk_salutation").innerHTML = options(SALUTATIONS, booking?.salutation ?? "Liebe/r");
  const channels = ["", ...state.settings.channels];
  if (booking?.channel && !channels.includes(booking.channel)) channels.push(booking.channel);
  select("#bk_channel").innerHTML = options(channels, booking?.channel ?? "");
  input("#bk_name").value = booking?.name ?? "";
  input("#bk_phone").value = booking?.phone ?? "";
  input("#bk_email").value = booking?.email ?? "";
  input("#bk_count").value = String(booking?.count ?? 1);
  textarea("#bk_notes").value = booking?.notes ?? "";
  input("#bk_consent").checked = booking?.reviewConsent ?? false;
  $("#btnDeleteBooking").classList.toggle("hidden", !booking);
  $("#btnWhatsappConfirm").classList.toggle("hidden", !booking);
  dlgBooking.showModal();
}

$("#formBooking").addEventListener("submit", (ev) => {
  ev.preventDefault();
  void safely(async () => {
    const state = getState();
    const slot = state.slots.find((s) => s.id === bookingCtx.slotId);
    if (!slot) return dlgBooking.close();
    const old = bookingCtx.bookingId ? state.bookings.find((b) => b.id === bookingCtx.bookingId) : undefined;
    const booking: Booking = {
      id: old?.id ?? uid(),
      slotId: slot.id,
      salutation: select("#bk_salutation").value,
      name: input("#bk_name").value.trim(),
      phone: input("#bk_phone").value.trim(),
      email: input("#bk_email").value.trim(),
      count: Math.floor(Number(input("#bk_count").value)),
      channel: select("#bk_channel").value,
      notes: textarea("#bk_notes").value.trim(),
      created_at: old?.created_at ?? new Date().toISOString(),
      reviewConsent: input("#bk_consent").checked,
      reviewRequestedAt: old?.reviewRequestedAt ?? null,
    };
    if (!booking.name || !booking.phone || !(booking.count >= 1)) return toast("Bitte Name, Telefon und Personenzahl angeben.", "error");
    if (booking.email && !isValidEmail(booking.email)) return toast("Die E-Mail-Adresse sieht nicht gültig aus.", "error");
    const left = slot.capacity - (bookedCount(state, slot.id) - (old?.count ?? 0));
    if (booking.count > left) return toast(left > 0 ? `Es sind nur noch ${left} Plätze frei.` : "Der Termin ist ausgebucht.", "error");
    const phone = normalizePhoneDE(booking.phone);
    const dup = bookingsForSlot(state, slot.id).find((b) => b.id !== booking.id && normalizePhoneDE(b.phone) === phone);
    if (dup && !(await confirmDialog("Doppelte Telefonnummer", `${dup.name} ist mit dieser Nummer bereits für diesen Termin gebucht. Trotzdem speichern?`, "Trotzdem speichern", false))) return;
    await update((d) => {
      const i = d.bookings.findIndex((b) => b.id === booking.id);
      if (i >= 0) d.bookings[i] = booking;
      else d.bookings.push(booking);
    });
    dlgBooking.close();
    toast("Buchung gespeichert", "success");
  }, "Speichern fehlgeschlagen");
});

$("#btnDeleteBooking").addEventListener("click", () =>
  safely(async () => {
    const b = getState().bookings.find((x) => x.id === bookingCtx.bookingId);
    if (!b) return;
    if (!(await confirmDialog("Buchung löschen?", `Buchung von ${b.name} wirklich löschen?`, "Löschen"))) return;
    await update((d) => {
      d.bookings = d.bookings.filter((x) => x.id !== b.id);
    });
    dlgBooking.close();
    toast("Buchung gelöscht", "success");
  }),
);

$("#btnWhatsappConfirm").addEventListener("click", () =>
  safely(async () => {
    const state = getState();
    const b = state.bookings.find((x) => x.id === bookingCtx.bookingId);
    const slot = state.slots.find((s) => s.id === b?.slotId);
    if (!b || !slot) return;
    await openExternal(whatsappUrl(normalizePhoneDE(b.phone), fillTemplate(state.settings.confirmationTemplate, b, slot)));
  }),
);

/* ---------- Feedback anfragen ---------- */

let reviewSlotId = "";

function reviewMessage(state: AppState, b: Pick<Booking, "salutation" | "name" | "count">, slot: Slot) {
  return fillTemplate(state.settings.reviewTemplate, b, slot, state.settings.reviewLink);
}

const canAsk = (state: AppState, b: Booking) => b.reviewConsent || !state.settings.reviewRequireConsent;

function renderReview() {
  const state = getState();
  const slot = state.slots.find((s) => s.id === reviewSlotId);
  if (!slot) return dlgReview.close();
  $("#rv_slotInfo").textContent = `${slot.title} · ${fmtRange(slot.starts_at, slot.ends_at)}`;
  const warn = $("#rv_warning");
  warn.classList.toggle("hidden", !!state.settings.reviewLink);
  warn.innerHTML = state.settings.reviewLink
    ? ""
    : `Noch kein Link zur Google-Bewertung hinterlegt. <button type="button" class="underline font-medium" data-action="settings">Jetzt in den Einstellungen eintragen</button>`;

  const list = bookingsForSlot(state, slot.id);
  $("#rv_list").innerHTML = list
    .map((b) => {
      const allowed = canAsk(state, b);
      const done = b.reviewRequestedAt ? `<span class="badge bg-emerald-100 text-emerald-800">✓ angefragt ${esc(relTime(b.reviewRequestedAt))}</span>` : "";
      const buttons = allowed
        ? `<button type="button" class="btn btn-sm btn-whatsapp" data-action="rv-wa" data-id="${esc(b.id)}">WhatsApp</button>
           ${b.email ? `<button type="button" class="btn btn-sm btn-soft" data-action="rv-mail" data-id="${esc(b.id)}">E-Mail</button>` : ""}`
        : `<button type="button" class="btn btn-sm btn-soft" data-action="rv-consent" data-id="${esc(b.id)}" title="Nur antippen, wenn die Einwilligung wirklich vorliegt">Einwilligung liegt vor</button>`;
      return `
      <li class="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 ${allowed ? "" : "opacity-70"}">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="font-medium">${esc(b.name)} <span class="text-slate-500 font-normal">(${b.count})</span></div>
            <div class="text-xs text-slate-500">${allowed ? "" : "keine Einwilligung · "}${esc(b.phone)}${b.email ? ` · ${esc(b.email)}` : ""}</div>
            ${done}
          </div>
          <div class="flex gap-2">${buttons}</div>
        </div>
      </li>`;
    })
    .join("");

  const pendingWa = list.filter((b) => canAsk(state, b) && !b.reviewRequestedAt && normalizePhoneDE(b.phone));
  const pendingMail = list.filter((b) => canAsk(state, b) && !b.reviewRequestedAt && b.email);
  const next = $<HTMLButtonElement>("#rv_next");
  next.disabled = !pendingWa.length;
  next.textContent = pendingWa.length ? `Nächste Person per WhatsApp (${pendingWa.length} offen)` : "Alle angefragt ✓";
  const bcc = $<HTMLButtonElement>("#rv_bccAll");
  bcc.disabled = !pendingMail.length;
  bcc.textContent = `Alle offenen mit E-Mail auf einmal (${pendingMail.length})`;
}

function openReview(slotId: string) {
  reviewSlotId = slotId;
  renderReview();
  dlgReview.showModal();
}

async function markRequested(ids: string[]) {
  const at = new Date().toISOString();
  await update((d) => {
    for (const b of d.bookings) if (ids.includes(b.id)) b.reviewRequestedAt = at;
  });
}

async function reviewViaWhatsapp(bookingId: string) {
  const state = getState();
  const b = state.bookings.find((x) => x.id === bookingId);
  const slot = state.slots.find((s) => s.id === b?.slotId);
  if (!b || !slot) return;
  const phone = normalizePhoneDE(b.phone);
  if (!phone) return toast("Keine gültige Telefonnummer.", "error");
  await openExternal(whatsappUrl(phone, reviewMessage(state, b, slot)));
  await markRequested([b.id]);
}

async function reviewViaMail(bookingId: string) {
  const state = getState();
  const b = state.bookings.find((x) => x.id === bookingId);
  const slot = state.slots.find((s) => s.id === b?.slotId);
  if (!b || !slot || !b.email) return;
  await openExternal(mailtoUrl({ to: [b.email], subject: state.settings.reviewEmailSubject, body: reviewMessage(state, b, slot) }));
  await markRequested([b.id]);
}

$("#rv_next").addEventListener("click", () =>
  safely(async () => {
    const state = getState();
    const next = bookingsForSlot(state, reviewSlotId).find((b) => canAsk(state, b) && !b.reviewRequestedAt && normalizePhoneDE(b.phone));
    if (next) await reviewViaWhatsapp(next.id);
  }),
);

$("#rv_bccAll").addEventListener("click", () =>
  safely(async () => {
    const state = getState();
    const slot = state.slots.find((s) => s.id === reviewSlotId);
    if (!slot) return;
    const targets = bookingsForSlot(state, slot.id).filter((b) => canAsk(state, b) && !b.reviewRequestedAt && b.email);
    if (!targets.length) return;
    // Sammel-Mail: neutrale Anrede im Plural, Empfänger nur in BCC (Datenschutz)
    const body = reviewMessage(state, { salutation: "Hallo", name: "ihr Lieben", count: 2 }, slot);
    await openExternal(mailtoUrl({ bcc: targets.map((b) => b.email), subject: state.settings.reviewEmailSubject, body }));
    await markRequested(targets.map((b) => b.id));
  }),
);

dlgReview.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!btn) return;
  const id = btn.dataset.id ?? "";
  if (btn.dataset.action === "rv-wa") void safely(() => reviewViaWhatsapp(id));
  if (btn.dataset.action === "rv-mail") void safely(() => reviewViaMail(id));
  if (btn.dataset.action === "rv-consent")
    void safely(() =>
      update((d) => {
        const b = d.bookings.find((x) => x.id === id);
        if (b) b.reviewConsent = true;
      }),
    );
});

/* ---------- Sicherung ---------- */

async function exportBackupFile() {
  await shareFile(`SeeYou-Sicherung-${dateStamp()}.json`, backupJson(), "application/json");
  await update((d) => (d.meta.lastExportAt = new Date().toISOString()), { silent: true });
  toast("Sicherung exportiert", "success");
}

async function restoreFrom(next: AppState, source: string) {
  const cur = getState();
  const ok = await confirmDialog(
    "Sicherung wiederherstellen?",
    `${source}\nenthält ${next.slots.length} Termine und ${next.bookings.length} Buchungen.\n\nDie aktuellen Daten (${cur.slots.length} Termine, ${cur.bookings.length} Buchungen) werden ersetzt.`,
    "Wiederherstellen",
  );
  if (!ok) return false;
  if (isNative && cur.slots.length) await runBackup(); // aktuellen Stand vorher noch sichern
  await replaceState(next);
  toast("Sicherung wiederhergestellt", "success");
  return true;
}

async function renderBackupDialog() {
  $("#bkp_native").classList.toggle("hidden", !isNative);
  $("#bkp_web").classList.toggle("hidden", isNative);
  const state = getState();
  if (!isNative) {
    $("#bkp_webLast").textContent = `Letzter Export: ${relTime(state.meta.lastExportAt)}`;
    return;
  }
  const st = getBackupStatus();
  $("#bkp_state").textContent = st.ok
    ? `Letzte Sicherung: ${relTime(st.at ?? state.meta.lastBackupAt)}${st.location === "local" ? " – nur auf dem iPhone, weil iCloud Drive nicht verfügbar ist (Einstellungen → Apple-ID → iCloud → iCloud Drive)." : ""}`
    : `Letzter Versuch fehlgeschlagen: ${st.error ?? "unbekannt"}`;
  const ul = $("#bkp_list");
  ul.innerHTML = `<li class="py-2 text-sm text-slate-500">Lade …</li>`;
  try {
    const files = await listBackups();
    ul.innerHTML = files.length
      ? files
          .map(
            (f) => `<li class="flex items-center justify-between gap-2 py-2 text-sm">
              <span class="min-w-0 truncate">${esc(f.name.replace("SeeYou-Sicherung-", "").replace(".json", ""))}<span class="block text-xs text-slate-500">${esc(fmtDateTime(f.modifiedAt))}</span></span>
              <button type="button" class="btn btn-sm btn-soft" data-action="restore-file" data-name="${esc(f.name)}">Wiederherstellen</button>
            </li>`,
          )
          .join("")
      : `<li class="py-2 text-sm text-slate-500">Noch keine Sicherungen vorhanden.</li>`;
  } catch (err) {
    ul.innerHTML = `<li class="py-2 text-sm text-rose-700">Sicherungen konnten nicht gelesen werden: ${esc((err as Error).message)}</li>`;
  }
}

function openBackupDialog() {
  void renderBackupDialog();
  dlgBackup.showModal();
}

$("#bkp_now").addEventListener("click", () =>
  safely(async () => {
    await runBackup();
    const st = getBackupStatus();
    toast(st.ok ? "Gesichert" : `Sicherung fehlgeschlagen: ${st.error}`, st.ok ? "success" : "error");
    await renderBackupDialog();
  }),
);
$("#bkp_export").addEventListener("click", () => safely(exportBackupFile, "Export fehlgeschlagen"));
input("#bkp_import").addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  const file = el.files?.[0];
  el.value = "";
  if (!file) return;
  void safely(async () => {
    const next = parseBackup(await file.text());
    if (await restoreFrom(next, `Die Datei „${file.name}“`)) dlgBackup.close();
  }, "Import fehlgeschlagen");
});
dlgBackup.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action='restore-file']");
  if (!btn?.dataset.name) return;
  const name = btn.dataset.name;
  void safely(async () => {
    const next = await readBackup(name);
    if (await restoreFrom(next, `Die Sicherung „${name}“`)) dlgBackup.close();
  }, "Wiederherstellen fehlgeschlagen");
});

/* ---------- Einstellungen ---------- */

function openSettings() {
  const s = getState().settings;
  $("#st_placeholders").textContent = TEMPLATE_PLACEHOLDERS;
  textarea("#st_confirm").value = s.confirmationTemplate;
  input("#st_reviewLink").value = s.reviewLink;
  textarea("#st_review").value = s.reviewTemplate;
  input("#st_reviewSubject").value = s.reviewEmailSubject;
  input("#st_requireConsent").checked = s.reviewRequireConsent;
  textarea("#st_categories").value = s.categories.join("\n");
  textarea("#st_channels").value = s.channels.join("\n");
  $("#st_version").textContent = `Version ${APP_VERSION}${isNative ? " · iOS-App" : " · Web"}`;
  dlgSettings.showModal();
}

const lines = (v: string) =>
  v
    .split(/\r?\n|,/)
    .map((x) => x.trim())
    .filter(Boolean);

$("#formSettings").addEventListener("submit", (ev) => {
  ev.preventDefault();
  void safely(async () => {
    const link = input("#st_reviewLink").value.trim();
    if (link && !/^https:\/\/\S+$/.test(link)) return toast("Der Bewertungslink muss mit https:// beginnen.", "error");
    const d = defaultSettings();
    const categories = lines(textarea("#st_categories").value);
    if (!categories.includes("Sonstiges")) categories.push("Sonstiges");
    await update((s) => {
      s.settings = {
        confirmationTemplate: textarea("#st_confirm").value.trim() || d.confirmationTemplate,
        reviewLink: link,
        reviewTemplate: textarea("#st_review").value.trim() || d.reviewTemplate,
        reviewEmailSubject: input("#st_reviewSubject").value.trim() || d.reviewEmailSubject,
        reviewRequireConsent: input("#st_requireConsent").checked,
        categories,
        channels: lines(textarea("#st_channels").value),
      };
    });
    dlgSettings.close();
    toast("Einstellungen gespeichert", "success");
  }, "Speichern fehlgeschlagen");
});

$("#st_reset").addEventListener("click", async () => {
  if (!(await confirmDialog("Texte zurücksetzen?", "Bestätigungs- und Feedback-Text werden auf die Standardtexte zurückgesetzt (erst nach „Speichern“ übernommen).", "Zurücksetzen", false))) return;
  const d = defaultSettings();
  textarea("#st_confirm").value = d.confirmationTemplate;
  textarea("#st_review").value = d.reviewTemplate;
  input("#st_reviewSubject").value = d.reviewEmailSubject;
});

/* ---------- Menü & globale Aktionen ---------- */

const menuPanel = $("#menuPanel");
const menuBtn = $("#btnMenu");
function setMenu(open: boolean) {
  menuPanel.classList.toggle("hidden", !open);
  menuBtn.setAttribute("aria-expanded", String(open));
}
menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenu(menuPanel.classList.contains("hidden"));
});
document.addEventListener("click", () => setMenu(false));

async function handleAction(action: string, id: string) {
  const state = getState();
  const slot = state.slots.find((s) => s.id === id);
  switch (action) {
    case "new-booking":
      if (slot) openBookingDialog(slot.id);
      break;
    case "edit-booking": {
      const b = state.bookings.find((x) => x.id === id);
      if (b) openBookingDialog(b.slotId, b);
      break;
    }
    case "edit-slot":
      if (slot) openSlotDialog(slot);
      break;
    case "delete-slot":
      if (slot) await deleteSlot(slot);
      break;
    case "toggle-archive":
      if (slot)
        await update((d) => {
          const s = d.slots.find((x) => x.id === id);
          if (s) s.archived = !s.archived;
        });
      break;
    case "ics":
      if (slot) await exportIcs(slot);
      break;
    case "review":
      if (slot) openReview(slot.id);
      break;
    case "backup":
      openBackupDialog();
      break;
    case "export":
      await exportBackupFile();
      break;
    case "csv":
      await shareFile(`SeeYou-Termine-${dateStamp()}.csv`, buildCsv(state), "text/csv");
      break;
    case "settings":
      if (dlgReview.open) dlgReview.close();
      openSettings();
      break;
    case "archive": {
      select("#filterStatus").value = "";
      render();
      const el = document.getElementById("archSection") as HTMLDetailsElement | null;
      if (!el) return toast("Noch nichts im Archiv.");
      el.open = true;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      break;
    }
    case "restore-latest":
      openBackupDialog();
      break;
  }
}

document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!el || el.closest("#dlgReview, #dlgBackup")) return;
  const action = el.dataset.action ?? "";
  if (el.closest("#menuPanel")) setMenu(false);
  void safely(() => handleAction(action, el.dataset.id ?? ""));
});
// Einstellungen-Link im Feedback-Dialog
dlgReview.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("[data-action='settings']")) void handleAction("settings", "");
});

$("#btnNewSlot").addEventListener("click", () => openSlotDialog());
input("#search").addEventListener("input", render);
select("#filterStatus").addEventListener("change", render);

// Schließen-Buttons und Tippen auf den Hintergrund schließen Dialoge
document.querySelectorAll<HTMLElement>("[data-close]").forEach((btn) =>
  btn.addEventListener("click", () => btn.closest("dialog")?.close()),
);
document.querySelectorAll<HTMLDialogElement>("dialog").forEach((dlg) =>
  dlg.addEventListener("click", (e) => {
    if (e.target !== dlg || dlg === dlgConfirm) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dlg.close();
  }),
);

// Auf-/Zuklappen merken (ohne neue Sicherung auszulösen)
listEl.addEventListener(
  "toggle",
  (e) => {
    const el = e.target as HTMLDetailsElement;
    if (el.tagName !== "DETAILS") return;
    const closed = !el.open;
    const ui = getState().ui;
    const current =
      el.id === "activeSection"
        ? ui.collapsedActive
        : el.id === "archSection"
          ? ui.collapsedArchive
          : el.dataset.slot
            ? ui.collapsedSlots.includes(el.dataset.slot)
            : closed;
    // Beim Neuzeichnen feuert "toggle" ebenfalls – nur echte Änderungen speichern
    if (current === closed) return;
    void update(
      (d) => {
        if (el.id === "activeSection") d.ui.collapsedActive = closed;
        else if (el.id === "archSection") d.ui.collapsedArchive = closed;
        else if (el.dataset.slot) {
          const set = new Set(d.ui.collapsedSlots);
          if (closed) set.add(el.dataset.slot);
          else set.delete(el.dataset.slot);
          d.ui.collapsedSlots = [...set];
        }
      },
      { silent: true },
    ).catch(() => {});
  },
  true,
);

/* ---------- Start ---------- */

async function setupOnboarding() {
  if (getState().slots.length) return;
  if (isNative) {
    try {
      const files = await listBackups();
      if (files.length) {
        onboardingHtml = `<div class="mb-4 rounded-2xl bg-white/90 border border-brand/40 p-4 text-sm">
          <p class="font-medium text-brand mb-1">Sicherung gefunden</p>
          <p>In iCloud liegt eine Sicherung vom ${esc(fmtDateTime(files[0].modifiedAt))}.</p>
          <button type="button" class="btn btn-primary mt-3" data-action="restore-latest">Sicherungen ansehen</button>
        </div>`;
        return;
      }
    } catch {
      /* iCloud nicht erreichbar */
    }
  }
  onboardingHtml = `<div class="mb-4 rounded-2xl bg-white/90 border border-brand/40 p-4 text-sm space-y-2">
    <p class="font-medium text-brand">Willkommen!</p>
    <p>Daten aus der bisherigen App übernehmen: In der alten App im Menü auf <strong>„Backup“</strong> tippen und die Datei sichern. Hier dann <strong>Menü → Sicherung → Sicherung importieren</strong> wählen.</p>
    <button type="button" class="btn btn-soft" data-action="backup">Sicherung importieren</button>
  </div>`;
}

async function registerServiceWorker() {
  if (isNative || !("serviceWorker" in navigator) || import.meta.env.DEV) return;
  const { registerSW } = await import("virtual:pwa-register");
  const updateSW = registerSW({
    onNeedRefresh() {
      void confirmDialog("Update verfügbar", "Eine neue Version der App ist da. Jetzt neu laden?", "Neu laden", false).then(
        (ok) => {
          if (ok) void updateSW(true);
        },
      );
    },
  });
}

async function init() {
  try {
    const { migrated } = await initStore();
    if (migrated) toast("Daten aus der bisherigen Version übernommen", "success");
  } catch (err) {
    console.error(err);
    toast(`Daten konnten nicht geladen werden: ${(err as Error).message}`, "error");
  }
  await setupOnboarding();
  subscribe(render);
  subscribe(() => {
    if (dlgReview.open) renderReview();
  });
  onBackupStatus(renderBackupStatus);
  render();
  void requestPersistentStorage();
  void registerServiceWorker();

  if (isNative) {
    // Beim Wechsel in den Hintergrund sofort sichern, beim Zurückkommen aktualisieren
    void App.addListener("pause", () => void flushBackup());
    void App.addListener("resume", () => {
      void update((d) => void autoArchive(d), { silent: true });
    });
    // Erste Sicherung nach dem Start, falls heute noch keine existiert
    const last = getState().meta.lastBackupAt;
    if (getState().slots.length && (!last || dateStamp(new Date(last)) !== dateStamp())) void runBackup();
  }
  // Ansicht minütlich aktualisieren (Status "vorbei", relative Zeiten)
  setInterval(render, 60_000);
}

void init();
