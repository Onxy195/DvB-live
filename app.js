// ---------------------------------------------------------------------------
// DVB Live by ONXY
// Inoffizielle, undokumentierte VVO/DVB-WebAPI. Kann sich jederzeit ändern.
// Falls eine Anfrage leer bleibt: Antwort in der Konsole loggen (siehe fetchJSON)
// und Feldnamen unten anpassen.
// ---------------------------------------------------------------------------

const API_BASE = "https://webapi.vvo-online.de";
const DRESDEN_CENTER = [51.0504, 13.7373];
const HISTORY_KEY = "dvbStopHistory";
const HISTORY_MAX = 10;

// DHDN / Gauss-Krüger Zone 4 (EPSG:31468) — die VVO-API liefert Koordinaten in diesem
// System, nicht in WGS84. Umrechnung per proj4.
const GK4 = "+proj=tmerc +lat_0=0 +lon_0=12 +k=1 +x_0=4500000 +y_0=0 +ellps=bessel " +
            "+towgs84=612.4,77,440.2,-0.054,0.057,-2.797,2.55 +units=m +no_defs";

function gk4ToWgs84(rechtswert, hochwert) {
  const [lng, lat] = proj4(GK4, "WGS84", [rechtswert, hochwert]);
  return { lat, lng };
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return hash;
}

// Erzeugt aus Linie + Richtung eine feste Farbe. Wichtig: der Schlüssel enthält die
// Richtung (dep.direction), nicht nur die Liniennummer - "61 Bülau" und "61 Weißig"
// sind derselbe LineName, aber unterschiedliche Fahrten und sollen sich daher auch
// farblich unterscheiden lassen, sobald sich der Name (Linie+Ziel) unterscheidet.
function colorForRoute(line, direction) {
  const key = `${line}|${direction || ""}`;
  const h1 = hashString(key);
  const h2 = hashString(key.split("").reverse().join(""));
  const hue = Math.abs(h1) % 360;
  const sat = 62 + (Math.abs(h2) % 26);        // 62–88 %
  const light = 48 + (Math.abs(h1 >> 8) % 18); // 48–65 % - hält dunklen Text lesbar
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

let map, stopMarker;
let selectedStop = null;
let departures = [];
let departureTimer = null;

// Aktuell angezeigte Fahrt (immer höchstens eine - siehe showRouteForDeparture)
let routeLine = null;
let vehicleMarker = null;
let routeStopMarkers = [];
let highlightedKey = null;
let activeDep = null;  // die angeklickte Abfahrt - bleibt erhalten, auch wenn sie
                       // aus der Abfahrtstafel verschwindet (Bus schon weg)
let activeTrip = null; // { stops, routePoints, color, signature, finished, loading }
let showPastStops = false;     // Zustand der aufklappbaren "bereits gefahrenen" Halte
let showUpcomingStops = false; // Zustand der aufklappbaren "kommenden" Halte
                               // beide bewusst zugeklappt, bis der Nutzer sie öffnet
let tripRefreshTimer = null; // holt regelmäßig frische Echtzeit-Daten vom Server
let tripTickTimer = null;    // interpoliert zwischendurch clientseitig weiter (sanfte Bewegung)

// Verlauf: die zuletzt besuchten Haltestellen - bewusst schlicht (nur Name + Ort),
// keine Fahrt-Details mehr, damit die Liste sofort überschaubar bleibt.
let history = [];
let historyOpen = false;

// Merkt sich, für welche Haltestellen der aktuellen Fahrt die Ankunfts-Animation
// schon einmal gespielt wurde - so läuft sie pro Halt nur genau einmal, auch wenn
// die Marker bei jedem Server-Refresh neu gezeichnet werden.
let arrivedStopIds = new Set();

// ---------- API ----------

async function fetchJSON(path, body) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    // Browser verschleiert CORS-Fehler als generisches "Failed to fetch"
    throw new Error("Netzwerk/CORS-Fehler: " + networkErr.message);
  }
  if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText);
  return res.json();
}

// PointFinder: Haltestellensuche. Antwort-Punkte sind Pipe-getrennt:
// "id|type|city|name|Hochwert|Rechtswert|distanz||" (Koordinaten in GK4)
async function findStops(query) {
  const data = await fetchJSON("/tr/pointfinder", {
    query,
    stopsOnly: true,
  });
  return (data.Points || [])
    .map((line) => {
      const p = line.split("|");
      if (p.length < 6) return null;
      const hochwert = parseFloat(p[4]);
      const rechtswert = parseFloat(p[5]);
      if (Number.isNaN(hochwert) || Number.isNaN(rechtswert)) return null;
      const { lat, lng } = gk4ToWgs84(rechtswert, hochwert);
      return { id: p[0], name: p[3], city: p[2] || "Dresden", lat, lng };
    })
    .filter(Boolean);
}

// Departure Monitor: Echtzeit-Abfahrten je Haltestelle
async function getDepartures(stopId) {
  const data = await fetchJSON("/dm", {
    stopid: stopId,
    limit: 20,
    shorttermchanges: true,
    mentzonly: false,
    isarrival: false,
  });
  return (data.Departures || []).map((d) => {
    const scheduled = parseVvoDate(d.ScheduledTime);
    const real = parseVvoDate(d.RealTime) || scheduled;
    return {
      id: d.Id || crypto.randomUUID(),
      line: d.LineName || "?",
      direction: d.Direction || "",
      mot: d.Mot || "",
      platform: d.Platform ? d.Platform.Name : null,
      // Auslastung wird von der API nur für manche Fahrten geliefert
      // ("ManySeats" / "FewSeats" / "StandingOnly"); fehlt sie, zeigen wir nichts an.
      // Die API liefert dieses Feld unter unterschiedlichen Namen und manchmal
      // verschachtelt - hier alle bekannten Varianten abfragen, bevor wir aufgeben.
      occupancy: d.Occupancy || d.Properties?.Occupancy || d.VehicleInfo?.Occupancy || null,
      scheduled,
      real,
      // Rohe "/Date(...)/"-Strings, unverändert - /dm/trip braucht genau dieses Format
      // als "time", nicht ein neu formatiertes JS-Datum.
      realRaw: d.RealTime || d.ScheduledTime,
      scheduledRaw: d.ScheduledTime,
      delayMin: scheduled && real ? Math.round((real - scheduled) / 60000) : 0,
    };
  });
}

// Trip Monitor: Stationsliste + Routen-Geometrie eines konkreten Umlaufs.
// Richtiger Endpunkt ist /dm/trip (nicht /trm - das gibt es nicht).
// "tripid" identifiziert nur Linie+Richtung, nicht den einzelnen Umlauf - erst die
// Kombination aus stopid + time (Realtime dieser konkreten Abfahrt an dieser Haltestelle)
// wählt den richtigen Umlauf aus.
async function fetchTrip(dep, stopId) {
  return fetchJSON("/dm/trip", {
    tripid: dep.id,
    time: dep.realRaw || dep.scheduledRaw,
    stopid: stopId,
    mapdata: true,
  });
}

// .NET-Datumsformat "/Date(1699999999000+0200)/"
function parseVvoDate(raw) {
  if (!raw) return null;
  const match = raw.match(/\d+/);
  return match ? new Date(parseInt(match[0], 10)) : null;
}

function fmtTime(date) {
  return date ? date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "--:--";
}

// MapData kann laut Beobachtung entweder ein einzelner String
// "Tram|5654321|4621234|5654400|4621300|..." sein oder ein Array solcher Strings
// (ein Eintrag pro Teilstück). Beides abfangen.
function parseMapData(mapData) {
  if (!mapData) return [];
  const strings = Array.isArray(mapData) ? mapData : [mapData];
  const points = [];
  strings.forEach((str) => {
    if (typeof str !== "string") return;
    const coords = str.split("|").slice(1); // erstes Element ist das Verkehrsmittel, z.B. "Tram"
    for (let i = 0; i + 1 < coords.length; i += 2) {
      const hochwert = parseFloat(coords[i]);
      const rechtswert = parseFloat(coords[i + 1]);
      if (Number.isNaN(hochwert) || Number.isNaN(rechtswert)) continue;
      points.push(gk4ToWgs84(rechtswert, hochwert));
    }
  });
  return points;
}

// ---------- Fahrt-Identität ----------
//
// Der Grund für das frühere "Zurückspringen": /dm/trip wählt den Umlauf über
// tripid + stopid + time aus. Sobald die angeklickte Abfahrt an unserer Haltestelle
// vorbei ist, liefert derselbe Aufruf irgendwann den NÄCHSTEN Umlauf derselben Linie -
// und der steht natürlich wieder am Streckenanfang. Deshalb merken wir uns beim ersten
// Laden einen Fingerabdruck der Fahrt (erste/letzte Haltestelle + deren Sollzeiten) und
// verwerfen jede Aktualisierung, die nicht mehr dazu passt. Die angezeigte Fahrt bleibt
// dann eingefroren, statt sich in eine andere zu verwandeln.

// Manche Umläufe tragen die Auslastung an der einzelnen Haltestelle statt an der
// Abfahrt selbst - hier für die gesuchte Haltestelle nachschauen.
function occupancyFromTripStops(stops, stopId) {
  const match = (stops || []).find((s) => s.Id === stopId);
  return match ? (match.Occupancy || null) : null;
}

function tripSignature(stops) {
  const list = (stops || []).filter((s) => s.Id);
  if (!list.length) return null;
  const first = list[0];
  const last = list[list.length - 1];
  return `${first.Id}@${first.Time || first.RealTime || ""}>${last.Id}@${last.Time || last.RealTime || ""}`;
}

function lastStopTime(stops) {
  const times = (stops || [])
    .map((s) => parseVvoDate(s.RealTime || s.Time))
    .filter(Boolean);
  return times.length ? new Date(Math.max(...times)) : null;
}

// ---------- Positions-Interpolation ----------
//
// WICHTIG: Die abgefragte Haltestelle wird von der API immer selbst als
// Position="Current" markiert (so ist der Endpunkt dokumentiert) - ihre Koordinaten
// sind also die der Haltestelle, NICHT die eines fahrenden Fahrzeugs. Es gibt in dieser
// öffentlichen API keinen echten GPS-Live-Punkt. Was wir stattdessen tun: zwischen der
// zeitlich letzten und der nächsten Haltestelle der Fahrt interpolieren, nach Anteil der
// verstrichenen Zeit (Echtzeit inkl. Verspätung). Das ist eine Schätzung, keine echte
// Fahrzeugposition.
//
// Eine reine Luftlinie zwischen zwei Haltestellen schneidet aber oft sichtbar quer über
// Blöcke/Kurven hinweg ("Bus fährt querfeldein"). Stattdessen laufen wir entlang der
// tatsächlichen Routen-Geometrie (aus MapData) und interpolieren dort nach Bogenlänge -
// so bleibt der Marker "auf der Strecke".

function haversineMeters(a, b) {
  const R = 6371000;
  const latRad = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const dx = (b.lng - a.lng) * Math.PI / 180 * Math.cos(latRad) * R;
  const dy = (b.lat - a.lat) * Math.PI / 180 * R;
  return Math.sqrt(dx * dx + dy * dy);
}

function cumulativeDistances(routePoints) {
  const dist = [0];
  for (let i = 1; i < routePoints.length; i++) {
    dist.push(dist[i - 1] + haversineMeters(routePoints[i - 1], routePoints[i]));
  }
  return dist;
}

function nearestRouteIndex(routePoints, point) {
  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < routePoints.length; i++) {
    const d = haversineMeters(routePoints[i], point);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

function positionAtDistance(routePoints, cum, target) {
  if (target <= 0) return routePoints[0];
  const total = cum[cum.length - 1];
  if (target >= total) return routePoints[routePoints.length - 1];
  for (let i = 1; i < cum.length; i++) {
    if (target <= cum[i]) {
      const segLen = cum[i] - cum[i - 1];
      const frac = segLen === 0 ? 0 : (target - cum[i - 1]) / segLen;
      const a = routePoints[i - 1], b = routePoints[i];
      return { lat: a.lat + (b.lat - a.lat) * frac, lng: a.lng + (b.lng - a.lng) * frac };
    }
  }
  return routePoints[routePoints.length - 1];
}

// Fallback ohne Routengeometrie: einfache Luftlinie zwischen zwei Haltestellen.
function interpolateStraight(pts, now) {
  if (pts.length === 0) return null;
  if (now <= pts[0].t) return { lat: pts[0].lat, lng: pts[0].lng };
  const last = pts[pts.length - 1];
  if (now >= last.t) return { lat: last.lat, lng: last.lng };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (now >= a.t && now <= b.t) {
      const frac = b.t === a.t ? 0 : (now - a.t) / (b.t - a.t);
      return { lat: a.lat + (b.lat - a.lat) * frac, lng: a.lng + (b.lng - a.lng) * frac };
    }
  }
  return null;
}

function stopsToTimedPoints(stops) {
  return (stops || [])
    .map((s) => ({
      t: parseVvoDate(s.RealTime || s.Time),
      hochwert: s.Latitude,
      rechtswert: s.Longitude,
    }))
    .filter((p) => p.t && p.hochwert != null && p.rechtswert != null)
    .map((p) => ({ t: p.t, ...gk4ToWgs84(p.rechtswert, p.hochwert) }))
    .sort((a, b) => a.t - b.t);
}

function interpolatePositionOnRoute(stops, routePoints, now) {
  const pts = stopsToTimedPoints(stops);
  if (pts.length === 0) return null;
  if (routePoints.length < 2) return interpolateStraight(pts, now);

  const cum = cumulativeDistances(routePoints);
  const idxFor = (p) => nearestRouteIndex(routePoints, p);

  if (now <= pts[0].t) return positionAtDistance(routePoints, cum, cum[idxFor(pts[0])]);
  const last = pts[pts.length - 1];
  if (now >= last.t) return positionAtDistance(routePoints, cum, cum[idxFor(last)]);

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (now >= a.t && now <= b.t) {
      const frac = b.t === a.t ? 0 : (now - a.t) / (b.t - a.t);
      const ia = idxFor(a), ib = idxFor(b);
      if (ib <= ia) {
        // Reihenfolge auf der Linie unklar (z.B. Schleife/Wendeschleife) -> Luftlinie
        return { lat: a.lat + (b.lat - a.lat) * frac, lng: a.lng + (b.lng - a.lng) * frac };
      }
      const targetDist = cum[ia] + (cum[ib] - cum[ia]) * frac;
      return positionAtDistance(routePoints, cum, targetDist);
    }
  }
  return null;
}

// ---------- Karte ----------

function initMap() {
  const saxonyBounds = L.latLngBounds([50.15, 11.85], [51.75, 15.05]);
  map = L.map("map", {
    maxBounds: saxonyBounds,
    maxBoundsViscosity: 1.0,
    minZoom: 9,
    maxZoom: 19,
  }).setView(DRESDEN_CENTER, 13);

  // Esri-Kacheln - frei nutzbar, kein API-Key nötig.
  const tileOpts = {
    attribution: "Tiles &copy; Esri",
    maxZoom: 19,
    // Der Esri-Dienst liefert selbst nur bis Zoom 16 scharfe Kacheln; darüber
    // vergrößert Leaflet die Zoom-16-Kacheln automatisch (etwas unscharf, aber zoombar).
    maxNativeZoom: 16,
    bounds: saxonyBounds,
    keepBuffer: 4,
  };
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    tileOpts
  ).addTo(map);

  setupPanelToggle();
}

// Blendet die gesamte Leiste (Suche, Abfahrten, Verlauf) aus, sodass nur noch die
// Karte zu sehen ist - auf Wunsch sowohl am PC als auch auf dem Handy. Der Knopf
// bleibt dabei immer sichtbar auf der Karte, damit man die Leiste wieder einblenden
// kann. Leaflet muss nach der Größenänderung des Containers explizit informiert
// werden (invalidateSize), sonst bleiben Kacheln/Zentrierung auf dem alten Stand.
function setupPanelToggle() {
  const appEl = document.querySelector(".app");
  const btn = document.getElementById("panelToggle");
  let collapsed = false;

  btn.addEventListener("click", () => {
    collapsed = !collapsed;
    appEl.classList.toggle("panel-collapsed", collapsed);
    btn.setAttribute("aria-pressed", collapsed ? "true" : "false");
    btn.title = collapsed ? "Seitenleiste einblenden" : "Seitenleiste ausblenden";
    // Erst nach Ende der CSS-Transition (280ms) neu berechnen, sonst zoomt/zentriert
    // Leaflet noch auf Basis der alten, zwischenzeitlichen Containergröße.
    setTimeout(() => map.invalidateSize(), 300);
  });
}

function showStopOnMap(stop) {
  if (stopMarker) map.removeLayer(stopMarker);
  stopMarker = L.marker([stop.lat, stop.lng], {
    icon: L.divIcon({ className: "", html: '<div class="stop-icon"></div>', iconSize: [20, 20] }),
  }).addTo(map).bindPopup(stop.name);
  map.setView([stop.lat, stop.lng], 15);
}

// Blendet einen Leaflet-Layer sanft aus und entfernt ihn danach von der Karte.
function fadeOutLayer(layer, isMarker) {
  if (!layer) return;
  try {
    if (isMarker) layer.setOpacity(0);
    else layer.setStyle({ opacity: 0 });
  } catch { /* Layer evtl. schon entfernt */ }
  setTimeout(() => { try { map.removeLayer(layer); } catch { /* schon weg */ } }, 430);
}

// Entfernt Route, Fahrzeug-Marker und Haltestellen-Punkte der aktuell angeschauten
// Fahrt und stoppt deren Aktualisierung. Wird beim Abwählen, beim Wechsel auf eine
// andere Verbindung und beim Wechsel der Haltestelle aufgerufen - so bleibt nie ein
// "Geisterbus" auf der Karte stehen.
function clearActiveTrip(rerender = true) {
  clearInterval(tripRefreshTimer); tripRefreshTimer = null;
  clearInterval(tripTickTimer); tripTickTimer = null;

  fadeOutLayer(routeLine, false); routeLine = null;
  fadeOutLayer(vehicleMarker, true); vehicleMarker = null;

  routeStopMarkers.forEach((m) => map.removeLayer(m));
  routeStopMarkers = [];

  activeTrip = null;
  activeDep = null;
  highlightedKey = null;
  showPastStops = false;
  showUpcomingStops = false;
  arrivedStopIds = new Set();
  if (rerender) renderDepartures();
}

// Zeichnet kleine Punkte für alle Haltestellen der Fahrt (die gesuchte Haltestelle hat
// bereits ihren eigenen, deutlich größeren Marker und wird hier ausgelassen, damit sie
// die auffälligste bleibt). Bereits vergangene Halte werden gedimmt dargestellt.
function renderTripStops(stops, color) {
  const now = new Date();
  const seen = new Set();
  (stops || []).forEach((s) => {
    if (!s.Id || seen.has(s.Id)) return;
    if (selectedStop && s.Id === selectedStop.id) return;
    if (s.Latitude == null || s.Longitude == null) return;
    seen.add(s.Id);

    const { lat, lng } = gk4ToWgs84(s.Longitude, s.Latitude);
    const stopTime = parseVvoDate(s.RealTime || s.Time);
    const isPast = stopTime && stopTime < now;
    // Ankunfts-Animation: nur beim ERSTEN Mal abspielen, in dem ein Halt als
    // "vergangen" erkannt wird - danach bleibt er ruhig gedimmt stehen.
    const justArrived = isPast && !arrivedStopIds.has(s.Id);
    if (isPast) arrivedStopIds.add(s.Id);
    const marker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: "route-stop-wrap",
        html: `<div class="route-stop-dot${isPast ? " past" : ""}${justArrived ? " just-arrived" : ""}" style="background:${color};color:${color}"></div>`,
        iconSize: [10, 10],
      }),
    }).addTo(map);
    if (s.Name) {
      marker.bindTooltip(s.Name, { direction: "top", opacity: 0.9 });
      // Tooltips öffnen bei Leaflet standardmäßig nur bei Hover (mouseover) - auf
      // Touch-Geräten gibt es kein Hover, daher zusätzlich per Tap/Klick öffnen.
      marker.on("click", () => marker.openTooltip());
    }
    marker.stopId = s.Id;
    routeStopMarkers.push(marker);
  });
}

function focusStopOnMap(stopId) {
  const marker = routeStopMarkers.find((m) => m.stopId === stopId);
  if (marker) {
    map.panTo(marker.getLatLng());
    marker.openTooltip();
    return;
  }
  // Angeklickte Haltestelle ist die gesuchte selbst
  if (selectedStop && selectedStop.id === stopId) map.panTo([selectedStop.lat, selectedStop.lng]);
}

function placeVehicleMarker(pos, dep, color) {
  vehicleMarker = L.marker([pos.lat, pos.lng], {
    icon: L.divIcon({
      className: "vehicle-marker-wrap",
      html: `<div class="vehicle-icon" style="background:${color}">${dep.line}</div>`,
      iconSize: [34, 34],
    }),
    zIndexOffset: 1000,
    opacity: 0,
  }).addTo(map);
  requestAnimationFrame(() => vehicleMarker && vehicleMarker.setOpacity(1));
}

function markVehicleFinished() {
  if (!vehicleMarker) return;
  const el = vehicleMarker.getElement();
  const icon = el && el.querySelector(".vehicle-icon");
  if (icon) icon.classList.add("finished");
}

// Rechnet die Fahrzeugposition aus den zwischengespeicherten Trip-Daten neu aus und
// bewegt den Marker dorthin. Läuft öfter als der Server-Refresh, damit sich der Bus
// sichtbar/sanft bewegt statt alle 15 s zu springen - dank CSS-Transition auf
// .vehicle-marker-wrap wird der Weg zwischen zwei Positionen automatisch animiert.
function tickVehiclePosition() {
  if (!activeTrip || !vehicleMarker) return;
  const pos = interpolatePositionOnRoute(activeTrip.stops, activeTrip.routePoints, new Date());
  if (pos) vehicleMarker.setLatLng([pos.lat, pos.lng]);

  // Fahrt zu Ende? Dann Marker stilllegen und nicht weiter aktualisieren.
  const end = lastStopTime(activeTrip.stops);
  if (end && new Date() > end && !activeTrip.finished) {
    finishActiveTrip();
  }
}

function finishActiveTrip() {
  if (!activeTrip) return;
  activeTrip.finished = true;
  clearInterval(tripRefreshTimer); tripRefreshTimer = null;
  markVehicleFinished();
  renderDepartures();
}

// Holt frische Trip-Daten vom Server (aktualisierte Echtzeit/Verspätung, neue
// Haltestellen-Zeiten) und aktualisiert Route-Punkte + Fahrzeugposition entsprechend.
async function refreshActiveTrip(dep, stopId, color) {
  try {
    const data = await fetchTrip(dep, stopId);
    if (!activeTrip || highlightedKey !== depKey(dep)) return; // zwischenzeitlich gewechselt

    // Kern der Sprung-Vermeidung: liefert die API inzwischen einen anderen Umlauf
    // (weil "unser" Bus an der Haltestelle vorbei ist), verwerfen wir die Antwort
    // komplett und frieren die Anzeige auf dem letzten bekannten Stand ein.
    const sig = tripSignature(data.Stops);
    if (activeTrip.signature && sig && sig !== activeTrip.signature) {
      console.debug("[DVB] Anderer Umlauf erkannt - Anzeige wird eingefroren.");
      finishActiveTrip();
      return;
    }

    const routePoints = parseMapData(data.MapData);
    activeTrip.stops = data.Stops;
    if (routePoints.length > 1) activeTrip.routePoints = routePoints;

    const occFromTrip = occupancyFromTripStops(data.Stops, stopId);
    if (occFromTrip && activeDep) activeDep.occupancy = occFromTrip;

    routeStopMarkers.forEach((m) => map.removeLayer(m));
    routeStopMarkers = [];
    renderTripStops(data.Stops, color);
    tickVehiclePosition();
    renderDepartures();
  } catch (e) {
    console.warn("[DVB] Trip-Aktualisierung fehlgeschlagen für", dep.line, dep.direction, e.message);
  }
}

async function showRouteForDeparture(dep) {
  if (!selectedStop) return;
  const key = depKey(dep);
  // Erneuter Klick auf dieselbe Verbindung -> abwählen/zuklappen
  if (highlightedKey === key) { clearActiveTrip(); return; }

  clearActiveTrip(false); // vorherige Fahrt sofort ausblenden
  highlightedKey = key;
  activeDep = dep;
  activeTrip = { stops: [], routePoints: [], color: colorForRoute(dep.line, dep.direction), loading: true };
  showPastStops = false;
  showUpcomingStops = false;
  renderDepartures();

  try {
    const data = await fetchTrip(dep, selectedStop.id);
    if (highlightedKey !== key) return; // währenddessen schon wieder gewechselt

    const color = colorForRoute(dep.line, dep.direction);
    const routePoints = parseMapData(data.MapData);

    if (routePoints.length > 1) {
      routeLine = L.polyline(routePoints.map((p) => [p.lat, p.lng]), {
        color,
        weight: 5,
        opacity: 0,
        className: "route-line",
      }).addTo(map);
      requestAnimationFrame(() => routeLine && routeLine.setStyle({ opacity: 0.85 }));
      map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
    } else {
      console.debug("[DVB] Keine Routenpunkte aus MapData extrahiert:", data.MapData);
    }

    renderTripStops(data.Stops, color);
    activeTrip = {
      stops: data.Stops,
      routePoints,
      color,
      signature: tripSignature(data.Stops),
      finished: false,
      loading: false,
    };

    // Zusatz-Quelle für die Auslastung: /dm liefert sie kaum, /dm/trip manchmal pro
    // Haltestelle. Ist an unserer Haltestelle etwas hinterlegt, übernehmen wir es.
    const occFromTrip = occupancyFromTripStops(data.Stops, selectedStop.id);
    if (occFromTrip && activeDep) activeDep.occupancy = occFromTrip;

    const pos = interpolatePositionOnRoute(data.Stops, routePoints, new Date());
    if (pos) placeVehicleMarker(pos, dep, color);

    renderDepartures();

    tripTickTimer = setInterval(tickVehiclePosition, 1200);
    tripRefreshTimer = setInterval(() => refreshActiveTrip(dep, selectedStop.id, color), 15000);
  } catch (e) {
    console.warn("[DVB] Route konnte nicht geladen werden für", dep.line, dep.direction, e.message);
    if (highlightedKey === key) clearActiveTrip();
    showError("Route für Linie " + dep.line + " aktuell nicht verfügbar.");
  }
}

// ---------- Verlauf ----------
// Bewusst simpel gehalten: nur die zuletzt besuchten Haltestellen, kein Fahrt-Text,
// keine Zeiten/Verspätungen - ein Klick lädt einfach wieder diese Haltestelle.

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    history = raw ? JSON.parse(raw) : [];
  } catch { history = []; }
  if (!Array.isArray(history)) history = [];
}

function persistHistory() {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_MAX))); }
  catch { /* Speicher voll oder Privatmodus - Verlauf bleibt dann nur im Arbeitsspeicher */ }
}

// Trägt eine besuchte Haltestelle oben in den Verlauf ein (neueste zuerst, keine
// Duplikate, auf HISTORY_MAX begrenzt).
function addStopToHistory(stop) {
  const entry = { id: stop.id, name: stop.name, city: stop.city, lat: stop.lat, lng: stop.lng, visitedAt: Date.now() };
  history = [entry, ...history.filter((h) => h.id !== stop.id)].slice(0, HISTORY_MAX);
  persistHistory();
  renderHistory();
}

function reopenHistoryStop(entry) {
  selectStop({ id: entry.id, name: entry.name, city: entry.city, lat: entry.lat, lng: entry.lng });
}

// ---------- UI ----------

const searchSection = document.getElementById("searchSection");
const searchToggle = document.getElementById("searchToggle");
const searchBody = document.getElementById("searchBody");
const searchInput = document.getElementById("searchInput");
const resultsList = document.getElementById("resultsList");
const stopHeader = document.getElementById("stopHeader");
const stopNameEl = document.getElementById("stopName");
const departuresList = document.getElementById("departuresList");
const errorState = document.getElementById("errorState");
const clearStopBtn = document.getElementById("clearStop");
const historySection = document.getElementById("historySection");
const historyToggle = document.getElementById("historyToggle");
const historyListEl = document.getElementById("historyList");
const historyCountEl = document.getElementById("historyCount");

// Die Suche lässt sich ein- und ausklappen, damit sie auf dem Handy nicht dauerhaft
// den ganzen Bildschirm einnimmt. Nach Auswahl einer Haltestelle klappt sie
// automatisch zu; ein Klick auf den Kopf öffnet sie wieder.
let searchOpen = false;
function setSearchOpen(open) {
  searchOpen = open;
  searchBody.classList.toggle("collapsed", !open);
  searchToggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) setTimeout(() => searchInput.focus(), 260);
}
searchToggle.addEventListener("click", () => setSearchOpen(!searchOpen));

let searchDebounce = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  // Die VVO-API lehnt Suchanfragen unter 3 Zeichen mit HTTP 400 (ArgumentException) ab.
  if (q.length < 3) { resultsList.innerHTML = ""; hideError(); return; }
  searchDebounce = setTimeout(() => runSearch(q), 250);
});

async function runSearch(query) {
  try {
    const stops = await findStops(query);
    resultsList.innerHTML = "";
    stops.forEach((stop) => {
      const li = document.createElement("li");
      li.innerHTML = `${escapeHtml(stop.name)}<span class="city">${escapeHtml(stop.city)}</span>`;
      li.addEventListener("click", () => selectStop(stop));
      resultsList.appendChild(li);
    });
  } catch (e) {
    showError("Haltestellensuche fehlgeschlagen: " + e.message);
  }
}

function selectStop(stop) {
  selectedStop = stop;
  searchInput.value = stop.name;
  resultsList.innerHTML = "";
  stopNameEl.textContent = stop.name + ", " + stop.city;
  stopHeader.classList.remove("hidden");
  clearActiveTrip();
  showStopOnMap(stop);
  restartTimers();
  addStopToHistory(stop);
  setSearchOpen(false);
}

clearStopBtn.addEventListener("click", () => {
  selectedStop = null;
  departures = [];
  stopHeader.classList.add("hidden");
  departuresList.innerHTML = "";
  clearActiveTrip();
  clearInterval(departureTimer);
  searchInput.value = "";
  setSearchOpen(true);
});

historyToggle.addEventListener("click", () => {
  historyOpen = !historyOpen;
  renderHistory();
});

function restartTimers() {
  clearInterval(departureTimer);
  refreshDepartures();
  departureTimer = setInterval(refreshDepartures, 20000);
}

async function refreshDepartures() {
  if (!selectedStop) return;
  try {
    departures = await getDepartures(selectedStop.id);
    renderDepartures();
    hideError();
  } catch {
    showError("Abfahrten aktuell nicht verfügbar.");
  }
}

function depKey(dep) { return dep.id + "|" + dep.scheduledRaw; }

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Verspätungstext: positiv = später, negativ = früher als geplant.
function delayInfo(min) {
  if (min > 0) return { cls: "late", text: `+${min} min` };
  if (min < 0) return { cls: "early", text: `${min} min früher` };
  return { cls: "ontime", text: "pünktlich" };
}

// Auslastung liefert die API nur für einen Teil der Fahrten. Ist nichts da,
// zeigen wir bewusst nichts an, statt etwas zu erfinden.
const OCCUPANCY_LEVELS = {
  ManySeats:    { cls: "low",  bars: "▁▂",   label: "Niedrige Auslastung erwartet" },
  FewSeats:     { cls: "mid",  bars: "▁▂▄",  label: "Hohe Auslastung erwartet" },
  StandingOnly: { cls: "high", bars: "▁▂▄█", label: "⚠ Sehr hohe Auslastung erwartet" },
};

function occupancyHtml(occ) {
  const info = OCCUPANCY_LEVELS[occ];
  if (!info) return "";
  return `<span class="occ ${info.cls}" title="Auslastung: ${escapeHtml(info.label)}">
            <span class="bars">${info.bars}</span>${escapeHtml(info.label)}
          </span>`;
}

function renderDepartures() {
  departuresList.innerHTML = "";
  if (!selectedStop) return;

  const list = departures.slice();
  // Die angeklickte Fahrt verschwindet aus der Abfahrtstafel, sobald der Bus weg ist.
  // Damit "der Bus der Bus bleibt", hängen wir sie dann oben als abgefahrene Fahrt an,
  // statt die Auswahl einfach fallen zu lassen.
  if (activeDep && !list.some((d) => depKey(d) === depKey(activeDep))) {
    list.unshift(Object.assign({}, activeDep, { departed: true }));
  }

  list.forEach((dep) => departuresList.appendChild(buildDepartureItem(dep)));
}

function buildDepartureItem(dep) {
  const key = depKey(dep);
  const isActive = key === highlightedKey;
  const li = document.createElement("li");
  li.className = "dep-item" + (isActive ? " active" : "") + (dep.departed ? " departed" : "");

  const d = delayInfo(dep.delayMin || 0);
  const row = document.createElement("div");
  row.className = "departure";
  row.innerHTML = `
    <div class="line-badge" style="background:${colorForRoute(dep.line, dep.direction)}">${escapeHtml(dep.line)}</div>
    <div class="dep-info">
      <div class="direction"><span class="label">${escapeHtml(dep.direction)}</span></div>
      <div class="sub">
        ${dep.platform ? `<span>Steig ${escapeHtml(dep.platform)}</span>` : ""}
        ${dep.departed ? `<span class="tag">abgefahren</span>` : ""}
        ${occupancyHtml(dep.occupancy)}
      </div>
    </div>
    <div class="dep-time">
      <span class="clock">${fmtTime(dep.real)}</span>
      <span class="delay ${d.cls}">${d.text}</span>
    </div>`;
  row.addEventListener("click", () => showRouteForDeparture(dep));
  li.appendChild(row);

  if (isActive) li.appendChild(buildTripDetails());
  return li;
}

// Aufklappbare Haltestellen-Übersicht der gewählten Fahrt: gefahrene Halte (einklappbar),
// der nächste Halt und alle kommenden - jeweils mit Ist-Zeit und Verspätung.
function buildTripDetails() {
  const box = document.createElement("div");
  box.className = "trip-details";

  if (!activeTrip || activeTrip.loading) {
    box.innerHTML = `<p class="trip-hint">Haltestellen werden geladen …</p>`;
    return box;
  }

  const stops = (activeTrip.stops || []).filter((s) => s.Id);
  if (!stops.length) {
    box.innerHTML = `<p class="trip-hint">Für diese Fahrt liefert die API keine Haltestellenliste.</p>`;
    return box;
  }

  const now = new Date();
  const enriched = stops.map((s) => {
    const sched = parseVvoDate(s.Time);
    const real = parseVvoDate(s.RealTime) || sched;
    return {
      id: s.Id,
      name: s.Name || "",
      place: s.Place || "",
      sched,
      real,
      delay: sched && real ? Math.round((real - sched) / 60000) : 0,
      past: real ? real < now : false,
    };
  });

  const past = enriched.filter((s) => s.past);
  const upcoming = enriched.filter((s) => !s.past);

  if (activeTrip.finished) {
    box.insertAdjacentHTML("beforeend",
      `<p class="trip-hint">Diese Fahrt ist beendet – die Anzeige bleibt auf dem letzten Stand stehen
       und liegt jetzt unter „Frühere Verbindungen“.</p>`);
  }

  if (past.length) {
    box.appendChild(buildSectionToggle(
      `${past.length} bereits gefahrene Haltestellen`,
      showPastStops,
      () => { showPastStops = !showPastStops; renderDepartures(); }
    ));
    if (showPastStops) {
      box.insertAdjacentHTML("beforeend", `<div class="tl-divider">Bereits gefahren</div>`);
      box.appendChild(buildTimeline(past, false));
    }
  }

  if (upcoming.length) {
    box.appendChild(buildSectionToggle(
      `${upcoming.length} kommende Haltestellen`,
      showUpcomingStops,
      () => { showUpcomingStops = !showUpcomingStops; renderDepartures(); }
    ));
    if (showUpcomingStops) {
      box.insertAdjacentHTML("beforeend", `<div class="tl-divider">Noch vor uns</div>`);
      box.appendChild(buildTimeline(upcoming, true));
    }
  } else {
    box.insertAdjacentHTML("beforeend", `<p class="trip-hint">Endstation erreicht.</p>`);
  }

  return box;
}

// Ein- und Ausklapper für die beiden Haltestellenlisten. Beide starten zugeklappt,
// damit ein Klick auf eine Verbindung nicht sofort den ganzen Bildschirm füllt.
function buildSectionToggle(label, open, onToggle) {
  const btn = document.createElement("button");
  btn.className = "past-toggle" + (open ? " open" : "");
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.textContent = `${open ? "▾" : "▸"} ${label} ${open ? "ausblenden" : "anzeigen"}`;
  btn.addEventListener("click", (e) => { e.stopPropagation(); onToggle(); });
  return btn;
}

function buildTimeline(stops, markNext) {
  const ul = document.createElement("ul");
  ul.className = "timeline";
  stops.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "tl-stop" + (s.past ? " past" : "") + (markNext && i === 0 ? " next" : "");
    const d = delayInfo(s.delay);
    const showSched = s.delay !== 0 && s.sched;
    li.innerHTML = `
      <span class="tl-name">${escapeHtml(s.name)}${s.place && s.place !== "Dresden" ? `<span class="tag" style="margin-left:6px">${escapeHtml(s.place)}</span>` : ""}</span>
      <span class="tl-times">
        ${showSched ? `<span class="sched-strike">${fmtTime(s.sched)}</span>` : ""}
        <span>${fmtTime(s.real)}</span>
        <span class="d-${d.cls}"> ${s.delay === 0 ? "" : d.text}</span>
      </span>`;
    li.title = s.delay === 0 ? "pünktlich" : d.text;
    li.addEventListener("click", (e) => { e.stopPropagation(); focusStopOnMap(s.id); });
    ul.appendChild(li);
  });
  return ul;
}

// Zeitangabe fürs Verlauf: relativ für die letzten Stunden, sonst Datum + Uhrzeit -
// das ist auf einen Blick lesbarer als ein reiner Zeitstempel.
function relativeOrDate(ts) {
  const d = new Date(ts);
  const diffMin = Math.round((Date.now() - ts) / 60000);
  if (diffMin < 1) return "gerade eben";
  if (diffMin < 60) return `vor ${diffMin} min`;
  if (diffMin < 24 * 60) return `vor ${Math.round(diffMin / 60)} Std.`;
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

function renderHistory() {
  if (!history.length) { historySection.classList.add("hidden"); return; }
  historySection.classList.remove("hidden");
  historyCountEl.textContent = history.length;
  historyToggle.setAttribute("aria-expanded", historyOpen ? "true" : "false");
  historyListEl.classList.toggle("hidden", !historyOpen);
  if (!historyOpen) return;

  historyListEl.innerHTML = "";
  history.forEach((entry, i) => {
    const li = document.createElement("li");
    if (selectedStop && selectedStop.id === entry.id) li.className = "active";
    li.innerHTML = `
      <div>
        <div class="h-dir">${escapeHtml(entry.name)}</div>
        <div class="h-meta">${escapeHtml(entry.city)}</div>
      </div>
      <div class="h-time">${i === 0 ? "zuletzt besucht" : relativeOrDate(entry.visitedAt)}</div>`;
    li.addEventListener("click", () => reopenHistoryStop(entry));
    historyListEl.appendChild(li);
  });

  const clear = document.createElement("button");
  clear.className = "history-clear";
  clear.textContent = "Verlauf löschen";
  clear.addEventListener("click", () => {
    history = [];
    persistHistory();
    historyListEl.innerHTML = "";
    historySection.classList.add("hidden");
  });
  historyListEl.appendChild(clear);
}

function showError(msg) {
  errorState.textContent = msg;
  errorState.classList.remove("hidden");
}
function hideError() { errorState.classList.add("hidden"); }

initMap();
loadHistory();
renderHistory();
