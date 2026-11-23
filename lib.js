// Pure logic: turn GTFS(-realtime) data into what the map shows.

// Rijnmond: Rotterdam centre, radius covers Krimpen, Capelle, Schiedam, Vlaardingen, Spijkenisse, Barendrecht.
export const AREA = { lat: 51.915, lon: 4.48, radiusKm: 15 };

// Rolling stock by fleet number (RET publishes the number as the vehicle label).
// Source: RET fleet lists on Wikipedia "Rotterdam Metro" / "Trams in Rotterdam" (checked 2026-11).
const FLEET = [
  ['RET', 5301, 5363, 'Bombardier MG2/1', 1998], ['RET', 5401, 5418, 'Bombardier SG2/1', 2001],
  ['RET', 5501, 5522, 'Bombardier RSG3', 2007], ['RET', 5601, 5642, 'Bombardier SG3', 2009],
  ['RET', 5701, 5722, 'Bombardier HSG3', 2015], ['RET', 2001, 2060, 'Alstom Citadis 302', 2003],
  ['RET', 2101, 2153, 'Alstom Citadis', 2011],
];
export function vehicleModel(operator, mode, label) {
  const n = Number(label);
  if (mode !== 'metro' && mode !== 'tram') return null; // bus fleets are too many and change too often to list
  const f = FLEET.find(([op, lo, hi]) => op === operator && n >= lo && n <= hi);
  return f ? { model: f[3], since: f[4] } : null;
}

// Dutch RD (Rijksdriehoek) metres → WGS84 degrees. Approximation by Schreutelkamp & Strang van Hees,
// accurate to ~1 m inside the Netherlands — plenty for a vehicle on a map.
export function rdToWgs84(x, y) {
  const dX = (x - 155000) * 1e-5, dY = (y - 463000) * 1e-5;
  const N = 3235.65389 * dY - 32.58297 * dX ** 2 - 0.2475 * dY ** 2 - 0.84978 * dX ** 2 * dY - 0.0655 * dY ** 3
    - 0.01709 * dX ** 2 * dY ** 2 - 0.00738 * dX + 0.0053 * dX ** 4 - 0.00039 * dX ** 2 * dY ** 3
    + 0.00033 * dX ** 4 * dY - 0.00012 * dX * dY;
  const E = 5260.52916 * dX + 105.94684 * dX * dY + 2.45656 * dX * dY ** 2 - 0.81885 * dX ** 3
    + 0.05594 * dX * dY ** 3 - 0.05607 * dX ** 3 * dY + 0.01199 * dY - 0.00256 * dX ** 3 * dY ** 2
    + 0.00128 * dX * dY ** 4 + 0.00022 * dY ** 2 - 0.00022 * dX ** 2 + 0.00026 * dX ** 5;
  return { lat: 52.15517440 + N / 3600, lon: 5.38720621 + E / 3600 };
}

// KV6posinfo XML (BISON, from the GOVI/NDOV realtime stream) → events. The id matches OVapi's
// GTFS-rt entity id: operatingday:dataownercode:lineplanningnumber:journeynumber.
const KV6_TYPES = 'ARRIVAL|DEPARTURE|ONSTOP|ONROUTE|INIT|END|DELAY|OFFROUTE';
export function parseKV6(xml) {
  const out = [];
  for (const [, type, body] of xml.matchAll(new RegExp(`<(?:\\w+:)?(${KV6_TYPES})>([\\s\\S]*?)</(?:\\w+:)?\\1>`, 'g'))) {
    const f = (name) => body.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)<`))?.[1];
    const x = Number(f('rd-x')), y = Number(f('rd-y')), punct = f('punctuality');
    out.push({
      type,
      id: `${f('operatingday')}:${f('dataownercode')}:${f('lineplanningnumber')}:${f('journeynumber')}`,
      ts: Date.parse(f('timestamp')) / 1000,
      ...(x > 0 && y > 0 ? rdToWgs84(x, y) : {}), // -1 or missing = no position in this message
      delay: punct == null || punct === '' ? null : Number(punct),
      vehicleNo: f('vehiclenumber') ?? null,
    });
  }
  return out;
}

// KV17cvlinfo XML (trip changes) → [{ id, type, ts, reason }] for whole-trip changes: CANCEL (trip won't
// run), RECOVER (it will after all), MUTATIONMESSAGE (a note). Same id as KV6 / OVapi.
export function parseKV17(xml) {
  const out = [];
  const tag = (name, s) => s.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)<`))?.[1];
  for (const [, block] of xml.matchAll(/<(?:\w+:)?KV17cvlinfo>([\s\S]*?)<\/(?:\w+:)?KV17cvlinfo>/g)) {
    const id = `${tag('operatingday', block)}:${tag('dataownercode', block)}:${tag('lineplanningnumber', block)}:${tag('journeynumber', block)}`;
    for (const [, m] of block.matchAll(/<(?:\w+:)?KV17MUTATEJOURNEY>([\s\S]*?)<\/(?:\w+:)?KV17MUTATEJOURNEY>/g)) {
      const type = m.match(/<(?:\w+:)?(CANCEL|RECOVER|MUTATIONMESSAGE)>/)?.[1];
      if (type) out.push({ id, type, ts: Date.parse(tag('timestamp', m)) / 1000, reason: tag('reasoncontent', m) || tag('freetext', m) || null });
    }
  }
  return out;
}

// The rest of a trip from now on: our stations it still calls at, with expected times (planned + delay).
// rows: [stationId, secs, seq] sorted by seq; date "20261123"
export function upcomingStops(rows, date, delay, now, limit = 6) {
  const start = dayStart(date);
  return rows.map(([station, secs]) => ({ station, planned: start + secs, time: start + secs + (delay ?? 0) }))
    .filter((s) => s.time >= now - 60).slice(0, limit);
}

// Is moving from fix a to fix b physically possible? Faster than 40 m/s (144 km/h) within a minute is a GPS
// glitch or another vehicle reporting the same trip; after a minute without fixes anything goes (it may
// really have been somewhere else, and we must not get stuck on a wrong position).
export function plausibleMove(a, b, maxSpeed = 40) {
  if (!a || !(b.ts > a.ts) || b.ts - a.ts >= 60) return true;
  return distKm(a, b) * 1000 / (b.ts - a.ts) <= maxSpeed;
}

// Overpass result (route relations + their ways with geometry) → corridors: stretches of track
// used by the same set of lines, e.g. { lines: ['metro|A', 'metro|B', 'metro|C'], coords }.
// Drawing each corridor once per line, offset side by side, gives the metro-map look on shared track.
export function osmToRail(elements) {
  const geom = new Map(elements.filter((e) => e.type === 'way').map((w) => [w.id, w.geometry.map((p) => [+p.lon.toFixed(6), +p.lat.toFixed(6)])]));
  const linesOf = new Map(); // way id → Set of line keys
  for (const rel of elements.filter((e) => e.type === 'relation' && e.tags?.ref)) {
    const key = `${rel.tags.route === 'tram' ? 'tram' : 'metro'}|${rel.tags.ref}`;
    for (const m of rel.members) {
      if (m.type !== 'way' || /platform|stop/.test(m.role) || !geom.has(m.ref)) continue;
      if (!linesOf.has(m.ref)) linesOf.set(m.ref, new Set());
      linesOf.get(m.ref).add(key);
    }
  }
  const groups = new Map(); // "metro|A,metro|B" → way geometries
  for (const [id, keys] of linesOf) {
    const sig = [...keys].sort((a, b) => a.localeCompare(b, 'nl', { numeric: true })).join(',');
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(geom.get(id));
  }
  const out = [];
  for (const [sig, ways] of groups) {
    for (let c of chainWays(ways)) {
      // same orientation everywhere (west→east, or south→north when mostly vertical), so a line
      // keeps its side when the corridor changes; line-offset is relative to drawing direction
      const dx = (c.at(-1)[0] - c[0][0]) * 0.62, dy = c.at(-1)[1] - c[0][1]; // 0.62 ≈ cos(52°)
      if (Math.abs(dx) >= Math.abs(dy) ? dx < 0 : dy < 0) c = [...c].reverse();
      out.push({ lines: sig.split(','), coords: thin(c, 6) });
    }
  }
  return out;
}

// Join OSM way geometries into as few long polylines as possible (shared endpoints, either direction).
export function chainWays(ways) {
  const k = (p) => `${p[0]},${p[1]}`;
  const left = new Set(ways.map((_, i) => i));
  const byEnd = new Map();
  ways.forEach((w, i) => { for (const p of [w[0], w.at(-1)]) (byEnd.get(k(p)) ?? byEnd.set(k(p), []).get(k(p))).push(i); });
  const take = (p) => { const i = (byEnd.get(k(p)) ?? []).find((j) => left.has(j)); if (i !== undefined) left.delete(i); return i; };
  const out = [];
  for (const start of ways.keys()) {
    if (!left.has(start)) continue;
    left.delete(start);
    let line = [...ways[start]];
    for (let i; (i = take(line.at(-1))) !== undefined;) { const w = ways[i]; line.push(...(k(w[0]) === k(line.at(-1)) ? w : [...w].reverse()).slice(1)); }
    for (let i; (i = take(line[0])) !== undefined;) { const w = ways[i]; line = [...(k(w.at(-1)) === k(line[0]) ? w : [...w].reverse()).slice(0, -1), ...line]; }
    out.push(line);
  }
  return out;
}

// GTFS route_type → mode. Extended types (700 bus, 400 metro, 900 tram, 1200 ferry) included.
export function modeOf(type) {
  const t = Number(type);
  if (t === 1 || (t >= 400 && t < 500)) return 'metro';
  if (t === 0 || (t >= 900 && t < 1000)) return 'tram';
  if (t === 4 || (t >= 1000 && t < 1300)) return 'ferry';
  if (t === 2 || (t >= 100 && t < 200)) return 'train';
  return 'bus';
}

// The feed has no route colours. Metro gets fixed colours per letter, the rest a stable hue per line.
const METRO = { A: '#2a9d4b', B: '#e6b800', C: '#e2231a', D: '#1f7a8c', E: '#1d5fd1' };
export function lineColor(short, mode, operator = '') {
  if (mode === 'metro' && METRO[short]) return METRO[short];
  let h = 0; // hash includes operator + mode: RET tram 1 and HTM tram 1 are different lines
  for (const c of `${operator}|${mode}|${short}`) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} ${mode === 'tram' ? 55 : 65}% 42%)`;
}

// Text colour on a line colour: white or near-black, whichever has the higher WCAG contrast.
// Yellows and greens (metro B, many bus hues) are too light for white text.
const toRgb = (c) => {
  if (c.startsWith('#')) return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const [h, s, l] = c.match(/[\d.]+/g).map(Number), a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  return [0, 8, 4].map((n) => { const k = (n + h / 30) % 12; return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); });
};
const luminance = (rgb) => rgb.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
export function lineTextColor(color) {
  const L = luminance(toRgb(color)), DARK = 0.0116; // #1c1c1e
  return 1.05 / (L + 0.05) >= (L + 0.05) / (DARK + 0.05) ? '#fff' : '#1c1c1e';
}

export function distKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// "Rotterdam, Metro Capelsebrug (Perron D)" → "Metro Capelsebrug"; "[Capelsebrug] Busstation" → "Busstation"
export const cleanStopName = (n) =>
  String(n).replace(/^\[[^\]]*\]\s*/, '').replace(/^[^,]+,\s*/, '').replace(/\s*\(perron [^)]*\)$/i, '').trim();

// "Metrostation Capelsebrug", "Capelsebrug Hoog", "Capelsebrug Metro Uitstaphalte" → "capelsebrug"
const coreName = (n) => n.replace(/\b(metrostation|metro|station|hoog|laag|uitstaphalte)\b/gi, '').replace(/\s+/g, ' ').trim() || n;

// Group platforms into stations: same core name within 400 m; the core name is the label.
export function groupStations(stops) {
  const stations = [];
  for (const s of stops) {
    const name = coreName(cleanStopName(s.name)), core = name.toLowerCase();
    let st = stations.find((x) => x.core === core && distKm(x, s) < 0.4);
    if (!st) stations.push((st = { id: `st${stations.length}`, name, core, lat: s.lat, lon: s.lon, metro: false, stopIds: [] }));
    st.metro ||= /metro/i.test(s.name);
    st.stopIds.push(s.id);
  }
  return stations.map(({ core, ...st }) => st);
}

// Drop shape points closer than ~minM to the last kept one (keeps payload small, line looks the same).
export function thin(points, minM = 20) {
  const out = [];
  for (const p of points) {
    const last = out.at(-1);
    if (!last || distKm({ lat: last[1], lon: last[0] }, { lat: p[1], lon: p[0] }) * 1000 >= minM) out.push(p);
  }
  if (points.length && out.at(-1) !== points.at(-1)) out.push(points.at(-1));
  return out;
}

const num = (v) => (v == null ? null : Number(v)); // protobuf Long → number

// tripUpdates feed → Map(tripId → { routeId, stops: [{stopId, seq, time, delay}], delay })
// shortcut: OVapi marks most trips without live data as CANCELED, so schedule_relationship is ignored.
export function indexTripUpdates(feed) {
  const m = new Map();
  for (const e of feed?.entity ?? []) {
    const tu = e.tripUpdate;
    if (!tu?.trip?.tripId) continue;
    const stops = (tu.stopTimeUpdate ?? []).map((s) => {
      const ev = s.departure ?? s.arrival;
      return { stopId: s.stopId, seq: num(s.stopSequence), time: num(ev?.time), delay: num(ev?.delay) };
    });
    m.set(tu.trip.tripId, { routeId: tu.trip.routeId, stops, delay: num(tu.delay) });
  }
  return m;
}

const routeInfo = (routes, id) => {
  const r = routes.get(id) ?? {};
  const mode = modeOf(r.type ?? 3);
  const line = r.short || id || '?';
  const color = lineColor(line, mode, r.agency);
  return { routeId: id, line, mode, color, text: lineTextColor(color), name: r.long || '', operator: r.agency || '' };
};

const inArea = (pos) => distKm(AREA, pos) <= AREA.radiusKm;

// keep(pos, route): which vehicles to show; the server passes "in the area, or on a line we draw".
// headsignOf(tripId): destination from the timetable. Live updates often hold only a few stops,
// so their last stop is not the destination.
// maxAge: drop vehicles whose fix is older (s); the server passes Infinity and filters after merging KV6.
export function buildVehicles(vpFeed, trips, routes, stops, now = Date.now() / 1000, keep = inArea, headsignOf = () => null, maxAge = 300) {
  const out = [];
  for (const e of vpFeed?.entity ?? []) {
    const v = e.vehicle;
    const p = v?.position;
    if (!p) continue;
    const pos = { lat: p.latitude, lon: p.longitude };
    const ts = num(v.timestamp) ?? now;
    if (now - ts > maxAge) continue; // stale: vehicle stopped reporting

    const tu = trips.get(v.trip?.tripId);
    const route = routeInfo(routes, v.trip?.routeId ?? tu?.routeId);
    if (!keep(pos, route)) continue;
    // next stop = first update still in the future; last update = final destination
    const next = tu?.stops.find((s) => s.time == null || s.time >= now - 30);
    const last = tu?.stops.at(-1);

    out.push({
      id: e.id, tripId: v.trip?.tripId ?? null, lat: pos.lat, lon: pos.lon, bearing: p.bearing ?? null,
      ...route,
      vehicleNo: v.vehicle?.label || null,
      ...vehicleModel(route.operator, route.mode, v.vehicle?.label),
      destination: headsignOf(v.trip?.tripId) ?? (stops.get(last?.stopId) ? cleanStopName(stops.get(last.stopId)) : null),
      nextStop: next && stops.get(next.stopId) ? cleanStopName(stops.get(next.stopId)) : null,
      nextStopAt: next?.time ?? null,
      delaySec: next?.delay ?? tu?.delay ?? null,
      updatedAt: ts,
    });
  }
  return out.sort((a, b) => String(a.line).localeCompare(String(b.line), 'nl', { numeric: true }));
}

// Punctuality per operator from the last known delay of each trip today.
// On time = between 1 min early and 3 min late (the usual Dutch OV yardstick).
export function punctuality(tripDelays) {
  const ops = {};
  for (const { op, delay } of tripDelays.values()) {
    if (delay == null || !op) continue;
    const o = (ops[op] ??= { operator: op, trips: 0, onTime: 0, late: 0, totalDelay: 0 });
    o.trips++;
    o.totalDelay += delay;
    if (delay >= -60 && delay <= 180) o.onTime++;
    else if (delay > 180) o.late++;
  }
  return Object.values(ops)
    .map((o) => ({ operator: o.operator, trips: o.trips, onTimePct: Math.round((o.onTime / o.trips) * 100),
      latePct: Math.round((o.late / o.trips) * 100), avgDelayMin: +(o.totalDelay / o.trips / 60).toFixed(1) }))
    .sort((a, b) => b.trips - a.trips);
}

// The least punctual lines today (at least minTrips measured trips, so one bad trip doesn't top the list).
// tripDelays values: { op, key ("RET|bus|33"), delay }
export function punctualityByLine(tripDelays, minTrips = 5, limit = 8) {
  const by = {};
  for (const { key, delay } of tripDelays.values()) {
    if (!key || delay == null) continue;
    const o = (by[key] ??= { key, trips: 0, onTime: 0, total: 0 });
    o.trips++; o.total += delay;
    if (delay >= -60 && delay <= 180) o.onTime++;
  }
  return Object.values(by).filter((o) => o.trips >= minTrips)
    .map((o) => ({ key: o.key, trips: o.trips, onTimePct: Math.round((o.onTime / o.trips) * 100), avgDelayMin: +(o.total / o.trips / 60).toFixed(1) }))
    .sort((a, b) => a.onTimePct - b.onTimePct || b.avgDelayMin - a.avgDelayMin).slice(0, limit);
}

export const polylineKm =(c) => c.reduce((s, p, i) => (i ? s + distKm({ lon: c[i - 1][0], lat: c[i - 1][1] }, { lon: p[0], lat: p[1] }) : 0), 0);

// "25:13:00" → seconds after service-day start (GTFS times can pass 24h)
export const gtfsSecs = (t) => { const [h, m, s] = t.split(':'); return h * 3600 + m * 60 + +s; };

// Service day "20261123" → unix time of its GTFS day start (noon − 12h, local time).
// shortcut: uses the server's timezone; run the server in Europe/Amsterdam.
export const dayStart = (d) => new Date(+d.slice(0, 4), d.slice(4, 6) - 1, +d.slice(6), 12).getTime() / 1000 - 43200;

// Live delay for a scheduled stop: its own update, else the last earlier update (GTFS-rt propagates delay downstream).
function liveDelay(tu, seq) {
  let d = null;
  for (const s of tu?.stops ?? []) if (s.seq != null && s.seq <= seq) d = s.delay ?? d;
  return d ?? tu?.delay ?? null;
}

// Next departures at one station from the static timetable + live delays.
// rows: [tripId, secs, seq]; trips: tripId → { route, headsign, dates, last (final stop seq) }
// vehicleDelay: tripId → current delay of the vehicle driving it (KV6, seconds old). It beats OVapi's trip
// updates, which arrive every 2 min and often hold nothing — departures then wrongly said "gepland".
// cancelledOf(trip, date): reason (or true) when KV17 cancelled that trip on that day — still listed, struck through.
export function stationDepartures(rows, trips, routes, live, now = Date.now() / 1000, limit = 10, vehicleDelay = new Map(), cancelledOf = () => null) {
  const out = [];
  for (const [tripId, secs, seq] of rows) {
    const t = trips[tripId];
    if (!t || seq === t.last) continue; // arriving at the terminus is no departure
    for (const d of t.dates) {
      const planned = dayStart(d) + secs;
      if (planned < now - 1800 || planned > now + 7200) continue;
      const cancelled = cancelledOf(t, d);
      const delay = cancelled ? null : vehicleDelay.get(tripId) ?? liveDelay(live.get(tripId), seq);
      const time = planned + (delay ?? 0);
      if (time < now - 30) continue;
      const r = routeInfo(routes, t.route);
      out.push({ line: r.line, mode: r.mode, color: r.color, text: r.text, destination: t.headsign ? cleanStopName(t.headsign) : r.name,
        time, planned, delaySec: delay, live: live.has(tripId) || vehicleDelay.has(tripId), ...(cancelled && { cancelled }) });
    }
  }
  return out.sort((a, b) => a.time - b.time).slice(0, limit);
}

// Minimal CSV line parser (GTFS quotes fields containing commas).
export function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
