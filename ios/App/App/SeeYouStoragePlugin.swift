import Foundation
import Capacitor

/// Natives Speicher-Plugin der SeeYou-App.
///
/// 1. App-Zustand: `Application Support/SeeYou/state.json` (atomar geschrieben,
///    vorheriger Stand bleibt als `state.prev.json` erhalten).
/// 2. Sicherungsdateien: iCloud Drive → „SeeYou Workshops“. Ist iCloud Drive nicht
///    verfügbar, landen sie in „Auf meinem iPhone → SeeYou → Sicherungen“ und werden
///    später ohne Überschreiben nach iCloud übertragen (`backupTransfer`).
///
/// Alle Dateizugriffe laufen auf seriellen Hintergrund-Queues (iCloud-APIs dürfen
/// nicht auf dem Main-Thread laufen) und bei iCloud über NSFileCoordinator.
@objc(SeeYouStoragePlugin)
public class SeeYouStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SeeYouStoragePlugin"
    public let jsName = "SeeYouStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "loadState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "preserveCorrupt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "backupStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "backupWrite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "backupList", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "backupRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "backupRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "backupTransfer", returnType: CAPPluginReturnPromise)
    ]

    private let stateQueue = DispatchQueue(label: "de.seeyou.workshops.state", qos: .userInitiated)
    private let backupQueue = DispatchQueue(label: "de.seeyou.workshops.backup", qos: .utility)
    private let fm = FileManager.default
    private let iso = ISO8601DateFormatter()
    private static let containerId = "iCloud.de.seeyou.workshops"
    private static let localBackupFolder = "Sicherungen"

    // MARK: - App-Zustand

    private func stateDir() throws -> URL {
        let base = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = base.appendingPathComponent("SeeYou", isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    @objc func loadState(_ call: CAPPluginCall) {
        stateQueue.async {
            do {
                let dir = try self.stateDir()
                var result: [String: Any] = [:]
                if let data = try? String(contentsOf: dir.appendingPathComponent("state.json"), encoding: .utf8) {
                    result["data"] = data
                }
                if let prev = try? String(contentsOf: dir.appendingPathComponent("state.prev.json"), encoding: .utf8) {
                    result["previous"] = prev
                }
                call.resolve(result)
            } catch {
                call.reject("Daten konnten nicht geladen werden: \(error.localizedDescription)")
            }
        }
    }

    @objc func saveState(_ call: CAPPluginCall) {
        guard let text = call.getString("data"), let data = text.data(using: .utf8) else {
            call.reject("Keine Daten")
            return
        }
        stateQueue.async {
            do {
                let dir = try self.stateDir()
                let current = dir.appendingPathComponent("state.json")
                let previous = dir.appendingPathComponent("state.prev.json")
                if let old = try? Data(contentsOf: current), old != data {
                    try old.write(to: previous, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                }
                // .atomic: erst temporäre Datei, dann Umbenennen – nie halb geschrieben
                try data.write(to: current, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                call.resolve()
            } catch {
                call.reject("Speichern fehlgeschlagen: \(error.localizedDescription)")
            }
        }
    }

    @objc func preserveCorrupt(_ call: CAPPluginCall) {
        guard let text = call.getString("data"), let data = text.data(using: .utf8) else {
            call.reject("Keine Daten")
            return
        }
        stateQueue.async {
            do {
                let name = "state.corrupt-\(Int(Date().timeIntervalSince1970)).json"
                try data.write(to: try self.stateDir().appendingPathComponent(name), options: [.atomic])
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    // MARK: - Ordner für Sicherungen

    private var cachedICloudDocs: URL?

    /// iCloud-Drive-Ordner der App oder nil, wenn iCloud Drive nicht verfügbar ist.
    private func iCloudDocs() -> URL? {
        guard fm.ubiquityIdentityToken != nil else {
            cachedICloudDocs = nil
            return nil
        }
        if let cached = cachedICloudDocs { return cached }
        guard let container = fm.url(forUbiquityContainerIdentifier: Self.containerId) else { return nil }
        let docs = container.appendingPathComponent("Documents", isDirectory: true)
        do {
            try fm.createDirectory(at: docs, withIntermediateDirectories: true)
        } catch {
            return nil
        }
        cachedICloudDocs = docs
        return docs
    }

    private func localDocs() throws -> URL {
        let docs = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let dir = docs.appendingPathComponent(Self.localBackupFolder, isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func dir(for location: String) throws -> URL {
        if location == "icloud" {
            guard let docs = iCloudDocs() else { throw PluginError.message("iCloud Drive ist nicht verfügbar") }
            return docs
        }
        return try localDocs()
    }

    /// Nur einfache Dateinamen (kein Pfad, keine versteckten Dateien).
    private func validName(_ call: CAPPluginCall) -> String? {
        guard let name = call.getString("name"),
              name.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\\.json$", options: .regularExpression) != nil,
              !name.contains("..") else {
            call.reject("Ungültiger Dateiname")
            return nil
        }
        return name
    }

    /// Platzhalter einer nur in iCloud liegenden Datei: ".name.json.icloud"
    private func placeholderURL(for url: URL) -> URL {
        url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
    }

    private func exists(_ url: URL) -> Bool {
        fm.fileExists(atPath: url.path) || fm.fileExists(atPath: placeholderURL(for: url).path)
    }

    private func coordinatedWrite(_ data: Data, to url: URL, createOnly: Bool) throws {
        var coordError: NSError?
        var innerError: Error?
        NSFileCoordinator().coordinate(writingItemAt: url, options: createOnly ? [] : .forReplacing, error: &coordError) { target in
            do {
                if createOnly && self.exists(target) { throw PluginError.exists }
                try data.write(to: target, options: [.atomic])
            } catch {
                innerError = error
            }
        }
        if let e = innerError ?? coordError { throw e }
    }

    private func reject(_ call: CAPPluginCall, _ error: Error, prefix: String) {
        if case PluginError.exists = error {
            call.reject("Datei existiert bereits", "EXISTS")
        } else {
            call.reject("\(prefix): \(error.localizedDescription)")
        }
    }

    // MARK: - Sicherungen

    @objc func backupStatus(_ call: CAPPluginCall) {
        backupQueue.async {
            call.resolve(["icloud": self.iCloudDocs() != nil])
        }
    }

    @objc func backupWrite(_ call: CAPPluginCall) {
        guard let name = validName(call) else { return }
        guard let text = call.getString("data"), let data = text.data(using: .utf8) else {
            call.reject("Keine Daten")
            return
        }
        let createOnly = call.getString("mode") != "replace"
        backupQueue.async {
            do {
                let location = self.iCloudDocs() != nil ? "icloud" : "local"
                let url = try self.dir(for: location).appendingPathComponent(name)
                try self.coordinatedWrite(data, to: url, createOnly: createOnly)
                call.resolve(["location": location])
            } catch {
                self.reject(call, error, prefix: "Sicherung fehlgeschlagen")
            }
        }
    }

    @objc func backupList(_ call: CAPPluginCall) {
        backupQueue.async {
            var files: [[String: Any]] = []
            var dirs: [(String, URL)] = []
            if let cloud = self.iCloudDocs() { dirs.append(("icloud", cloud)) }
            if let local = try? self.localDocs() { dirs.append(("local", local)) }
            for (location, dir) in dirs {
                guard let names = try? self.fm.contentsOfDirectory(atPath: dir.path) else { continue }
                for entry in names {
                    var name = entry
                    var downloaded = true
                    if entry.hasPrefix(".") && entry.hasSuffix(".json.icloud") {
                        // nur in iCloud vorhanden → im Hintergrund laden
                        name = String(entry.dropFirst().dropLast(".icloud".count))
                        downloaded = false
                        try? self.fm.startDownloadingUbiquitousItem(at: dir.appendingPathComponent(name))
                    } else if entry.hasPrefix(".") || !entry.hasSuffix(".json") {
                        continue
                    }
                    let attrs = try? self.fm.attributesOfItem(atPath: dir.appendingPathComponent(entry).path)
                    let modified = (attrs?[.modificationDate] as? Date) ?? Date(timeIntervalSince1970: 0)
                    let size = (attrs?[.size] as? NSNumber)?.intValue ?? 0
                    files.append([
                        "name": name,
                        "modifiedAt": self.iso.string(from: modified),
                        "size": size,
                        "location": location,
                        "downloaded": downloaded
                    ])
                }
            }
            call.resolve(["files": files])
        }
    }

    @objc func backupRead(_ call: CAPPluginCall) {
        guard let name = validName(call) else { return }
        let location = call.getString("location") ?? "icloud"
        backupQueue.async {
            do {
                let url = try self.dir(for: location).appendingPathComponent(name)
                if location == "icloud" && !self.fm.fileExists(atPath: url.path) {
                    // Datei liegt nur in iCloud: Download anstoßen und bis zu 60 s warten
                    try self.fm.startDownloadingUbiquitousItem(at: url)
                    let deadline = Date().addingTimeInterval(60)
                    while !self.fm.fileExists(atPath: url.path) && Date() < deadline {
                        Thread.sleep(forTimeInterval: 0.5)
                    }
                    if !self.fm.fileExists(atPath: url.path) {
                        throw PluginError.message("Die Datei wird noch aus iCloud geladen. Bitte gleich noch einmal versuchen.")
                    }
                }
                var coordError: NSError?
                var result: Result<String, Error> = .failure(PluginError.message("Nicht lesbar"))
                NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordError) { target in
                    result = Result { try String(contentsOf: target, encoding: .utf8) }
                }
                if let e = coordError { throw e }
                call.resolve(["data": try result.get()])
            } catch {
                self.reject(call, error, prefix: "Datei konnte nicht gelesen werden")
            }
        }
    }

    @objc func backupRemove(_ call: CAPPluginCall) {
        guard let name = validName(call) else { return }
        let location = call.getString("location") ?? "icloud"
        backupQueue.async {
            do {
                let url = try self.dir(for: location).appendingPathComponent(name)
                var coordError: NSError?
                var innerError: Error?
                NSFileCoordinator().coordinate(writingItemAt: url, options: .forDeleting, error: &coordError) { target in
                    do { try self.fm.removeItem(at: target) } catch { innerError = error }
                }
                if let e = innerError ?? coordError { throw e }
                call.resolve()
            } catch {
                self.reject(call, error, prefix: "Löschen fehlgeschlagen")
            }
        }
    }

    /// Verschiebt lokale Ersatzsicherungen nach iCloud. Vorhandene iCloud-Dateien
    /// werden nie überschrieben: identische Kopien entfallen, abweichende bekommen
    /// den Zusatz „-lokal“.
    @objc func backupTransfer(_ call: CAPPluginCall) {
        backupQueue.async {
            guard let cloud = self.iCloudDocs() else {
                call.reject("iCloud Drive ist nicht verfügbar")
                return
            }
            var moved = 0, renamed = 0, duplicates = 0
            do {
                let local = try self.localDocs()
                let names = try self.fm.contentsOfDirectory(atPath: local.path).filter { $0.hasSuffix(".json") && !$0.hasPrefix(".") }
                for name in names {
                    let source = local.appendingPathComponent(name)
                    var target = cloud.appendingPathComponent(name)
                    if self.exists(target) {
                        if self.fm.fileExists(atPath: target.path),
                           let a = try? Data(contentsOf: source), let b = try? Data(contentsOf: target), a == b {
                            try self.fm.removeItem(at: source)
                            duplicates += 1
                            continue
                        }
                        let base = (name as NSString).deletingPathExtension
                        var i = 1
                        repeat {
                            target = cloud.appendingPathComponent(i == 1 ? "\(base)-lokal.json" : "\(base)-lokal-\(i).json")
                            i += 1
                        } while self.exists(target)
                        renamed += 1
                    } else {
                        moved += 1
                    }
                    try self.fm.setUbiquitous(true, itemAt: source, destinationURL: target)
                }
                call.resolve(["moved": moved, "renamed": renamed, "duplicates": duplicates])
            } catch {
                call.reject("Übertragung nach iCloud fehlgeschlagen: \(error.localizedDescription)")
            }
        }
    }
}

enum PluginError: LocalizedError {
    case exists
    case message(String)

    var errorDescription: String? {
        switch self {
        case .exists: return "Datei existiert bereits"
        case .message(let text): return text
        }
    }
}
