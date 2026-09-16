[README.md](https://github.com/user-attachments/files/32275269/README.md)
# DvB-live
Meine eigene DVB-App: Echtzeit-Abfahrten in Dresden auf der Karte verfolgen, Verspätungen und Auslastung im Blick behalten, komplette Haltestellenliste jeder Fahrt aufklappen. Läuft auf jedem Gerät, egal ob Hoch- oder Querformat.
# DVB Live by ONXY

Eine kleine Web-App für Echtzeit-Abfahrten von Bus und Bahn in Dresden – auf einer
interaktiven Karte, mit Verspätungen, Auslastungsprognose und der kompletten
Haltestellenliste jeder Fahrt zum Aufklappen.

Kein Build-Prozess, kein Framework, kein API-Key nötig – drei Dateien, direkt im
Browser lauffähig.

## Funktionen

- **Live-Abfahrten** für jede Haltestelle in Dresden, inkl. Steig, Verspätung
  (oder "früher als geplant") und – sofern von der VVO-API geliefert – einer
  Auslastungsprognose ("Niedrige/Hohe/Sehr hohe Auslastung erwartet").
- **Fahrt auf der Karte verfolgen**: Klick auf eine Abfahrt zeigt die Route,
  einen sich bewegenden Fahrzeug-Marker sowie alle Haltestellen der Fahrt.
- **Aufklappbare Haltestellenliste** je Fahrt: bereits gefahrene und kommende
  Halte getrennt, mit Ist-Zeit, durchgestrichener Sollzeit und Verspätung.
  Ein Tap auf einen Kartenpunkt zeigt zusätzlich den Namen der Haltestelle.
- **Stabile Fahrten**: Läuft eine Fahrt aus (z. B. weil ein neuer Umlauf
  derselben Linie beginnt), bleibt die Anzeige auf dem letzten Stand stehen,
  statt auf die neue Fahrt "zurückzuspringen".
- **Verlauf**: die zuletzt besuchten Haltestellen werden lokal im Browser
  gespeichert (`localStorage`) und lassen sich mit einem Klick erneut öffnen.
- **Ein-/ausklappbare Suche** sowie eine Karte-Vollbild-Funktion (Leiste
  komplett ausblenden) – beides auch auf dem Handy.
- **Responsive**: eigene Layouts für Desktop, Handy-Hochformat und
  Handy-Querformat.

## Verwendung

Die App braucht keinen Server und keine Installation:

1. Die drei Dateien (`index.html`, `app.js`, `styles.css`) in einen gemeinsamen
   Ordner legen.
2. `index.html` im Browser öffnen – oder den Ordner auf einen beliebigen
   Webspace (Netlify, GitHub Pages, eigener Server o. Ä.) hochladen.
3. Oben eine Haltestelle suchen (mind. 3 Zeichen) und auswählen.

## Technischer Aufbau

| Datei | Zweck |
|---|---|
| `index.html` | Grundgerüst der Seite (Suche, Abfahrtsliste, Karte) |
| `app.js` | Sämtliche Logik: API-Anfragen, Kartendarstellung, Zustand |
| `styles.css` | Design, Farben, responsives Layout |

**Kartenmaterial:** Esri "World Dark Gray"-Kacheln (kostenlos, kein API-Key).

**Datenquelle:** die inoffizielle, undokumentierte WebAPI der VVO/DVB
(`webapi.vvo-online.de`). Da sie öffentlich, aber nicht offiziell dokumentiert
ist, kann sich ihr Verhalten jederzeit ändern. Wichtige Endpunkte:

- `POST /tr/pointfinder` – Haltestellensuche
- `POST /dm` – Echtzeit-Abfahrten einer Haltestelle
- `POST /dm/trip` – Haltestellenliste und Routen-Geometrie einer einzelnen Fahrt

Koordinaten liefert die API im Gauß-Krüger-System (EPSG:31468, Zone 4); die
Umrechnung nach WGS84 (für Leaflet) übernimmt `proj4.js`.

**Fahrzeugposition:** Es gibt in dieser öffentlichen API keinen echten
GPS-Punkt des Fahrzeugs. Die App schätzt die Position, indem sie zwischen der
zuletzt erreichten und der nächsten Haltestelle entlang der tatsächlichen
Routen-Geometrie interpoliert (nicht per Luftlinie).

## Bekannte Einschränkungen

- Die Auslastungsprognose wird von der VVO-API nur für einen Teil der Fahrten
  geliefert (häufiger bei Bahnen als bei Bussen). Fehlt sie, zeigt die App
  bewusst nichts an, statt einen Wert zu erfinden.
- Die Fahrzeugposition ist eine Schätzung auf Basis der Fahrplandaten, kein
  echtes GPS-Tracking.
- Da es sich um eine inoffizielle API handelt, kann sie sich ohne Vorankündigung
  ändern und die App dadurch beeinträchtigen.

## Lizenz / Hinweis

Privates Hobby-Projekt, nicht offiziell mit der DVB/VVO verbunden. Kartendaten
© Esri, © OpenStreetMap-Mitwirkende; Fahrplandaten © VVO.
