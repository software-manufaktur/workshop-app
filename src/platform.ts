// Plattform-Abstraktion: Web (PWA/Browser) vs. native iOS-App (Capacitor).
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { AppLauncher } from "@capacitor/app-launcher";
import {
  BackupExistsError,
  WebRestorePointDriver,
  WebStateStorage,
  type BackupDriver,
  type BackupFileInfo,
  type BackupLocation,
  type StateStorage,
  type StoredState,
} from "./storage";

export const isNative = Capacitor.isNativePlatform();

/* ---------- Natives Plugin (ios/App/App/SeeYouStoragePlugin.swift) ---------- */

interface SeeYouStoragePlugin {
  loadState(): Promise<{ data?: string; previous?: string }>;
  saveState(opts: { data: string }): Promise<void>;
  preserveCorrupt(opts: { data: string }): Promise<void>;
  backupStatus(): Promise<{ icloud: boolean }>;
  backupWrite(opts: { name: string; data: string; mode: "create" | "replace" }): Promise<{ location: BackupLocation }>;
  backupList(): Promise<{ files: BackupFileInfo[] }>;
  backupRead(opts: { name: string; location: BackupLocation }): Promise<{ data: string }>;
  backupRemove(opts: { name: string; location: BackupLocation }): Promise<void>;
  backupTransfer(): Promise<{ moved: number; renamed: number; duplicates: number }>;
}

const Native = registerPlugin<SeeYouStoragePlugin>("SeeYouStorage");

class NativeStateStorage implements StateStorage {
  async load(): Promise<StoredState> {
    const r = await Native.loadState();
    return { data: r.data ?? null, previous: r.previous ?? null };
  }
  save(json: string) {
    return Native.saveState({ data: json });
  }
  preserveCorrupt(raw: string) {
    return Native.preserveCorrupt({ data: raw });
  }
}

class NativeBackupDriver implements BackupDriver {
  status() {
    return Native.backupStatus();
  }
  async write(name: string, data: string, mode: "create" | "replace") {
    try {
      return await Native.backupWrite({ name, data, mode });
    } catch (err) {
      if ((err as { code?: string }).code === "EXISTS") throw new BackupExistsError(name);
      throw err;
    }
  }
  async list() {
    return (await Native.backupList()).files;
  }
  async read(name: string, location: BackupLocation) {
    return (await Native.backupRead({ name, location })).data;
  }
  remove(name: string, location: BackupLocation) {
    return Native.backupRemove({ name, location });
  }
  transferLocalToICloud() {
    return Native.backupTransfer();
  }
}

export function createStateStorage(): StateStorage {
  return isNative ? new NativeStateStorage() : new WebStateStorage();
}

export function createBackupDriver(): BackupDriver {
  return isNative ? new NativeBackupDriver() : new WebRestorePointDriver();
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

/* ---------- Dateien teilen / herunterladen ---------- */

export async function shareFile(fileName: string, content: string, mime: string): Promise<void> {
  if (isNative) {
    const res = await Filesystem.writeFile({
      path: fileName,
      data: content,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    try {
      await Share.share({ title: fileName, files: [res.uri] });
    } finally {
      // Kopie mit Teilnehmerdaten nicht im Cache liegen lassen
      await Filesystem.deleteFile({ path: fileName, directory: Directory.Cache }).catch(() => {});
    }
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
