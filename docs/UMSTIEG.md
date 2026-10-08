# Umstieg auf die iOS-App – Schritt für Schritt

Diese Anleitung führt durch den kompletten Umstieg von der bisherigen Web-App (Icon auf dem Home-Bildschirm) auf die neue iOS-App mit automatischer iCloud-Sicherung.

**Grundregel:** Die alte App bleibt unverändert und wird erst gelöscht, wenn die neue App nachweislich alle Daten hat und die iCloud-Sicherung funktioniert (Schritt 10). Bis dahin ist nichts verloren, egal was schiefgeht.

| Schritt | Wer | Dauer |
|---|---|---|
| 1. Bestehende Daten sichern | Stefanie (mit dir) | 10 Min. |
| 2. Apple Developer einrichten | du | 30 Min. + bis zu 2 Tage Freischaltung |
| 3. App Store Connect & TestFlight | du | 20 Min. |
| 4. API-Schlüssel erzeugen | du | 5 Min. |
| 5. GitHub-Secrets eintragen | du | 5 Min. |
| 6. iOS-Build starten | du | 5 Min. + ca. 30 Min. Wartezeit |
| 7. Installation bei Stefanie | Stefanie | 10 Min. |
| 8. Daten importieren | Stefanie (mit dir) | 15 Min. |
| 9. iCloud-Sicherung prüfen | Stefanie | 5 Min. |
| 10. Wiederherstellung testen | Stefanie (mit dir) | 10 Min. |

---

## 1. Sicherung der bestehenden Web-App auf dem iPhone

Auf **Stefanies iPhone**, in der **alten App** (Icon auf dem Home-Bildschirm öffnen, **nicht** die Webseite in Safari – Safari hat einen eigenen, leeren Speicher).

1. Menü **☰** → **Backup** tippen.
2. iOS fragt nach dem Herunterladen bzw. zeigt die Datei an:
   - Bei „Laden“/„Download“: bestätigen. Die Datei liegt dann in der **Dateien**-App unter **Downloads**.
   - Wird die Datei angezeigt: unten **Teilen** (Quadrat mit Pfeil) → **In „Dateien“ sichern** → **iCloud Drive** wählen → **Sichern**.
3. In der **Dateien**-App prüfen: Es gibt eine Datei `seeyou_backup_JJJJ-MM-TT.json` mit mehr als 0 KB. Antippen zeigt Text, in dem u. a. `"slots"` und `"bookings"` vorkommen.
4. **Zweite Kopie:** Die Datei lange drücken → **Teilen** → per E-Mail an dich selbst schicken.
5. **WhatsApp-Vorlage sichern** (steckt *nicht* in der Backup-Datei): In der alten App **☰ → Einstellungen** öffnen, den Text komplett markieren → **Kopieren** → in eine Notiz einfügen. Alternativ einen Screenshot machen.
6. Zur Sicherheit von der Terminliste ein paar Screenshots machen (Anzahl der Termine und Buchungen merken).

> Klappt Schritt 2 nicht (es passiert nichts): **nicht weitermachen** und nichts löschen. Die Daten liegen dann weiter sicher in der alten App, das Problem muss erst gelöst werden.

---

## 2. Apple-Developer-Konfiguration

1. Auf [developer.apple.com/programs](https://developer.apple.com/programs/) mit deiner Apple-ID dem **Apple Developer Program** beitreten (Einzelperson, 99 €/Jahr). Die Freischaltung kann bis zu 48 Stunden dauern.
2. Nach der Freischaltung: [developer.apple.com/account](https://developer.apple.com/account) → **Membership details** → **Team ID** notieren (10 Zeichen, z. B. `AB12CD34EF`).
3. **Certificates, Identifiers & Profiles → Identifiers → +**
   - **iCloud Containers** wählen → Beschreibung `SeeYou Workshops`, Identifier `iCloud.de.seeyou.workshops` → **Register**.
4. **Identifiers → +** → **App IDs** → **App**
   - Description: `SeeYou Workshops`
   - Bundle ID: **Explicit** `de.seeyou.workshops`
   - Unter **Capabilities** **iCloud** anhaken (inkl. CloudKit/iCloud Documents) → **Continue → Register**.
5. Die eben angelegte App-ID öffnen → bei **iCloud** auf **Configure/Edit** → den Container `iCloud.de.seeyou.workshops` anhaken → **Save**.

Zertifikate und Provisioning Profiles musst du **nicht** anlegen. Das übernimmt der Build automatisch über den API-Schlüssel (Schritt 4).

> Andere Bundle-ID gewünscht? Dann vorher im Code an vier Stellen ändern: `capacitor.config.ts`, `ios/App/App.xcodeproj/project.pbxproj`, `ios/App/App/App.entitlements`, `ios/App/App/Info.plist` sowie `ios/App/App/SeeYouStoragePlugin.swift` (`containerId`).

---

## 3. App Store Connect und TestFlight

1. [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Apps → + → Neue App**
   - Plattform: iOS · Name: z. B. `SeeYou Workshops intern` (muss im App Store eindeutig sein; die App wird **nicht** veröffentlicht)
   - Primäre Sprache: Deutsch · Bundle-ID: `de.seeyou.workshops` · SKU: `seeyou-workshops` · Voller Zugriff
2. **Stefanie als Testerin einladen:** **Benutzer und Zugriff → +** → ihre Apple-ID-E-Mail-Adresse, Rolle z. B. **Kundensupport** (jede Rolle erlaubt internes Testen). Stefanie bekommt eine E-Mail und muss die Einladung **annehmen**.
3. Nach dem ersten Build (Schritt 6): **Apps → SeeYou → TestFlight → Interne Tests → +** → Gruppe `Familie` anlegen, **Automatische Verteilung** einschalten, Stefanie (und dich) hinzufügen.

Für internes TestFlight ist **keine** App-Prüfung durch Apple nötig.

---

## 4. App-Store-Connect-API-Schlüssel

1. **Benutzer und Zugriff → Integrationen → App Store Connect API → Team-Schlüssel → +**
2. Name `GitHub Build`, Zugriff **Admin**. Admin ist nötig, damit der Build Zertifikate und Profile automatisch anlegen darf.
3. **Schlüssel herunterladen** (`AuthKey_XXXXXXXXXX.p8`). Das geht **nur einmal**, also die Datei sicher aufbewahren.
4. Notieren: **Schlüssel-ID** (in der Liste) und **Issuer-ID** (oben über der Liste).

---

## 5. GitHub-Secrets

Im Repository `software-manufaktur/workshop-app` → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Inhalt |
|---|---|
| `APPLE_TEAM_ID` | Team-ID aus Schritt 2.2 |
| `ASC_KEY_ID` | Schlüssel-ID aus Schritt 4 |
| `ASC_ISSUER_ID` | Issuer-ID aus Schritt 4 |
| `ASC_KEY_P8` | kompletter Inhalt der `.p8`-Datei (mit Texteditor öffnen, **alles** inkl. `-----BEGIN PRIVATE KEY-----` und `-----END PRIVATE KEY-----` kopieren) |

---

## 6. iOS-Build erzeugen

**Vor dem Merge (empfohlen, so bleibt die Web-Version unverändert):**

1. Pull Request **#1** öffnen → rechts **Labels** → Label **`testflight`** setzen. Falls es noch nicht existiert: unter **Issues → Labels → New label** mit genau diesem Namen anlegen.
2. Unter **Actions → iOS-App** startet der Job **„Build & Upload zu TestFlight“** (ca. 15–25 Min.).
3. Grün ✅: Nach weiteren 10–30 Min. Verarbeitung erscheint der Build in **App Store Connect → TestFlight**. Beim ersten Mal ggf. die Frage zur **Exportkonformität** beantworten („Nein, keine Verschlüsselung“; sie ist eigentlich schon in der App hinterlegt).
4. Neuer Build: Label entfernen und wieder setzen.

**Nach dem Merge:** **Actions → iOS-App → Run workflow**.

Bei jeder Änderung am iOS-Teil im Pull Request läuft außerdem automatisch eine **Kompilier-Prüfung** (ohne Signierung).

| Fehlermeldung im Build | Ursache / Lösung |
|---|---|
| `Fehlende Secrets` | Schritt 5 prüfen (Schreibweise der Namen) |
| `No profiles for 'de.seeyou.workshops'` / `No Accounts` | API-Schlüssel hat nicht die Rolle **Admin**, oder Team-ID falsch |
| `iCloud-Container fehlt im Provisioning Profile` | Schritt 2.3–2.5: Container anlegen **und** der App-ID zuweisen |
| `No suitable application records were found` | Schritt 3.1: App in App Store Connect fehlt oder Bundle-ID abweichend |
| `The bundle version must be higher` | Build einfach erneut starten (Build-Nummer steigt automatisch) |

> Hinweis zu den Kosten: Bei privaten Repositories zählen macOS-Minuten in GitHub Actions zehnfach. Ein Build braucht ca. 20 Minuten, also ca. 200 Freiminuten.

---

## 7. Installation bei Stefanie

1. Auf Stefanies iPhone prüfen: **Einstellungen → [ihr Name] → iCloud → iCloud Drive** ist **an**.
2. Aus dem App Store die App **TestFlight** installieren und mit **ihrer** Apple-ID anmelden.
3. In TestFlight erscheint **SeeYou** → **Installieren**.
4. Die neue App heißt auf dem Home-Bildschirm **„SeeYou“**. Die alte Web-App bleibt daneben bestehen.

---

## 8. Datenimport

1. Neue App öffnen. Es erscheint die Karte **„Willkommen!“** → **Sicherung importieren**.
2. **Sicherung importieren …** → die Datei `seeyou_backup_….json` aus Schritt 1 wählen (Dateien → iCloud Drive bzw. Downloads).
3. Die App zeigt **vor** der Übernahme, was in der Datei steckt: „enthält X Termine, Y Buchungen“ und gegebenenfalls Hinweise (z. B. Buchungen ohne passenden Termin, die als „Unbekannter Termin“ im Archiv landen). **Nichts wird verworfen.** Unlesbare Einträge werden aufbewahrt und unter **Menü → Sicherung** angezeigt.
4. Zahlen mit der alten App bzw. den Screenshots vergleichen → **Wiederherstellen**.
5. **Einstellungen** öffnen:
   - WhatsApp-Vorlage aus der Notiz (Schritt 1.5) einfügen.
   - Link zur Google-Bewertung eintragen (Google-Unternehmensprofil → „Nach Rezensionen fragen“ → Link kopieren).
   - **Speichern**.
6. Stichproben: Drei Termine und deren Buchungen (Namen, Telefonnummern, Notizen, Personenzahl) mit der alten App vergleichen.

---

## 9. Prüfung der iCloud-Sicherung

1. In der neuen App eine Kleinigkeit ändern (z. B. Notiz an einem Termin) und speichern.
2. Unter der Kopfzeile erscheint nach wenigen Sekunden **„☁️ Automatisch in iCloud gesichert · gerade eben“**.
   - Gelber Hinweis **„iCloud Drive nicht verfügbar“**: Schritt 7.1 prüfen, außerdem **Einstellungen → [Name] → iCloud → Apps, die iCloud verwenden → SeeYou** einschalten. Die Sicherungen liegen bis dahin auf dem iPhone und werden später automatisch nach iCloud übertragen.
   - Roter Hinweis: Er nennt den Fehler und den Zeitpunkt des nächsten automatischen Versuchs.
3. **Dateien**-App → **iCloud Drive** → Ordner **„SeeYou Workshops“** → Datei `SeeYou-Sicherung-JJJJ-MM-TT.json` ist vorhanden. Der Ordner erscheint beim ersten Mal manchmal erst nach ein, zwei Minuten.
4. In der App: **Menü → Sicherung** zeigt alle Sicherungen. Nach dem Import steht dort auch ein **Wiederherstellungspunkt** (falls vorher schon Daten da waren).

So funktioniert die Sicherung im Alltag:

- Nach jeder Änderung wird automatisch gesichert, eine Datei pro Tag mit Änderungen, 60 Tage lang (mindestens die letzten 10 bleiben immer).
- Vor **Import, Wiederherstellung und Löschen eines Termins** entsteht zusätzlich ein **Wiederherstellungspunkt**, der nie überschrieben wird.
- Ein leerer Datenstand wird nie gesichert, und eine vorhandene Sicherung wird nie durch einen älteren oder kleineren Stand ersetzt, ohne dass der alte Inhalt vorher als Wiederherstellungspunkt erhalten bleibt.

---

## 10. Wiederherstellung nach Neuinstallation (einmal testen!)

Am besten direkt nach Schritt 9, solange die alte App noch existiert:

1. In der neuen App: **Menü → Sicherung → Jetzt sichern**, dann prüfen, dass die Datei in iCloud Drive liegt (Schritt 9.3).
2. Neue App **löschen** (Icon lange drücken → App entfernen → **App löschen**).
3. In **TestFlight** erneut **Installieren** und öffnen.
4. Die App zeigt **„Suche nach vorhandenen Sicherungen in iCloud …“** und dann **„Sicherung gefunden“** mit Datum und Anzahl.
5. **Wiederherstellen …** → Zahlen prüfen → bestätigen. Ohne diese Bestätigung wird nie etwas automatisch übernommen.
6. Alles da? Dann ist der Umstieg abgeschlossen.

Jede andere Sicherung lässt sich jederzeit über **Menü → Sicherung** wiederherstellen.

---

## Danach

- **Alte App:** 2–4 Wochen als Rückfallebene behalten, dort aber **nichts mehr eintragen**. Danach vom Home-Bildschirm löschen.
- **TestFlight-Builds laufen nach 90 Tagen ab.** Spätestens alle 2–3 Monate einen neuen Build starten (Schritt 6). Ein Update behält alle Daten. Kalender-Erinnerung setzen!
- **Apple Developer Program** jährlich verlängern. Ohne Mitgliedschaft lassen sich keine neuen Builds mehr erstellen; die Sicherungen in iCloud bleiben trotzdem erhalten und lesbar (JSON).
- **Web-Version / Merge:** Erst wenn die iOS-App einige Wochen problemlos läuft. Vor dem Merge unter **Settings → Pages → Source** auf **GitHub Actions** umstellen.
