# Review-Bericht: PR #1 „SeeYou 2.0“, Datensicherheit und iOS-Umstieg

Stand: 08.10.2026 · Branch `ccr-d3bd0500-a46xzw` · nicht gemergt, nichts veröffentlicht.

Ziel war eine wartungsarme iOS-App mit zuverlässiger lokaler Speicherung, automatischer iCloud-Sicherung und verlustfreier Migration. Maßstab: **Datenverlust muss so weit wie möglich ausgeschlossen sein.**

---

## 1. Gefundene Probleme (Stand vor dieser Überarbeitung)

### Kritisch: konnten zu Datenverlust führen

| # | Problem | Folge |
|---|---|---|
| K1 | **Verlorene Änderungen durch parallele Speichervorgänge.** `update()` kopierte den Zustand, wartete auf das Speichern und übernahm dann die Kopie. Zwei gleichzeitige Änderungen (z. B. Nutzerin speichert, während die Sicherung „zuletzt gesichert“ einträgt) überschrieben sich gegenseitig. | Eine Buchung konnte nach dem nächsten Start fehlen. |
| K2 | **Beschädigte gespeicherte Daten → leere App → Überschreiben.** Ein JSON-Fehler beim Laden ließ die App leer starten; die erste Eingabe überschrieb dann den (reparierbaren) Datenbestand. | Totalverlust der lokalen Daten. |
| K3 | **Neuinstallation überschreibt die iCloud-Sicherung.** Nach einer Neuinstallation ersetzte die erste Eingabe (vor dem Wiederherstellen) die Tagessicherung und `SeeYou-Sicherung-aktuell.json` durch einen fast leeren Stand. | Der aktuellste Sicherungsstand ging verloren. |
| K4 | **Sicherungen nach Neuinstallation unsichtbar.** Das Swift-Plugin ignorierte iCloud-Platzhalter (`.name.json.icloud`) beim Auflisten. Nicht heruntergeladene Sicherungen erschienen nicht, und „existiert schon?“ erkannte sie nicht. | Wiederherstellung nach Neuinstallation scheiterte; Sicherungen konnten überschrieben werden. |
| K5 | **Migration verwarf Daten stillschweigend.** Buchungen ohne passenden Termin und Termine ohne gültiges Datum wurden beim Import ohne Hinweis gelöscht. Beschädigte Altdaten im `localStorage` wurden wie „leer“ behandelt und später überschrieben. | Unbemerkter Verlust einzelner Teilnehmer. |
| K6 | **Import einer alten Sicherung setzte die eigene WhatsApp-Vorlage zurück.** Die Backup-Datei der alten App enthält keine Einstellungen; der Import ersetzte sie durch die Standardtexte. *(Gefunden durch die neuen Ende-zu-Ende-Tests.)* | Individuelle Einstellungen gingen verloren. |
| K7 | **App-Zustand in `UserDefaults`** (Capacitor Preferences): kein atomares Schreiben, keine vorherige Version als Rückfallebene. | Kein Rückweg bei Beschädigung. |

### Hoch

| # | Problem |
|---|---|
| H1 | Keine Wiederherstellungspunkte vor kritischen Aktionen (Import, Wiederherstellen, Löschen). |
| H2 | Fehlgeschlagene Sicherungen wurden nicht wiederholt (erst bei der nächsten Änderung). |
| H3 | Lokale Ersatzsicherungen (ohne iCloud) wurden nie nach iCloud übertragen. |
| H4 | Rotation nach Dateianzahl statt Tagen; auch unveränderte Tage erzeugten Dateien und verdrängten echte Stände. |
| H5 | TestFlight-Workflow nur per `workflow_dispatch`: Der ist erst auf dem Default-Branch sichtbar, also gab es keine Möglichkeit, den iOS-Build vor dem Merge zu prüfen. |
| H6 | Kein geteiltes Xcode-Schema, keine Prüfung der Secrets, kollidierende Build-Nummern bei erneutem Lauf, keine Kontrolle der iCloud-Berechtigung im signierten Build, Xcode-Version unbestimmt. |
| H7 | Fehlendes Privacy-Manifest (`PrivacyInfo.xcprivacy`). App Store Connect meldet das bei den genutzten Datei-Zeitstempel-/UserDefaults-APIs. |
| H8 | Start blockiert, solange iCloud-Dateien geladen werden (bis zu 60 s pro Datei). |

### Mittel / Niedrig

- `UIRequiredDeviceCapabilities` = `armv7` (veraltet, jetzt `arm64`).
- Inhaltliche Änderungen konnten als „still“ markiert werden und liefen dann an der Sicherung vorbei (Auto-Archiv beim Zurückkehren in die App).
- Exportierte Dateien mit Teilnehmerdaten blieben im App-Cache liegen.
- Einwilligung zur Feedback-Anfrage ohne Zeitpunkt (kein Nachweis).
- Web: Zwei offene Browser-Tabs konnten sich gegenseitig überschreiben.
- `@capacitor/preferences` nach der Umstellung überflüssig (entfernt).

---

## 2. Umgesetzte Korrekturen

### Speicherlogik (`src/store.ts`, `src/storage.ts`)

- **Serialisierte Änderungen:** Alle Änderungen laufen über eine Warteschlange; jede sieht das Ergebnis der vorherigen. Neuer Zustand wird **erst nach erfolgreichem Speichern** übernommen; Fehler lassen den alten Stand unverändert und blockieren nachfolgende Änderungen nicht. (K1)
- **Revisionszähler:** Steigt nur bei inhaltlichen Änderungen. Ob gesichert werden muss, entscheidet allein der Inhalt, nicht der Aufrufer. (Mittel)
- **Atomare Speicherung mit vorherigem Stand:** iOS: `Application Support/SeeYou/state.json` (`.atomic`, Dateischutz bis zur ersten Entsperrung) + `state.prev.json`. Web: `seeyou_state_v2` + `_prev`, Lese-Prüfung nach dem Schreiben, Rücksetzen bei Speicherfehler. (K7)
- **Beschädigung:** Unlesbarer Stand → vorheriger Stand wird geladen, die kaputte Fassung beiseitegelegt. Ist beides unlesbar, **sperrt** die App alle Änderungen, bis bewusst eine Sicherung wiederhergestellt wird. Es wird nie etwas überschrieben. (K2)
- **Altdaten-Migration** (Web, `localStorage` der alten App): genau einmal; beschädigte Altdaten führen zur Sperre statt zum Überschreiben; die alten Schlüssel bleiben unverändert erhalten. (K5)
- Web: Änderungen eines anderen Tabs werden nachgeladen statt überschrieben.

### iCloud-Sicherung (`src/backup.ts`, `ios/App/App/SeeYouStoragePlugin.swift`)

- **Automatisch nach Änderungen** (2,5 s entprellt), beim Wechsel in den Hintergrund sofort; noch nicht gesicherte Änderungen werden beim nächsten Start nachgeholt.
- **Tagessicherungen** `SeeYou-Sicherung-JJJJ-MM-TT.json`: nur für Tage mit Änderungen; **Rotation 60 Tage**, mindestens die 10 neuesten bleiben immer (auch nach langer Pause). Fremde Dateien werden nie angefasst. (H4)
- **Unveränderliche Wiederherstellungspunkte** `SeeYou-Wiederherstellungspunkt-…_grund.json` vor Import, Wiederherstellung und Löschen eines Termins. Sie werden nur neu angelegt (`create`), nie überschrieben; bei gleichem Namen entsteht `-2`, `-3` … (H1)
- **Keine unbemerkten Überschreibungen:** (K3)
  - Ein leerer Datenstand wird nie automatisch gesichert.
  - Ist die vorhandene Tagessicherung **neuer** (höhere Revision, z. B. nach einer Neuinstallation), bleibt sie unangetastet; der aktuelle Stand wird separat abgelegt.
  - Hätte die vorhandene Tagessicherung **mehr Einträge**, wird ihr Inhalt vorher als Wiederherstellungspunkt gesichert.
  - Eine **unlesbare** Tagessicherung wird nie überschrieben.
- **Fehler & Wiederholung:** Status mit Fehlermeldung und Zeitpunkt des nächsten Versuchs; Wiederholung nach 30 s, 2 min, 10 min, dann alle 30 min. (H2)
- **Lokaler Fallback:** Ohne iCloud Drive wird in „Auf meinem iPhone → SeeYou → Sicherungen“ gesichert (sichtbarer Hinweis in der App). Sobald iCloud verfügbar ist, werden diese Dateien **ohne Überschreiben** übertragen: identische Kopien entfallen, abweichende bekommen den Zusatz `-lokal`. (H3)
- **iCloud-Platzhalter** werden erkannt, gelistet, beim Lesen heruntergeladen (bis 60 s) und zählen als „vorhanden“. Dateizugriffe über `NSFileCoordinator`, nur auf Hintergrund-Queues, Dateinamen streng geprüft (kein Pfad-Traversal). (K4)

### Wiederherstellung (`src/main.ts`)

- Nach einer Neuinstallation (leere App) sucht die App **im Hintergrund** nach der neuesten lesbaren Sicherung mit Daten und bietet sie mit Datum und Anzahl an. **Übernahme nur nach Bestätigung.** (H8)
- Jede Wiederherstellung und jeder Import zeigt vorher Inhalt, Hinweise und was ersetzt wird, und legt einen Wiederherstellungspunkt an. Scheitert das, wird ausdrücklich gefragt, ob trotzdem fortgefahren werden soll.
- Dateien ohne Einstellungen (alte App) **behalten die aktuellen Einstellungen**. (K6)

### Migration (`src/model.ts`)

- **Nichts verschwindet:**
  - Buchungen ohne Termin → archivierter Ersatz-Termin „Unbekannter Termin“ (ursprüngliche Termin-ID vermerkt).
  - Termine ohne gültiges Datum → übernommen und markiert.
  - Unlesbare Einträge → Quarantäne, die mitgesichert und exportierbar ist.
  - Doppelte IDs → neue ID, Original vermerkt.
  - Ungültige Zahlen → repariert, Originalwert vermerkt.
  - Unbekannte Felder → bleiben erhalten (`extra`).
- **Prüfbericht** vor dem Import (Anzahlen ein/aus, Hinweise, fehlende Einstellungen).
- Übernahme von Vorlage, Klappzuständen und letztem Backup-Datum aus dem `localStorage` der alten App.

### Natives iOS-Projekt

- Plugin `SeeYouStoragePlugin` (Capacitor 8: `CAPBridgedPlugin`, Registrierung über `MainViewController.capacitorDidLoad()` → `registerPluginInstance`; gegen die Quellen von `@capacitor/ios` 8.5.3 geprüft).
- Entitlements (iCloud Documents, Container `iCloud.de.seeyou.workshops`) und `NSUbiquitousContainers` (sichtbarer Ordner „SeeYou Workshops“) geprüft.
- Neu: `PrivacyInfo.xcprivacy` (kein Tracking, keine erhobenen Daten; begründete API-Nutzung), geteiltes Xcode-Schema, `arm64`. (H6, H7)

### GitHub Actions

- `ios.yml`:
  - **Kompilier-Prüfung** bei jeder Änderung im PR (macOS-Runner, Simulator, unsigniert, ohne Secrets).
  - **Label `testflight`** am PR → signierter Build + Upload zu TestFlight **vor dem Merge**.
  - Nach dem Merge zusätzlich **Run workflow**.
  - Prüft die Secrets vorab, wählt die neueste stabile Xcode-Version, vergibt eindeutige Build-Nummern, kontrolliert die iCloud-Berechtigung im signierten Archiv und legt bei Fehlern das Xcode-Protokoll als Artefakt ab. (H5, H6)
- `ci.yml`: Typecheck, Unit-Tests, Build, **Ende-zu-Ende-Tests (Chromium)** und **Swift-Plugin-Tests (Linux)**.
- `pages.yml` unverändert: Die Web-Version läuft weiter auf GitHub Pages (Umstellung der Pages-Quelle vor dem Merge nötig, siehe Anleitung).

### Datenschutz & Feedback-Funktion

- Keine Server, keine Datenbank, keine Fremd-Skripte; Content-Security-Policy; Daten nur auf dem iPhone bzw. in Stefanies eigener iCloud.
- Keine iOS-Berechtigungsabfragen nötig (keine Kamera/Fotos/Kontakte/Ortung).
- Export-Kopien werden nach dem Teilen aus dem Cache gelöscht.
- Feedback:
  - Standardmäßig nur an Kontakte mit Einwilligung; Einwilligung jetzt mit Zeitpunkt (auch im CSV).
  - Sammel-E-Mail nur per BCC.
  - Neutrale Formulierung (kein „Review Gating“).

---

## 3. Testergebnisse

| Bereich | Wie getestet | Ergebnis |
|---|---|---|
| Typecheck (TypeScript strict) | `npm run typecheck` | ✅ fehlerfrei |
| Produktions-Build (Web) | `vite build` | ✅ |
| Datenmodell, Vorlagen, CSV/ICS/mailto, Escaping | Vitest, `src/model.test.ts` | ✅ 20/20 |
| Migration alter Daten (vollständig, problematische Datensätze, Rundreise, `localStorage`) | Vitest, `src/migration.test.ts` | ✅ 14/14 |
| Speicherlogik (40 parallele Änderungen mit zufälliger Verzögerung, Fehler beim Speichern, Beschädigung, Sperre, Einmal-Migration) | Vitest, `src/store.test.ts` | ✅ 10/10 |
| Sicherung (Entprellung, leerer Stand, Tagesdateien, Wiederholung, Nachholen nach Neustart, Schutz vor Überschreiben, Neuinstallation, unveränderliche Punkte, lokaler Fallback + Übertragung, Rotation, Wiederherstellung) | Vitest mit simuliertem iCloud, `src/backup.test.ts` | ✅ 20/20 |
| Bestehende Funktionen in der Oberfläche (Migration, Buchungen, Doppelte, Kapazität, XSS, Feedback/WhatsApp, Bestätigung mit eigener Vorlage, Import inkl. Wiederherstellungspunkt und Rückweg, Löschen umkehrbar, Sperre bei Beschädigung, Export→Import identisch, Suche/Archiv/CSV/ICS, keine Endlosschleife, keine Konsolenfehler) | Playwright, Chromium in iPhone-Ansicht, `e2e/app.spec.ts` | ✅ 10/10 |
| Swift-Plugin: Typprüfung | `swiftc -typecheck` (Swift 6.1, Linux) gegen Stubs der Capacitor-8-API | ✅ |
| Swift-Plugin: Dateilogik (atomares Speichern + Vorversion, Nicht-Überschreiben, Platzhalter, Namensprüfung, lokaler Fallback, Übertragung, Duplikate, Löschen) | ausgeführt auf Linux mit simuliertem iCloud, `ios/native-tests/` | ✅ 26/26 |
| Plists, Entitlements, Privacy-Manifest, Xcode-Schema, Workflows | Syntaxprüfung (plistlib, XML, YAML), Projektdatei auf Konsistenz geprüft | ✅ |
| **Native iOS-App kompilieren (Xcode, Swift Package Manager, Capacitor 8, eigenes Plugin)** | GitHub Actions `iOS-App → Kompilier-Prüfung` auf macOS 15, Simulator, unsigniert (Run 37758914199, Commit 73d83d7) | ✅ erfolgreich |
| CI auf GitHub (Typecheck, Unit-, E2E- und Swift-Plugin-Tests) | Run 37758914162 | ✅ alle Jobs grün |

### Noch **nicht** auf einem echten iPhone bzw. mit Xcode verifiziert

In dieser Umgebung gibt es weder macOS noch Xcode. Ein nativer iOS-Build war in der Entwicklungsumgebung **nicht möglich**; der Simulator-Build wurde deshalb auf einem macOS-Runner von GitHub durchgeführt (erfolgreich). Offen sind damit:

1. ~~Kompilieren in Xcode~~ → inzwischen auf einem macOS-Runner von GitHub erfolgreich (siehe Tabelle). Offen bleibt der **signierte Release-Build** für ein echtes Gerät.
2. **Signierung und Upload zu TestFlight** (Apple-Konten, API-Schlüssel, iCloud-Container im Profil).
3. **Echtes iCloud-Verhalten:** Erreichbarkeit des Containers, Sichtbarkeit des Ordners „SeeYou Workshops“ in der Dateien-App, Hoch-/Herunterladen, Platzhalter nach Neuinstallation, Übertragung lokaler Dateien mit `setUbiquitous`.
4. **WKWebView-spezifisches Verhalten:** Dateiauswahl beim Import, Teilen-Dialog beim Export, Öffnen von WhatsApp/Mail über `AppLauncher`, Ereignisse `pause`/`resume`.
5. **Plugin-Registrierung zur Laufzeit** (`registerPluginInstance` im `MainViewController`).
6. **Export aus der alten Web-App** auf Stefanies iPhone (Download in einer Home-Bildschirm-App).

---

## 4. Verbleibende Risiken

| Risiko | Einschätzung / Gegenmaßnahme |
|---|---|
| Erster Build scheitert an Signierung/iCloud-Konfiguration | wahrscheinlich beim ersten Versuch; Workflow nennt die Ursache, Anleitung enthält Fehlertabelle |
| iCloud lädt verzögert hoch | Sicherung ist lokal sofort geschrieben, iOS lädt im Hintergrund hoch. Ein Verlust des iPhones direkt nach einer Änderung kann die letzten Minuten kosten |
| Nutzung auf zwei Geräten gleichzeitig | nicht vorgesehen; Sicherungen überschreiben sich nicht gegenseitig, es gibt aber keine Zusammenführung |
| TestFlight-Builds laufen nach 90 Tagen ab, Developer-Mitgliedschaft jährlich | regelmäßig neu bauen (Kalender-Erinnerung); Daten bleiben bei Updates erhalten |
| Alte App: Backup-Download in der Home-Bildschirm-App | vor dem Umstieg prüfen (Anleitung Schritt 1), sonst abbrechen |
| WhatsApp-Vorlage steckt nicht in der alten Backup-Datei | Anleitung: Text vorab sichern und nach dem Import einfügen; Import behält vorhandene Einstellungen |
| Teilnehmerdaten werden unbegrenzt aufbewahrt | Empfehlung: alte Archiv-Termine regelmäßig löschen (Löschfunktion vorhanden); automatische Löschfrist als mögliche Erweiterung |
| macOS-Minuten in GitHub Actions (privates Repo: Faktor 10) | Kompilier-Prüfung läuft nur bei Änderungen an App-/iOS-Dateien |
| Web-Version: Wiederherstellungspunkte nur im Browser (max. 5) | Web ist nur Rückfallebene; regelmäßiger Export empfohlen (Erinnerung vorhanden) |
| Altes Supabase-Projekt der „tempio“-Version (`workshop-dev`) | offene Registrierung, ggf. personenbezogene Daten: Registrierung abschalten oder Projekt löschen |

---

## 5. Freigabeempfehlung

**Erster TestFlight-Build: Freigabe empfohlen**, als interner Test unter folgenden Bedingungen:

1. ✅ Die **Kompilier-Prüfung** („iOS-App → Kompilier-Prüfung“) ist im PR grün (erfüllt am 08.10.2026).
2. Stefanies Daten sind **vorher** aus der alten App gesichert und die Datei ist geprüft (Anleitung Schritt 1, inkl. zweiter Kopie und WhatsApp-Vorlage).
3. Der erste Build wird zunächst **auf deinem eigenen iPhone** mit einer Kopie der Sicherungsdatei getestet: Import, iCloud-Sicherung (Schritt 9) und Neuinstallation/Wiederherstellung (Schritt 10).
4. Erst danach Installation bei Stefanie; die alte App bleibt 2–4 Wochen als Rückfallebene erhalten.

**Merge nach `main`: noch nicht.** Erst nachdem Punkt 1–4 erfolgreich waren und die Pages-Quelle auf „GitHub Actions“ umgestellt ist (sonst ist die Web-Version nach dem Merge nicht erreichbar).
