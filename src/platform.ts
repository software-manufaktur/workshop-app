// Plattform-Abstraktion: Web (PWA/Browser) vs. native iOS-App (Capacitor).
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { AppLauncher } from "@capacitor/app-launcher";

export const isNative = Capacitor.isNativePlatform();

/* ---------- Persistenz des App-Zustands ---------- */

const STATE_KEY = "seeyou_state_v2";

export async function loadRaw(): Promise<string | null> {
  if (isNative) return (await Preferences.get({ key: STATE_KEY })).value;
  return localStorage.getItem(STATE_KEY);
}

export async function saveRaw(json: string): Promise<void> {
  if (isNative) {
    await Preferences.set({ key: STATE_KEY, value: json });
    return;
  }
  localStorage.setItem(STATE_KEY, json);
  // Lesen nach Schreiben: iOS kann bei vollem Speicher still scheitern
  if (localStorage.getItem(STATE_KEY) !== json) throw new Error("Speichern auf dem Gerät fehlgeschlagen");
}

export const legacyGet = (key: string) => (isNative ? null : localStorage.getItem(key));

/** Bittet den Browser, die Daten nicht automatisch zu löschen (nur Web relevant). */
export async function requestPersistentStorage(): Promise<void> {
  if (isNative) return;
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* egal */
  }
}

/* ---------- iCloud-Sicherung (eigenes natives Plugin, siehe ios/App/App/ICloudBackupPlugin.swift) ---------- */

export interface BackupFile {
  name: string;
  modifiedAt: string;
  size: number;
}

interface ICloudBackupPlugin {
  status(): Promise<{ available: boolean; location: "icloud" | "local" }>;
  write(opts: { name: string; data: string }): Promise<{ location: "icloud" | "local" }>;
  list(): Promise<{ files: BackupFile[] }>;
  read(opts: { name: string }): Promise<{ data: string }>;
  remove(opts: { name: string }): Promise<void>;
}

export const ICloudBackup = registerPlugin<ICloudBackupPlugin>("ICloudBackup");

/* ---------- Dateien teilen / herunterladen ---------- */

export async function shareFile(fileName: string, content: string, mime: string): Promise<void> {
  if (isNative) {
    const res = await Filesystem.writeFile({
      path: fileName,
      data: content,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    await Share.share({ title: fileName, files: [res.uri] });
    return;
  }
  const blob = new Blob([content], { type: mime });
  const file = new File([blob], fileName, { type: mime });
  // iOS-Safari: Teilen-Dialog erlaubt direktes Ablegen in iCloud Drive
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return;
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- Externe Links (WhatsApp, Mail) ---------- */

export async function openExternal(url: string): Promise<void> {
  if (isNative) {
    await AppLauncher.openUrl({ url });
    return;
  }
  if (url.startsWith("mailto:")) {
    window.location.href = url;
  } else {
    window.open(url, "_blank", "noopener");
  }
}
