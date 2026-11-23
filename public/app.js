const dark = matchMedia('(prefers-color-scheme: dark)').matches;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const clock = (t) => new Date(t * 1000).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
const keyOf = (x) => `${x.operator}|${x.mode}|${x.line}`; // same as lineKey in server.js
const MODE_ORDER = { metro: 0, tram: 1, bus: 2, ferry: 3, train: 4 };
const MODE_NAME = { metro: 'Metro', tram: 'Tram', bus: 'Bus', ferry: 'Veerboot', train: 'Trein' };
const EMPTY = { type: 'FeatureCollection', features: [] };

// Time from the server, not this device: a viewer's clock can be minutes off, and every prediction
// counts from "now". Each clock message gives serverTime − localTime minus the network delay; the
// largest of the recent samples has the least delay in it, so that one is the best estimate.
const clockSamples = [];
let clockOffset = 0;
function onClock(serverMs) {
  clockSamples.push(serverMs - Date.now());
  if (clockSamples.length > 8) clockSamples.shift();
  clockOffset = Math.max(...clockSamples);
}
const nowMs = () => Date.now() + clockOffset;

const state = { view: 'live', mode: 'all', selected: new Set(), showLines: true, showStops: true, onlyLive: false, search: '' };
let lines = [], stations = [], vehicles = [], fetchedAt = 0, stats = null;

const map = new maplibregl.Map({
  container: 'map',
  style: `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`,
  center: [4.48, 51.915], zoom: 11, attributionControl: { compact: true },
});
// The panel covers part of the map: set that as persistent camera padding once, so every
// flyTo/fitBounds centres in the visible part (passing padding per call would stack in MapLibre).
map.once('style.load', () => {
  map.setPadding(padding());
  map.fitBounds([[4.3, 51.84], [4.66, 51.99]], { padding: 0, duration: 0 }); // Rijnmond
});
addEventListener('resize', () => map.setPadding(padding()));

// ---------- helpers ----------
function status(d) {
  if (d == null) return { cls: 's-unknown', text: 'Geen info', long: 'geen vertragingsinfo' };
  const min = Math.round(d / 60);
  if (Math.abs(d) < 60) return { cls: 's-ontime', text: 'Op tijd', long: 'op tijd' };
  if (d < 0) return { cls: 's-early', text: `${min} min`, long: `${-min} min te vroeg` };
  return { cls: d >= 180 ? 's-verylate' : 's-late', text: `+${min} min`, long: `${min} min te laat` };
}
const badge = (x, cls = '') => `<span class="badge ${cls}" style="--c:${x.color}">${esc(x.line)}</span>`;
const title = (v) => (v.destination ? `Richting ${v.destination}` : v.name && !/^lijn$/i.test(v.name) ? v.name : `${MODE_NAME[v.mode] ?? ''} ${v.line}`);
const liveKeys = () => new Set(vehicles.map(keyOf));
const modeOk = (x) => state.mode === 'all' || x.mode === state.mode;
function lineVisible(x) {
  if (!modeOk(x)) return false;
  if (state.selected.size) return state.selected.has(keyOf(x));
  return !state.onlyLive || liveKeys().has(keyOf(x));
}
const padding = () => (innerWidth > 700
  ? { left: $('.panel').offsetWidth + 24, top: 20, right: 20, bottom: 20 }
  : { left: 20, top: 20, right: 20, bottom: $('.panel').offsetHeight + 20 });

// ---------- vehicle sprites: top-down vehicles, front pointing north, rotated by the map ----------
// Drawn on a canvas at 2× so they stay crisp; one image per mode + line colour, made on demand.
const SPRITE = { metro: [16, 76], tram: [15, 64], bus: [15, 34], ferry: [16, 34] }; // [width, length] in px @1×
function drawVehicle(mode, color) {
  const [w, l] = SPRITE[mode] ?? SPRITE.bus, s = 2, pad = 3;
  const c = document.createElement('canvas');
  c.width = (w + pad * 2) * s; c.height = (l + pad * 2) * s;
  const g = c.getContext('2d');
  g.scale(s, s); g.translate(pad, pad);
  const body = (x, y, bw, bl, r) => { g.beginPath(); g.roundRect(x, y, bw, bl, r); g.fillStyle = color; g.fill(); g.lineWidth = 1.6; g.strokeStyle = '#fff'; g.stroke(); };
  const glass = (x, y, bw, bl, r) => { g.beginPath(); g.roundRect(x, y, bw, bl, r); g.fillStyle = 'rgba(10,20,40,.55)'; g.fill(); };
  const roof = (x, y, bw, bl) => { g.fillStyle = 'rgba(255,255,255,.28)'; g.fillRect(x, y, bw, bl); };
  if (mode === 'metro' || mode === 'tram') {
    const cars = mode === 'metro' ? 2 : 3, gap = 2, cl = (l - gap * (cars - 1)) / cars;
    for (let i = 0; i < cars; i++) {
      const y = i * (cl + gap);
      body(0, y, w, cl, i === 0 ? [w / 2.2, w / 2.2, 3, 3] : i === cars - 1 ? [3, 3, w / 2.6, w / 2.6] : 3);
      roof(w / 2 - 1.5, y + 4, 3, cl - 8); // roof equipment strip
    }
    glass(2.5, 1.8, w - 5, 4.5, [w / 3, w / 3, 1.5, 1.5]); // front windscreen (north = direction of travel)
    if (mode === 'tram') { g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); g.moveTo(w / 2, cl * 0.35); g.lineTo(w / 2 - 3, cl * 0.55); g.lineTo(w / 2 + 3, cl * 0.55); g.closePath(); g.stroke(); } // pantograph
  } else if (mode === 'ferry') {
    g.beginPath(); g.moveTo(w / 2, 0); g.quadraticCurveTo(w, l * 0.3, w, l); g.lineTo(0, l); g.quadraticCurveTo(0, l * 0.3, w / 2, 0);
    g.fillStyle = color; g.fill(); g.lineWidth = 1.6; g.strokeStyle = '#fff'; g.stroke();
    glass(3.5, l * 0.35, w - 7, l * 0.35, 2);
  } else {
    body(0, 0, w, l, [4, 4, 2.5, 2.5]);
    glass(1.8, 1.6, w - 3.6, 4.5, [3, 3, 1, 1]); // windscreen
    roof(3, 9, w - 6, 3); roof(3, l - 9, w - 6, 2.5); // roof hatches / AC unit
  }
  return { width: c.width, height: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
}
const spriteId = (mode, color) => `veh|${mode}|${color}`;
map.on('styleimagemissing', (e) => {
  const [kind, mode, color] = e.id.split('|');
  if (kind === 'veh') map.addImage(e.id, drawVehicle(mode, color), { pixelRatio: 2 });
});

// ---------- geometry: move vehicles along their route instead of in straight hops ----------
const M_LAT = 110540, M_LON = 111320 * Math.cos((51.92 * Math.PI) / 180); // metres per degree here
const routeGeo = new Map(); // line key → [{ xy: [[x,y]], cum: [m] }]
function indexRoutes() {
  for (const l of lines) {
    const xy = l.coords.map(([lon, lat]) => [lon * M_LON, lat * M_LAT]);
    const cum = [0];
    for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    const k = keyOf(l);
    if (!routeGeo.has(k)) routeGeo.set(k, []);
    routeGeo.get(k).push({ xy, cum, lane: l.lane ?? 0 });
  }
}
function project(g, [lon, lat]) {
  const px = lon * M_LON, py = lat * M_LAT;
  let best = { d: Infinity, s: 0 };
  for (let i = 1; i < g.xy.length; i++) {
    const [ax, ay] = g.xy[i - 1], [bx, by] = g.xy[i];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best.d) best = { d, s: g.cum[i - 1] + t * Math.sqrt(len2) };
  }
  return best;
}
function pointAt(g, s) {
  let lo = 1, hi = g.cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (g.cum[mid] < s) lo = mid + 1; else hi = mid; }
  const [ax, ay] = g.xy[lo - 1], [bx, by] = g.xy[lo];
  const seg = g.cum[lo] - g.cum[lo - 1] || 1, t = Math.max(0, Math.min(1, (s - g.cum[lo - 1]) / seg));
  return [(ax + t * (bx - ax)) / M_LON, (ay + t * (by - ay)) / M_LAT];
}
const bearingOf = (a, b) => (Math.atan2((b[0] - a[0]) * M_LON, (b[1] - a[1]) * M_LAT) * 180) / Math.PI;
const LANE_PX = 9.5; // lane spacing in icon units (icon-offset scales with icon-size; ≈ line spacing at most zooms)

// ---------- static layers: routes + stations ----------
const fetchStatic = () => fetch('/api/static', { cache: 'no-cache' })
  .then((r) => (r.ok ? r.json() : new Promise((ok) => setTimeout(() => ok(fetchStatic()), 3000))));
const staticData = fetchStatic();

async function loadStatic() {
  ({ lines, stations } = await staticData);
  lines.sort((a, b) => MODE_ORDER[a.mode] - MODE_ORDER[b.mode] || a.line.localeCompare(b.line, 'nl', { numeric: true }));
  indexRoutes();
  for (const f of fleet.values()) { f.fixTs = null; upsertVehicle(f.v); } // arrived before the routes did: place on route now

  map.addSource('lines', { type: 'geojson', data: {
    type: 'FeatureCollection',
    features: lines.map((l) => ({ type: 'Feature', properties: { key: keyOf(l), line: l.line, color: l.color, rail: l.mode === 'metro' || l.mode === 'tram', metro: l.mode === 'metro', lane: l.lane ?? 0 },
      geometry: { type: 'LineString', coordinates: l.coords } })),
  } });
  const W = { 9: [2.2, 0.8], 16: [8, 4.5] }; // line width at zoom: [metro, other]
  const width = (m) => ['interpolate', ['linear'], ['zoom'], 9, ['case', ['get', 'metro'], W[9][0] * m, W[9][1] * m], 16, ['case', ['get', 'metro'], W[16][0] * m, W[16][1] * m]];
  // lines sharing a track sit side by side: shift each by its lane × (line width + a hairline gap)
  const offset = ['interpolate', ['linear'], ['zoom'],
    9, ['*', ['get', 'lane'], ['case', ['get', 'metro'], W[9][0] * 1.15, W[9][1] * 1.15]],
    16, ['*', ['get', 'lane'], ['case', ['get', 'metro'], W[16][0] * 1.15, W[16][1] * 1.15]]];
  map.addLayer({ id: 'lines-casing', type: 'line', source: 'lines', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': dark ? '#000' : '#fff', 'line-width': width(1.9), 'line-opacity': 0.9, 'line-offset': offset } });
  map.addLayer({ id: 'lines', type: 'line', source: 'lines', layout: { 'line-cap': 'butt', 'line-join': 'round', 'line-sort-key': ['case', ['get', 'metro'], 2, ['get', 'rail'], 1, 0] },
    paint: { 'line-color': ['get', 'color'], 'line-width': width(1), 'line-opacity': ['case', ['get', 'rail'], 1, 0.85], 'line-offset': offset } });
  map.addLayer({ id: 'line-labels', type: 'symbol', source: 'lines', minzoom: 13,
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 320, 'text-field': ['get', 'line'], 'text-size': 11,
      'text-font': ['Noto Sans Bold'], 'text-rotation-alignment': 'viewport', 'text-keep-upright': true },
    paint: { 'text-color': '#fff', 'text-halo-color': ['get', 'color'], 'text-halo-width': 3 } });

  // timelapse layers (empty until used)
  map.addSource('tl-trails', { type: 'geojson', data: EMPTY });
  map.addSource('tl-vehicles', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'tl-trails', type: 'line', source: 'tl-trails', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 15, 4], 'line-opacity': 0.55 } });
  map.addLayer({ id: 'tl-vehicles', type: 'circle', source: 'tl-vehicles',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 15, 7], 'circle-color': ['get', 'color'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } });

  map.addSource('stations', { type: 'geojson', data: { type: 'FeatureCollection', features: stations.map((s) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { id: s.id, name: s.name, metro: s.metro } })) } });
  map.addLayer({ id: 'stops', type: 'circle', source: 'stations', minzoom: 14, filter: ['!', ['get', 'metro']],
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2.5, 17, 5], 'circle-color': dark ? '#1c1c1e' : '#fff',
      'circle-stroke-color': dark ? '#d1d1d6' : '#3a3a3c', 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'metro-stations', type: 'circle', source: 'stations', filter: ['get', 'metro'],
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.5, 16, 9], 'circle-color': '#fff',
      'circle-stroke-color': dark ? '#f2f2f7' : '#1c1c1e', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 1.2, 16, 3.5] } });

  // live vehicles: sprite rotated with the direction of travel, shifted into its line's lane on shared
  // track; label = line number plus delay in minutes when ≥1 min off ("B +4")
  map.addSource('vehicles', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'vehicles', type: 'symbol', source: 'vehicles',
    layout: { 'icon-image': ['get', 'img'], 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true, 'icon-ignore-placement': true, 'symbol-sort-key': ['get', 'sort'], 'icon-offset': ['get', 'offset'],
      'icon-size': ['interpolate', ['exponential', 1.5], ['zoom'], 9, 0.32, 12, 0.5, 15, 0.9, 18, 1.6] } });
  map.addLayer({ id: 'vehicle-labels', type: 'symbol', source: 'vehicles', minzoom: 12,
    layout: { 'text-field': ['concat', ['get', 'line'], ['case', ['!=', ['get', 'late'], ''], ['concat', ' ', ['get', 'late']], '']], 'text-size': 11, 'text-font': ['Noto Sans Bold'], 'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
      'text-radial-offset': 1.3, 'text-padding': 1 },
    paint: { 'text-color': '#fff', 'text-halo-color': ['get', 'color'], 'text-halo-width': 2.5 } });

  map.addLayer({ id: 'station-labels', type: 'symbol', source: 'stations',
    filter: ['any', ['all', ['get', 'metro'], ['>=', ['zoom'], 11.5]], ['>=', ['zoom'], 15.5]],
    layout: { 'text-field': ['get', 'name'], 'text-size': ['case', ['get', 'metro'], 13, 11], 'text-font': ['Noto Sans Bold'],
      'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
    paint: { 'text-color': dark ? '#f2f2f7' : '#1c1c1e', 'text-halo-color': dark ? '#000' : '#fff', 'text-halo-width': 1.5 } });

  for (const id of ['stops', 'metro-stations', 'vehicles']) {
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }
  map.on('click', (e) => { // vehicles first: they sit on top of stations
    const [hit] = map.queryRenderedFeatures(e.point, { layers: ['vehicles', 'metro-stations', 'stops'] });
    if (!hit) return;
    if (hit.layer.id === 'vehicles') openVehicle(hit.properties.id);
    else openStation(hit.properties);
  });
  applyFilters();
}

// ---------- live vehicles: show where a vehicle is NOW, not where its last GPS fix was ----------
// A fix is ~20 s old on arrival and the feed refreshes once a minute. So each vehicle drives on along
// its route at the speed measured between its last two fixes ("dead reckoning"), from the fix's own
// timestamp, until the next fix corrects it.
const fleet = new Map(); // id → { v, g, sFix, fixTs, speed, sDisp, off, offAt, pos, heading, side }
let openPopup = null;
const MAX_AHEAD_S = 90;   // never predict further than this past a fix (feed hiccup → vehicle stops)
const MAX_SPEED = 25;     // m/s (90 km/h): faster "speeds" are GPS jumps, not driving
const HOLD_M = 150;       // a fix behind the shown position by less than this: wait instead of reversing

// closest route geometry of the vehicle's own line within 60 m (prefer the one it was already on)
function locate(v, p, prefer) {
  let best = null;
  for (const g of routeGeo.get(keyOf(v)) ?? []) {
    const r = project(g, p);
    if (r.d < 60 && (!best || r.d - (g === prefer ? 20 : 0) < best.d)) best = { g, s: r.s, d: r.d };
  }
  return best;
}

function upsertVehicle(v) {
  let f = fleet.get(v.id);
  if (!f) fleet.set(v.id, (f = { pos: [v.lon, v.lat], heading: v.bearing ?? 0, side: 0, speed: 0 }));
  f.v = v;
  if (f.fixTs && v.updatedAt <= f.fixTs) return; // same or older fix (status/delay update, or out of order)
  const p = [v.lon, v.lat], loc = locate(v, p, f.g);
  if (!loc) { Object.assign(f, { g: null, target: p, fixTs: v.updatedAt }); return; } // off-route: glide to the fix
  // speed along the route from the previous fix (ours, or the server's on first sight)
  const prevFix = f.g === loc.g && f.fixTs ? [f.sFix, f.fixTs] : v.prev && (() => { const r = project(loc.g, v.prev); return r.d < 60 ? [r.s, v.prev[2]] : null; })();
  if (prevFix && v.updatedAt > prevFix[1]) {
    const obs = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, (loc.s - prevFix[0]) / (v.updatedAt - prevFix[1])));
    f.speed = f.g === loc.g && Math.sign(obs) === Math.sign(f.speed) ? 0.6 * obs + 0.4 * f.speed : obs; // smooth, but follow a turnaround at once
    if (Math.abs(obs) > 1 && v.state !== 'stop') { f.cruise = Math.abs(f.speed); f.dirSign = Math.sign(obs); } // remembered for departures
  } else if (f.g !== loc.g) f.speed = 0;
  if (f.g !== loc.g || f.sDisp == null) f.sDisp = loc.s; // new route geometry: start exactly at the fix
  const r = pointAt(loc.g, loc.s);
  Object.assign(f, { g: loc.g, sFix: loc.s, fixTs: v.updatedAt, off: [p[0] - r[0], p[1] - r[1]], offAt: performance.now() });
  if (f.speed) f.side = loc.g.lane * Math.sign(f.speed); // lane is right of the drawing direction
  else if (f.heading == null || !f.dirKnown) { // standing still on first sight: align with the track
    const h = bearingOf(pointAt(loc.g, loc.s - 8), pointAt(loc.g, loc.s + 8));
    const back = v.bearing != null && Math.abs(((v.bearing - h + 540) % 360) - 180) > 90;
    f.heading = back ? h + 180 : h;
    f.side = loc.g.lane * (back ? -1 : 1);
  }
  f.dirKnown ||= !!f.speed;
}

// KV6 patches, every second: [id, lon, lat, positionTs, state, stateTs, delay]
function applyPatch(rows) {
  for (const [id, lon, lat, ts, st, stTs, delay] of rows) {
    const f = fleet.get(id);
    if (!f) continue;
    const v = f.v, wasStopped = v.state === 'stop', newFix = ts > v.updatedAt;
    Object.assign(v, { state: st, stateTs: stTs, delaySec: delay ?? v.delaySec });
    if (newFix) { Object.assign(v, { lon, lat, updatedAt: ts }); upsertVehicle(v); }
    if (wasStopped && st === 'moving' && f.g) {
      // DEPARTURE: drive off at its usual speed, counted from the departure moment
      if (!newFix) { f.sFix = f.sDisp; f.fixTs = stTs; } // no position in the message: from where it stood
      f.speed = (f.cruise || 6) * (f.dirSign || Math.sign(f.speed) || 1);
    }
  }
  dirty = true;
}

// where to draw a vehicle this frame (dt = seconds since the previous frame)
function step(f, nowSec, dt, nowMs) {
  if (!f.g) { // off-route: glide to the fix in ~1 s
    const k = Math.min(1, dt * 3);
    f.pos = [f.pos[0] + (f.target[0] - f.pos[0]) * k, f.pos[1] + (f.target[1] - f.pos[1]) * k];
    return;
  }
  const len = f.g.cum.at(-1);
  // at a stop (KV6 ARRIVAL/ONSTOP): stand still until the DEPARTURE message
  const age = f.v.state === 'stop' ? 0 : Math.max(0, Math.min(MAX_AHEAD_S, nowSec - f.fixTs));
  const sPred = Math.max(0, Math.min(len, f.sFix + f.speed * age));
  const diff = sPred - f.sDisp, dir = Math.sign(f.speed);
  // overshot (it stood at a stop): wait for the prediction instead of driving backwards
  if (Math.abs(diff) > 1000) f.sDisp = sPred; // a big correction: place it, don't slide a kilometre across the map
  else if (!(dir && diff * dir < 0 && Math.abs(diff) < HOLD_M)) f.sDisp += reduceMotion ? diff : diff * Math.min(1, dt * 2.5);
  const p = pointAt(f.g, f.sDisp);
  const fade = Math.max(0, 1 - (nowMs - f.offAt) / 3000); // GPS sits a few m beside the line: fade that in 3 s
  f.pos = [p[0] + f.off[0] * fade, p[1] + f.off[1] * fade];
  if (dir) { // face the direction of travel along the route, eased like steering
    const target = bearingOf(pointAt(f.g, f.sDisp - 6 * dir), pointAt(f.g, f.sDisp + 6 * dir));
    f.heading += (((target - f.heading + 540) % 360) - 180) * (reduceMotion ? 1 : Math.min(1, dt * 6));
  }
}

// one feature per visible vehicle; rebuilt ~30×/s while anything moves
function vehicleFeatures() {
  const out = [];
  for (const [id, f] of fleet) {
    const v = f.v;
    if (!lineVisible(v)) continue;
    const late = v.delaySec != null && Math.abs(v.delaySec) >= 60 ? `${v.delaySec > 0 ? '+' : '−'}${Math.round(Math.abs(v.delaySec) / 60)}` : '';
    out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: f.pos },
      properties: { id, key: keyOf(v), line: v.line, color: v.color, img: spriteId(v.mode, v.color), bearing: f.heading,
        offset: [(f.side ?? 0) * LANE_PX, 0], late,
        sort: MODE_ORDER[v.mode] === 0 ? 2 : MODE_ORDER[v.mode] === 1 ? 1 : 0 } });
  }
  return out;
}

let lastDraw = 0, lastFrame = performance.now(), dirty = true;
(function animate(now) {
  if (state.view !== 'timelapse') {
    const dt = Math.min(1, (now - lastFrame) / 1000), nowSec = nowMs() / 1000;
    for (const f of fleet.values()) step(f, nowSec, dt, now);
    dirty = fleet.size > 0;
    if (dirty && now - lastDraw > 33 && map.getSource('vehicles')) {
      map.getSource('vehicles').setData({ type: 'FeatureCollection', features: vehicleFeatures() });
      if (openPopup?.ref?.startsWith('veh:')) { const f = fleet.get(openPopup.ref.slice(4)); if (f) openPopup.setLngLat(f.pos); }
      lastDraw = now;
      dirty = false;
    }
  }
  lastFrame = now;
  requestAnimationFrame(animate);
})(performance.now());

function vehiclePopup(v) {
  const s = status(v.delaySec);
  const kind = `${MODE_NAME[v.mode] ?? 'Voertuig'}${v.vehicleNo ? ` ${v.vehicleNo}` : ''}`;
  return `<div class="pop"><h3>${badge(v)} ${esc(title(v))}</h3><dl>
    <dt>Status</dt><dd class="${s.cls}">${esc(s.long)}${v.state === 'stop' ? ' · staat bij halte' : ''}</dd>
    ${v.nextStop ? `<dt>Volgende</dt><dd>${esc(v.nextStop)}${v.nextStopAt ? ` · ${clock(v.nextStopAt)}` : ''}</dd>` : ''}
    <dt>Voertuig</dt><dd>${esc(kind)}${v.model ? `<br><span class="sub">${esc(v.model)} · sinds ${v.since}</span>` : ''}</dd>
    ${v.name && !/^lijn$/i.test(v.name) ? `<dt>Lijn</dt><dd>${esc(v.name)}</dd>` : ''}
    ${v.operator ? `<dt>Vervoerder</dt><dd>${esc(v.operator)}</dd>` : ''}
    <dt>Positie</dt><dd>${clock(v.updatedAt)}</dd></dl></div>`;
}

function showPopup(lngLat, html, ref) {
  openPopup?.remove();
  openPopup = new maplibregl.Popup({ closeButton: false, maxWidth: '320px', offset: 18, focusAfterOpen: false })
    .setLngLat(lngLat).setHTML(html).addTo(map);
  openPopup.ref = ref;
  openPopup.on('close', () => { if (openPopup?.ref === ref) openPopup = null; });
}

function openVehicle(id, fly) {
  const f = fleet.get(id);
  if (!f) return;
  if (fly) map.flyTo({ center: f.pos, zoom: Math.max(map.getZoom(), 15), duration: reduceMotion ? 0 : 900 });
  showPopup(f.pos, vehiclePopup(f.v), `veh:${id}`);
}

async function openStation(p) {
  const st = stations.find((s) => s.id === p.id);
  showPopup([st.lon, st.lat], `<div class="pop"><h3>${esc(st.name)}</h3><p class="sub">Vertrektijden laden…</p></div>`, `st:${st.id}`);
  const deps = await fetch(`/api/station/${st.id}`).then((r) => r.json()).catch(() => null);
  if (openPopup?.ref !== `st:${st.id}`) return;
  const now = nowMs() / 1000;
  const shown = (deps ?? []).filter((d) => modeOk(d) && d.destination !== st.name).slice(0, 8);
  const rows = shown.map((d) => {
    const s = d.delaySec == null ? { cls: 's-unknown', text: 'gepland' } : status(d.delaySec);
    const min = Math.round((d.time - now) / 60);
    return `<li>${badge(d)}<span class="dest">${esc(d.destination ?? '')}</span>
      <span class="when"><b>${min <= 0 ? 'nu' : min < 30 ? `${min} min` : clock(d.time)}</b><small class="${s.cls}">${esc(s.text)}</small></span></li>`;
  }).join('');
  const known = shown.filter((d) => d.delaySec != null);
  const onTime = known.filter((d) => d.delaySec >= -60 && d.delaySec <= 180).length;
  const served = (st.lines ?? []).map((l) => lines.find((x) => x.line === l) ?? { line: l, color: '#6e6e73' });
  openPopup.setHTML(`<div class="pop"><h3>${esc(st.name)}</h3>
    ${served.length ? `<div class="served">${served.map((l) => badge(l, 'small')).join('')}</div>` : ''}
    ${known.length ? `<p class="sub stat">${onTime} van ${known.length} vertrekken met live info op tijd</p>` : ''}
    ${rows ? `<ul class="deps">${rows}</ul>`
    : `<p class="sub">${deps ? 'Geen vertrekken in de komende 2 uur.' : 'Vertrektijden niet beschikbaar.'}</p>`}</div>`);
}

// ---------- filters, chips, list ----------
function applyFilters() {
  if (map.getLayer('lines')) {
    const keys = lines.filter(lineVisible).map(keyOf);
    const f = ['in', ['get', 'key'], ['literal', keys]];
    for (const id of ['lines-casing', 'lines', 'line-labels']) {
      map.setFilter(id, f);
      map.setLayoutProperty(id, 'visibility', state.showLines ? 'visible' : 'none');
    }
    for (const id of ['tl-trails', 'tl-vehicles']) map.setFilter(id, f);
    for (const id of ['vehicles', 'vehicle-labels']) map.setLayoutProperty(id, 'visibility', state.view === 'timelapse' ? 'none' : 'visible');
    const modeF = state.mode === 'all' ? true : state.mode === 'metro' ? ['get', 'metro'] : ['!', ['get', 'metro']];
    map.setFilter('stops', ['all', ['!', ['get', 'metro']], modeF]);
    map.setFilter('metro-stations', ['all', ['get', 'metro'], modeF]);
    for (const id of ['stops', 'metro-stations', 'station-labels']) map.setLayoutProperty(id, 'visibility', state.showStops ? 'visible' : 'none');
  }
  dirty = true;
  renderChips();
  renderList();
  tick();
}

function renderChips() {
  const live = liveKeys(), q = state.search.trim().toLowerCase();
  const chips = lines.filter(modeOk).filter((l, i, a) => a.findIndex((x) => keyOf(x) === keyOf(l)) === i)
    .filter((l) => !q || l.line.toLowerCase() === q || l.line.toLowerCase().startsWith(q) || (l.name ?? '').toLowerCase().includes(q) || (l.operator ?? '').toLowerCase().includes(q));
  $('#chips').innerHTML = chips.map((l) => {
    const k = keyOf(l), on = state.selected.has(k), n = vehicles.filter((v) => keyOf(v) === k).length;
    return `<button class="chip ${live.has(k) ? '' : 'idle'}" aria-pressed="${on}" data-key="${esc(k)}"
      aria-label="${MODE_NAME[l.mode] ?? l.mode} ${esc(l.line)} (${esc(l.operator)}), ${n} onderweg${l.name ? `, ${esc(l.name)}` : ''}"
      title="${esc(l.operator)} · ${esc(l.name)} · ${n} onderweg">${badge(l)}</button>`;
  }).join('') || '<p class="sub note">Geen lijn gevonden.</p>';
  $('#clearLines').hidden = !state.selected.size;
}

// Only vehicles in view: the region has hundreds, a list of all of them helps nobody.
function renderList() {
  if (state.view !== 'live') return;
  const b = map.getBounds();
  const shown = vehicles.filter((v) => lineVisible(v) && b.contains([v.lon, v.lat]));
  $('#listTitle').textContent = `In beeld (${shown.length})`;
  $('#list').innerHTML = shown.length ? shown.slice(0, 80).map((v) => {
    const s = status(v.delaySec);
    return `<li><button data-id="${esc(v.id)}">${badge(v)}
      <span class="meta"><span class="dest">${esc(title(v))}</span>
      <span class="op">${esc(v.nextStop ? `Volgende: ${v.nextStop}` : v.operator)}</span></span>
      <span class="delay ${s.cls}">${esc(s.text)}</span></button></li>`;
  }).join('') : `<li class="empty">${fetchedAt ? 'Geen voertuigen in beeld op deze lijnen.' : 'Live posities ophalen…'}</li>`;
}
map.on('moveend', renderList);

function renderStats() {
  if (!stats) return;
  $('#statsNote').textContent = `Gemeten sinds ${clock(stats.since)} over alle ritten op de lijnen op de kaart. Op tijd = tussen 1 min te vroeg en 3 min te laat.`;
  $('#stats').innerHTML = stats.operators.length ? stats.operators.map((o) => `<li>
    <div class="op-row"><b>${esc(o.operator)}</b><span class="pct">${o.onTimePct}%</span></div>
    <div class="bar" role="img" aria-label="${o.onTimePct}% op tijd, ${o.latePct}% meer dan 3 minuten te laat">
      <span class="on" style="width:${o.onTimePct}%"></span><span class="late" style="width:${o.latePct}%"></span></div>
    <div class="sub">${o.trips} ritten · ${o.latePct}% >3 min te laat · gem. ${o.avgDelayMin > 0 ? '+' : ''}${String(o.avgDelayMin).replace('.', ',')} min</div>
  </li>`).join('') : '<li class="empty">Nog geen metingen. Even wachten op de eerste posities.</li>';
}

function tick() {
  if (state.view === 'timelapse' || !fetchedAt) return;
  const n = vehicles.filter(lineVisible).length;
  const ago = Math.max(0, Math.round((nowMs() - fetchedAt) / 1000));
  $('#status').textContent = `${n} onderweg · ${ago < 10 ? 'zojuist' : ago < 120 ? `${ago} s geleden` : `${Math.round(ago / 60)} min geleden`} bijgewerkt`;
}

// ---------- live updates (server pushes as soon as OVapi has new data) ----------
function onSnapshot(data) {
  vehicles = data.vehicles;
  fetchedAt = data.fetchedAt;
  stats = data.stats;
  const ids = new Set(vehicles.map((v) => v.id));
  for (const id of fleet.keys()) if (!ids.has(id)) fleet.delete(id);
  for (const v of vehicles) upsertVehicle(v);
  if (openPopup?.ref?.startsWith('veh:')) {
    const f = fleet.get(openPopup.ref.slice(4));
    if (f) openPopup.setHTML(vehiclePopup(f.v)); else openPopup.remove();
  }
  applyFilters();
  if (state.view === 'stats') renderStats();
}

const es = new EventSource('/api/stream');
es.onmessage = (e) => onSnapshot(JSON.parse(e.data));
es.addEventListener('patch', (e) => applyPatch(JSON.parse(e.data)));
es.addEventListener('clock', (e) => onClock(Number(e.data)));
es.onerror = () => ($('#status').textContent = 'Verbinding kwijt, opnieuw verbinden…');

// ---------- timelapse: replay the recording with fading trails ----------
const tl = { tracks: null, t0: 0, t1: 0, t: 0, playing: false, speed: 300, trails: true, last: 0, drawn: 0 };
const TRAIL_SEC = 15 * 60; // trail length in recording time
const TL_HOURS = 6; // shortcut: replays the last 6 h only, to keep the download small; add a picker if you want whole days

async function loadTimelapse() {
  $('#status').textContent = 'Opname laden…';
  const since = Math.floor(nowMs() / 1000) - TL_HOURS * 3600;
  const frames = await fetch(`/api/history?since=${since}`).then((r) => r.json()).catch(() => []);
  if (frames.length < 2) {
    $('#status').textContent = 'Nog te weinig opgenomen. Laat de server een tijdje draaien.';
    return false;
  }
  const colorOf = new Map(lines.map((l) => [keyOf(l), l.color]));
  tl.tracks = new Map();
  for (const f of frames) for (const [id, lon, lat, key] of f.v) {
    let tr = tl.tracks.get(id);
    if (!tr) tl.tracks.set(id, (tr = { key, color: colorOf.get(key) ?? '#6e6e73', pts: [] }));
    tr.pts.push([f.t, lon, lat]);
  }
  tl.t0 = frames[0].t;
  tl.t1 = frames.at(-1).t;
  tl.t = tl.t0;
  $('#tlSlider').min = tl.t0;
  $('#tlSlider').max = tl.t1;
  $('#tlRange').textContent = `${clock(tl.t0)} – ${clock(tl.t1)} · ${frames.length} opnames`;
  return true;
}

// position of a track at time t (null when the vehicle wasn't seen around then)
function trackAt(pts, t) {
  let lo = 0, hi = pts.length - 1;
  if (t < pts[0][0] || t > pts[hi][0]) return null;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= t) lo = mid; else hi = mid; }
  const a = pts[lo], b = pts[hi];
  if (b[0] - a[0] > 300) return null; // gap > 5 min: it wasn't driving
  const k = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
  return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function drawTimelapse() {
  const veh = [], trails = [];
  for (const tr of tl.tracks.values()) {
    const p = trackAt(tr.pts, tl.t);
    if (!p) continue;
    const props = { key: tr.key, color: tr.color };
    veh.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: p } });
    if (tl.trails) {
      const tail = tr.pts.filter(([t]) => t > tl.t - TRAIL_SEC && t < tl.t).map(([, lon, lat]) => [lon, lat]);
      if (tail.length) trails.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: [...tail, p] } });
    }
  }
  map.getSource('tl-vehicles').setData({ type: 'FeatureCollection', features: veh });
  map.getSource('tl-trails').setData({ type: 'FeatureCollection', features: trails });
  $('#tlClock').textContent = clock(tl.t);
  $('#tlSlider').value = Math.round(tl.t);
  $('#status').textContent = `Timelapse · ${veh.length} voertuigen om ${clock(tl.t)}`;
}

(function tlLoop(now) {
  if (tl.playing && tl.tracks) {
    tl.t += ((now - (tl.last || now)) / 1000) * tl.speed;
    if (tl.t > tl.t1) tl.t = tl.t0; // loop
    if (now - tl.drawn > 40) { drawTimelapse(); tl.drawn = now; } // ~25 fps is plenty for GeoJSON updates
  }
  tl.last = now;
  requestAnimationFrame(tlLoop);
})(performance.now());

function setPlaying(on) {
  tl.playing = on && !!tl.tracks;
  $('#tlIcon').setAttribute('d', tl.playing ? 'M6 4h4v16H6zm8 0h4v16h-4z' : 'M7 4.5v15l13-7.5z');
  $('#tlPlay').setAttribute('aria-label', tl.playing ? 'Pauzeren' : 'Afspelen');
}

async function setView(view) {
  state.view = view;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.view === view));
  for (const v of ['live', 'timelapse', 'stats']) $(`#view-${v}`).hidden = v !== view;
  $('#filters').hidden = view === 'stats';
  openPopup?.remove();
  if (view === 'timelapse') {
    applyFilters(); // hides live vehicles
    if (await loadTimelapse()) { drawTimelapse(); setPlaying(!reduceMotion); }
  } else {
    setPlaying(false);
    for (const id of ['tl-vehicles', 'tl-trails']) map.getSource(id)?.setData(EMPTY);
    applyFilters();
    if (view === 'stats') renderStats();
  }
}

// ---------- controls ----------
$('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.view); });
$('#filters .segmented').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.mode = b.dataset.mode;
  state.selected.clear();
  document.querySelectorAll('#filters .segmented button').forEach((x) => x.setAttribute('aria-checked', x === b));
  applyFilters();
});
$('#lineSearch').addEventListener('input', (e) => { state.search = e.target.value; renderChips(); });
$('#chips').addEventListener('click', (e) => {
  const k = e.target.closest('.chip')?.dataset.key;
  if (!k) return;
  state.selected.has(k) ? state.selected.delete(k) : state.selected.add(k);
  applyFilters();
  // zoom to the whole chosen line(s): every vehicle on it is on the map, wherever it is
  const sel = lines.filter((l) => state.selected.has(keyOf(l)));
  if (sel.length) {
    const b = new maplibregl.LngLatBounds();
    for (const l of sel) for (const c of l.coords) b.extend(c);
    openPopup?.remove();
    map.fitBounds(b, { padding: 40, maxZoom: 15, duration: reduceMotion ? 0 : 800 });
  }
});
$('#clearLines').addEventListener('click', () => { state.selected.clear(); applyFilters(); });
for (const [id, key] of [['#showLines', 'showLines'], ['#showStops', 'showStops'], ['#onlyLive', 'onlyLive']]) {
  $(id).addEventListener('change', (e) => { state[key] = e.target.checked; applyFilters(); });
}
$('#list').addEventListener('click', (e) => {
  const id = e.target.closest('button')?.dataset.id;
  if (id) openVehicle(id, true);
});
$('#tlPlay').addEventListener('click', () => setPlaying(!tl.playing));
$('#tlSlider').addEventListener('input', (e) => { tl.t = +e.target.value; if (tl.tracks) drawTimelapse(); });
$('#view-timelapse .segmented').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  tl.speed = +b.dataset.speed;
  document.querySelectorAll('#view-timelapse .segmented button').forEach((x) => x.setAttribute('aria-checked', x === b));
});
$('#tlTrails').addEventListener('change', (e) => { tl.trails = e.target.checked; if (tl.tracks) drawTimelapse(); });

let me;
$('#locate').addEventListener('click', () => {
  navigator.geolocation?.getCurrentPosition(({ coords }) => {
    const ll = [coords.longitude, coords.latitude];
    if (!me) { const el = document.createElement('div'); el.className = 'me'; me = new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(map); }
    me.setLngLat(ll);
    map.flyTo({ center: ll, zoom: 15 });
  }, () => ($('#status').textContent = 'Locatie niet beschikbaar: sta locatietoegang toe in je browser.'));
});

map.once('style.load', loadStatic); // style parsed; no need to wait for every tile
setInterval(tick, 1000);
