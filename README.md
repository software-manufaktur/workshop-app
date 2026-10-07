# SeeYou Workshops

Termin- und Buchungsverwaltung für SeeYou-Workshops. Ein Code, zwei Ausgaben:

- **iOS-App** (Capacitor), verteilt über TestFlight, mit **automatischer Sicherung in iCloud Drive**
- **Web-App** (PWA) auf GitHub Pages, als Rückfallebene und für den Browser

## Funktionen

- Termine mit Kategorie, Plätzen, Notiz; automatische Archivierung 3 Tage nach Ende
- Buchungen mit Anrede, Telefon, E-Mail, Personen, Kontaktkanal, Notiz, Einwilligung für Feedback
- WhatsApp-Bestätigung mit einstellbarer Textvorlage
- **Feedback anfragen** nach dem Workshop: Teilnehmende nacheinander per WhatsApp oder E-Mail anschreiben, oder alle mit E-Mail auf einmal (BCC). Pro Buchung wird „angefragt“ vermerkt.
- Suche (auch nach Teilnehmenden), Filter, Kalender-Export (.ics), CSV-Export
- Sicherung: iOS automatisch nach jeder Änderung in `iCloud Drive → SeeYou Workshops` (eine Datei pro Tag, 60 Tage); Export/Import als JSON auf allen Plattformen. Sicherungen der alten Web-App lassen sich importieren.

## Entwicklung

```bash
npm install
npm run dev        # Entwicklungsserver
npm test           # Unit-Tests (Datenmigration, Vorlagen, Export)
npm run build      # Typecheck + Produktions-Build nach dist/
```

Aufbau:

| Datei | Inhalt |
|---|---|
| `src/model.ts` | Datenmodell, Defaults, Migration alter Datenstände |
| `src/format.ts` | Escaping, Datumsformat, Textvorlagen, CSV/ICS/mailto |
| `src/store.ts` | Zustand, Speichern, automatische iCloud-Sicherung |
| `src/platform.ts` | Unterschiede Web ↔ iOS (Speicher, Teilen, externe Links) |
| `src/main.ts` | Oberfläche |
| `ios/App/App/ICloudBackupPlugin.swift` | natives Plugin für iCloud Drive |

## Umstieg der bestehenden Daten

Die iOS-App hat einen eigenen Speicher und sieht die Daten der Web-App auf dem Home-Bildschirm **nicht**. Deshalb:

1. In der **alten** App: Menü → **Backup** → Datei in „Dateien“ / iCloud Drive sichern.
2. Neue iOS-App öffnen → Menü → **Sicherung** → **Sicherung importieren** → Datei wählen.
3. Prüfen, dass alles da ist. Die alte App erst danach vom Home-Bildschirm löschen.

Wird die neue Web-Version auf derselben Adresse veröffentlicht, übernimmt sie die alten Daten im Browser automatisch (die alten Schlüssel bleiben zur Sicherheit erhalten).

## iOS-App veröffentlichen (TestFlight)

Einmalige Einrichtung:

1. **Apple Developer Program** (99 €/Jahr) unter developer.apple.com.
2. **Identifiers → App IDs**: `de.seeyou.workshops` anlegen, Capability **iCloud** (mit CloudKit/iCloud Documents) aktivieren.
   **Identifiers → iCloud Containers**: `iCloud.de.seeyou.workshops` anlegen und der App ID zuweisen.
   (Andere Bundle-ID gewünscht? Dann in `capacitor.config.ts`, `ios/App/App.xcodeproj/project.pbxproj`, `ios/App/App/App.entitlements` und `ios/App/App/Info.plist` anpassen.)
3. **App Store Connect → Apps → +**: neue App mit dieser Bundle-ID anlegen (Name z. B. „SeeYou Workshops“; sie wird nicht im App Store veröffentlicht, nur per TestFlight genutzt).
4. **App Store Connect → Benutzer und Zugriff → Integrationen → App Store Connect API**: Schlüssel mit Rolle **Admin** erzeugen (nötig, damit die Signierung automatisch Zertifikate erstellen darf). `.p8`-Datei herunterladen.
5. Im GitHub-Repo unter **Settings → Secrets and variables → Actions** anlegen:
   - `APPLE_TEAM_ID` – Team-ID (developer.apple.com → Membership)
   - `ASC_KEY_ID` – Key-ID des API-Schlüssels
   - `ASC_ISSUER_ID` – Issuer-ID (steht über der Schlüsselliste)
   - `ASC_KEY_P8` – kompletter Inhalt der `.p8`-Datei

Neue Version bauen: **Actions → „iOS-App → TestFlight“ → Run workflow**. Nach ca. 10–20 Minuten (Apple-Verarbeitung) erscheint der Build in TestFlight. Deine Frau als **interne Testerin** eintragen; sie installiert die App über die TestFlight-App. Interne Builds laufen 90 Tage; vorher einfach einen neuen Build anstoßen.

Alternativ mit einem Mac: `npm run ios:sync && npm run ios:open`, in Xcode das Team wählen und auf das iPhone spielen oder über *Product → Archive* hochladen.

## Web-Version (GitHub Pages)

Einmalig: **Settings → Pages → Source: „GitHub Actions“**. Danach wird bei jedem Push auf `main` gebaut und veröffentlicht.
**Wichtig:** Diese Umstellung *vor* dem Merge machen, sonst liefert Pages die ungebauten Quelldateien aus.

## Datenschutz

- Alle Daten bleiben auf dem iPhone bzw. in Stefanies eigener iCloud. Es gibt keinen Server und keine Drittanbieter-Skripte; eine Content-Security-Policy verhindert das Nachladen fremden Codes.
- Feedback-Anfragen gelten rechtlich als Werbung. Deshalb gibt es bei jeder Buchung das Feld „Darf um Feedback gebeten werden“, und standardmäßig werden nur Kontakte mit Einwilligung angeschrieben.
- Der Standardtext ist neutral formuliert. Google verbietet es, nur zufriedene Kunden um eine Bewertung zu bitten („Review Gating“).
