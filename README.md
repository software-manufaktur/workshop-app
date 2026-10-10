# SeeYou Workshops

Termin- und Buchungsverwaltung für SeeYou-Workshops. Ein Code, zwei Ausgaben:

- **iOS-App** (Capacitor), verteilt über TestFlight, mit **automatischer Sicherung in iCloud Drive**
- **Web-App** (PWA) auf GitHub Pages, als Rückfallebene und für den Browser

## Funktionen

- Termine mit Kategorie, Plätzen, Notiz; automatische Archivierung 3 Tage nach Ende
- Buchungen mit Anrede, Telefon, E-Mail, Personen, Kontaktkanal, Notiz, Einwilligung für Feedback (mit Zeitpunkt)
- WhatsApp-Bestätigung mit einstellbarer Textvorlage
- **Feedback anfragen** nach dem Workshop: Teilnehmende nacheinander per WhatsApp oder E-Mail anschreiben, oder alle mit E-Mail auf einmal (BCC). Pro Buchung wird „angefragt“ vermerkt.
- Suche (auch nach Teilnehmenden), Filter, Kalender-Export (.ics), CSV-Export
- **Sicherung (iOS):**
  - nach jeder Änderung automatisch in `iCloud Drive → SeeYou Workshops` (Tagessicherungen, 60 Tage)
  - unveränderliche Wiederherstellungspunkte vor Import, Wiederherstellung und Löschen
  - lokaler Fallback ohne iCloud mit späterer Übertragung
  - Wiederherstellung nach Neuinstallation (nur nach Bestätigung)
- Export/Import als JSON auf allen Plattformen; Sicherungen der alten Web-App werden vollständig übernommen.

**Umstieg Schritt für Schritt:** [docs/UMSTIEG.md](docs/UMSTIEG.md) · **Review & Testergebnisse:** [docs/REVIEW-BERICHT.md](docs/REVIEW-BERICHT.md)

## Entwicklung

```bash
npm install
npm run dev        # Entwicklungsserver
npm test           # Unit-Tests (Speicher, Sicherung, Migration, Vorlagen, Export)
npm run build      # Typecheck + Produktions-Build nach dist/
npm run e2e        # Ende-zu-Ende-Tests im Browser (vorher bauen)
ios/native-tests/run.sh   # Dateilogik des Swift-Plugins (benötigt Swift-Toolchain, z. B. Docker swift:6.1)
```

Aufbau:

| Datei | Inhalt |
|---|---|
| `src/model.ts` | Datenmodell, Migration/Prüfbericht (es geht nichts verloren) |
| `src/store.ts` | Zustand: serialisiertes, atomares Speichern, Beschädigungsschutz |
| `src/backup.ts` | Tagessicherungen, Wiederherstellungspunkte, Rotation, Wiederholung |
| `src/storage.ts` | Speicher-Schnittstellen + Web-Implementierung (localStorage) |
| `src/platform.ts` | iOS-Anbindung (natives Plugin), Teilen, externe Links |
| `src/format.ts` | Escaping, Datumsformat, Textvorlagen, CSV/ICS/mailto |
| `src/main.ts` | Oberfläche |
| `ios/App/App/SeeYouStoragePlugin.swift` | natives Plugin: App-Zustand + iCloud-Drive-Sicherungen |
| `.github/workflows/ios.yml` | Kompilier-Prüfung im PR, TestFlight-Upload (Label `testflight` oder manuell) |

## iOS-Build, TestFlight, Web-Version

Siehe [docs/UMSTIEG.md](docs/UMSTIEG.md): Apple-Developer-Konfiguration, App Store Connect, GitHub-Secrets, Build vor dem Merge per Label `testflight`, Installation, Datenimport und Prüfung der Sicherung.
Die Web-Version wird nach dem Merge über `.github/workflows/pages.yml` veröffentlicht (vorher **Settings → Pages → Source: „GitHub Actions“** einstellen).

## Datenschutz

- Alle Daten bleiben auf dem iPhone bzw. in Stefanies eigener iCloud. Es gibt keinen Server und keine Drittanbieter-Skripte; eine Content-Security-Policy verhindert das Nachladen fremden Codes.
- Feedback-Anfragen gelten rechtlich als Werbung. Deshalb gibt es bei jeder Buchung das Feld „Darf um Feedback gebeten werden“, und standardmäßig werden nur Kontakte mit Einwilligung angeschrieben.
- Der Standardtext ist neutral formuliert. Google verbietet es, nur zufriedene Kunden um eine Bewertung zu bitten („Review Gating“).
