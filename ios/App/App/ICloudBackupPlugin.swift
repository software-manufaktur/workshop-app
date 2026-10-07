import Foundation
import Capacitor

/// Schreibt Sicherungsdateien in den iCloud-Drive-Ordner der App
/// ("iCloud Drive → SeeYou Workshops"). Ist iCloud Drive nicht verfügbar,
/// wird in den lokalen Dokumente-Ordner geschrieben (sichtbar in der
/// Dateien-App unter "Auf meinem iPhone → SeeYou").
@objc(ICloudBackupPlugin)
public class ICloudBackupPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ICloudBackupPlugin"
    public let jsName = "ICloudBackup"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private let queue = DispatchQueue(label: "de.seeyou.workshops.backup", qos: .utility)
    private let fm = FileManager.default

    /// Ermittelt den Zielordner. url(forUbiquityContainerIdentifier:) kann
    /// blockieren und darf daher nicht auf dem Main-Thread laufen.
    private func directory() throws -> (URL, String) {
        if fm.ubiquityIdentityToken != nil,
           let container = fm.url(forUbiquityContainerIdentifier: nil) {
            let docs = container.appendingPathComponent("Documents", isDirectory: true)
            try fm.createDirectory(at: docs, withIntermediateDirectories: true)
            return (docs, "icloud")
        }
        let local = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return (local, "local")
    }

    /// Nur einfache Dateinamen zulassen (kein Pfad-Traversal).
    private func safeName(_ call: CAPPluginCall) -> String? {
        guard let name = call.getString("name"),
              !name.isEmpty, !name.contains("/"), !name.contains(".."),
              name.hasSuffix(".json") else {
            call.reject("Ungültiger Dateiname")
            return nil
        }
        return name
    }

    private func coordinatedWrite(_ data: Data, to url: URL) throws {
        var coordError: NSError?
        var writeError: Error?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &coordError) { target in
            do { try data.write(to: target, options: .atomic) } catch { writeError = error }
        }
        if let e = coordError ?? writeError { throw e }
    }

    @objc func status(_ call: CAPPluginCall) {
        queue.async {
            do {
                let (_, location) = try self.directory()
                call.resolve(["available": location == "icloud", "location": location])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let name = safeName(call) else { return }
        guard let text = call.getString("data"), let data = text.data(using: .utf8) else {
            call.reject("Keine Daten")
            return
        }
        queue.async {
            do {
                let (dir, location) = try self.directory()
                try self.coordinatedWrite(data, to: dir.appendingPathComponent(name))
                call.resolve(["location": location])
            } catch {
                call.reject("Sicherung fehlgeschlagen: \(error.localizedDescription)")
            }
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        queue.async {
            do {
                let (dir, _) = try self.directory()
                let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
                let urls = try self.fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])
                let iso = ISO8601DateFormatter()
                var files: [[String: Any]] = []
                for url in urls where url.pathExtension == "json" {
                    let values = try? url.resourceValues(forKeys: Set(keys))
                    files.append([
                        "name": url.lastPathComponent,
                        "modifiedAt": iso.string(from: values?.contentModificationDate ?? Date.distantPast),
                        "size": values?.fileSize ?? 0
                    ])
                }
                // Dateien, die nur in iCloud liegen (".name.json.icloud"), anfordern
                if let all = try? self.fm.contentsOfDirectory(atPath: dir.path) {
                    for f in all where f.hasPrefix(".") && f.hasSuffix(".json.icloud") {
                        let original = String(f.dropFirst().dropLast(".icloud".count))
                        try? self.fm.startDownloadingUbiquitousItem(at: dir.appendingPathComponent(original))
                    }
                }
                call.resolve(["files": files])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func read(_ call: CAPPluginCall) {
        guard let name = safeName(call) else { return }
        queue.async {
            do {
                let (dir, _) = try self.directory()
                let url = dir.appendingPathComponent(name)
                try? self.fm.startDownloadingUbiquitousItem(at: url)
                var coordError: NSError?
                var result: Result<String, Error> = .failure(NSError(domain: "ICloudBackup", code: 1))
                NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordError) { target in
                    result = Result { try String(contentsOf: target, encoding: .utf8) }
                }
                if let e = coordError { throw e }
                call.resolve(["data": try result.get()])
            } catch {
                call.reject("Datei konnte nicht gelesen werden: \(error.localizedDescription)")
            }
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let name = safeName(call) else { return }
        queue.async {
            do {
                let (dir, _) = try self.directory()
                let url = dir.appendingPathComponent(name)
                var coordError: NSError?
                var removeError: Error?
                NSFileCoordinator().coordinate(writingItemAt: url, options: .forDeleting, error: &coordError) { target in
                    do { try self.fm.removeItem(at: target) } catch { removeError = error }
                }
                if let e = coordError ?? removeError { throw e }
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }
}
