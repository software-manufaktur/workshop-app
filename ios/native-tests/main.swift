// Führt die Dateilogik des nativen Plugins aus (simuliertes iCloud). Start: ios/native-tests/run.sh
import Foundation
var failures = 0
func check(_ ok: Bool, _ msg: String) { print(ok ? "✓ \(msg)" : "✗ \(msg)"); if !ok { failures += 1 } }
let p = SeeYouStoragePlugin()
func call(_ f: (CAPPluginCall) -> Void, _ o: [String: String] = [:]) -> CAPPluginCall { let c = CAPPluginCall(o); f(c); return c.wait() }

// --- Zustand ---
check(call(p.loadState).result?["data"] == nil, "leerer Start: keine Daten")
_ = call(p.saveState, ["data": "{\"v\":1}"])
_ = call(p.saveState, ["data": "{\"v\":2}"])
var r = call(p.loadState).result!
check(r["data"] as? String == "{\"v\":2}" && r["previous"] as? String == "{\"v\":1}", "atomar gespeichert, vorheriger Stand erhalten")
_ = call(p.saveState, ["data": "{\"v\":2}"])
r = call(p.loadState).result!
check(r["previous"] as? String == "{\"v\":1}", "gleicher Inhalt überschreibt den vorherigen Stand nicht")
check(call(p.preserveCorrupt, ["data": "kaputt"]).error == nil, "beschädigte Daten werden beiseitegelegt")

// --- Sicherungen in iCloud ---
check((call(p.backupStatus).result?["icloud"] as? Bool) == true, "iCloud verfügbar")
var c = call(p.backupWrite, ["name": "SeeYou-Sicherung-2026-10-08.json", "data": "A", "mode": "create"])
check(c.result?["location"] as? String == "icloud", "Tagessicherung in iCloud angelegt")
c = call(p.backupWrite, ["name": "SeeYou-Sicherung-2026-10-08.json", "data": "B", "mode": "create"])
check(c.error?.1 == "EXISTS", "create überschreibt nie (EXISTS)")
check(call(p.backupRead, ["name": "SeeYou-Sicherung-2026-10-08.json", "location": "icloud"]).result?["data"] as? String == "A", "Inhalt unverändert")
c = call(p.backupWrite, ["name": "SeeYou-Sicherung-2026-10-08.json", "data": "B", "mode": "replace"])
check(call(p.backupRead, ["name": "SeeYou-Sicherung-2026-10-08.json", "location": "icloud"]).result?["data"] as? String == "B", "replace ersetzt")
for bad in ["../x.json", ".hidden.json", "a/b.json", "x.txt", ""] {
    check(call(p.backupWrite, ["name": bad, "data": "X", "mode": "create"]).error != nil, "ungültiger Name abgelehnt: '\(bad)'")
}
// Nicht heruntergeladene iCloud-Datei (Platzhalter) zählt als vorhanden und wird beim Lesen geladen
try! "P".write(to: fakeCloud.appendingPathComponent("Documents/.SeeYou-Sicherung-2026-10-01.json.icloud"), atomically: true, encoding: .utf8)
check(call(p.backupWrite, ["name": "SeeYou-Sicherung-2026-10-01.json", "data": "X", "mode": "create"]).error?.1 == "EXISTS", "Platzhalter verhindert Überschreiben")
var files = call(p.backupList).result!["files"] as! [[String: Any]]
// Hinweis: backupList stößt den Download an (im Test sofort erledigt)
check(files.contains { $0["name"] as? String == "SeeYou-Sicherung-2026-10-01.json" }, "Platzhalter wird gelistet")
check(call(p.backupRead, ["name": "SeeYou-Sicherung-2026-10-01.json", "location": "icloud"]).result?["data"] as? String == "P", "Platzhalter-Datei wird geladen und gelesen")

// --- Lokaler Fallback ---
cloudOn = false
check((call(p.backupStatus).result?["icloud"] as? Bool) == false, "iCloud nicht verfügbar")
c = call(p.backupWrite, ["name": "SeeYou-Sicherung-2026-10-08.json", "data": "LOKAL", "mode": "create"])
check(c.result?["location"] as? String == "local", "Sicherung landet lokal")
_ = call(p.backupWrite, ["name": "SeeYou-Wiederherstellungspunkt-2026-10-08_10-00-00_vor-Import.json", "data": "RP", "mode": "create"])
files = call(p.backupList).result!["files"] as! [[String: Any]]
check(files.allSatisfy { $0["location"] as? String == "local" } && files.count == 2, "Liste zeigt nur lokale Dateien, solange iCloud fehlt")

// --- Übertragung nach iCloud ---
cloudOn = true
let t = call(p.backupTransfer).result!
check(t["moved"] as? Int == 1 && t["renamed"] as? Int == 1, "Übertragung: 1 verschoben, 1 umbenannt (Name in iCloud belegt)")
check(call(p.backupRead, ["name": "SeeYou-Sicherung-2026-10-08.json", "location": "icloud"]).result?["data"] as? String == "B", "vorhandene iCloud-Datei nicht überschrieben")
check(call(p.backupRead, ["name": "SeeYou-Sicherung-2026-10-08-lokal.json", "location": "icloud"]).result?["data"] as? String == "LOKAL", "lokale Kopie als -lokal erhalten")
files = call(p.backupList).result!["files"] as! [[String: Any]]
check(!files.contains { $0["location"] as? String == "local" }, "lokaler Ordner danach leer")
// Identische Datei wird nicht doppelt angelegt
cloudOn = false
_ = call(p.backupWrite, ["name": "SeeYou-Wiederherstellungspunkt-2026-10-08_10-00-00_vor-Import.json", "data": "RP", "mode": "create"])
cloudOn = true
let t2 = call(p.backupTransfer).result!
check(t2["duplicates"] as? Int == 1, "identische Kopie wird verworfen statt dupliziert")

// --- Löschen ---
_ = call(p.backupRemove, ["name": "SeeYou-Sicherung-2026-10-08-lokal.json", "location": "icloud"])
check(call(p.backupRead, ["name": "SeeYou-Sicherung-2026-10-08-lokal.json", "location": "icloud"]).error != nil, "Datei gelöscht")

print(failures == 0 ? "ALLE NATIVEN PRÜFUNGEN OK" : "\(failures) FEHLER")
exit(failures == 0 ? 0 : 1)
