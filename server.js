import http from 'node:http';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import readline from 'node:readline';
import zlib from 'node:zlib';
import unzipper from 'unzipper';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { Subscriber } from 'zeromq';
import {
  AREA, buildVehicles, stationDepartures, indexTripUpdates, parseCsvLine, parseKV6,
  groupStations, thin, modeOf, lineColor, distKm, gtfsSecs, polylineKm, punctuality, osmToRail, cleanStopName,
} from './lib.js';

const FEED = 'https://gtfs.ovapi.nl/nl';
const PORT = process.env.PORT || 3000;
const UA = { 'User-Agent': 'ov-live/1.0' };
// DATA_DIR: where downloads, caches and recordings live (mount it as a volume when hosting)
const DATA = process.env.DATA_DIR ? pathToFileURL(`${process.env.DATA_DIR.replace(/[\\/]$/, '')}/`) : new URL('./data/', import.meta.url);
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS) || 500; // live connections; each gets ~100 KB per feed update
const ZIP = new URL('gtfs-nl.zip', DATA);
const STATIC_CACHE = new URL('static-v8.json', DATA); // bump when the static format changes
const DAY = 24 * 3600e3;
const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

let routes = new Map(), stops = new Map(), stations = [], timetable = {}, tripInfo = {}, staticGz = null;
let snapshot = { vehicles: [], fetchedAt: 0 };
let liveTrips = new Map(), lineKeys = new Set(), lastFixes = new Map();
const clients = new Set();

// Same number ≠ same line: RET tram 3 and HTM tram 3 differ. Keep in sync with keyOf in public/app.js.
const lineKey = (x) => `${x.operator}|${x.mode}|${x.line}`;

// ---------- recorder: one frame per new position feed, kept per day on disk ----------
// Feeds both the timelapse and the punctuality stats (OVapi has no history of its own).
const history = { date: null, frames: [], tripDelays: new Map() };
const historyFile = (date) => new URL(`history-${date}.jsonl`, DATA);

// Frame entry: [vehicle id, lon, lat, line key, delay]. The id is per trip (date:operator:line:journey).
const noteDelays = (v) => { for (const [id, , , key, delay] of v) if (delay != null) history.tripDelays.set(id, { op: key.split('|')[0], delay }); };
function addFrame(f) {
  history.frames.push(f);
  noteDelays(f.v);
}

async function loadHistory() {
  history.date = serviceDate(0);
  // recordings are ~60 MB/day: keep a week so a long-running server doesn't fill its disk
  const keep = new Set(Array.from({ length: 7 }, (_, i) => `history-${serviceDate(-i)}.jsonl`));
  for (const f of await fs.readdir(DATA).catch(() => [])) if (/^history-\d{8}\.jsonl$/.test(f) && !keep.has(f)) await fs.rm(new URL(f, DATA)).catch(() => {});
  history.frames = [];
  history.tripDelays = new Map();
  const text = await fs.readFile(historyFile(history.date), 'utf8').catch(() => '');
  for (const line of text.split('\n')) if (line) { try { addFrame(JSON.parse(line)); } catch {} } // skip a torn last line
}

function record(vehicles, t) {
  if (history.date !== serviceDate(0)) loadHistory(); // new day: start a fresh recording
  const f = { t, v: vehicles.map((v) => [v.id.replace(/^\d{4}-\d\d-\d\d:/, ''), +v.lon.toFixed(5), +v.lat.toFixed(5), lineKey(v), v.delaySec]) };
  if (history.frames.at(-1)?.t === t) return noteDelays(f.v); // same positions, newer delays: stats only
  addFrame(f);
  fs.appendFile(historyFile(history.date), JSON.stringify(f) + '\n').catch((e) => console.error('Opnemen mislukt:', e.message));
}

// "20261123" for today + offset days, in the server's local time (see dayStart in lib.js)
const serviceDate = (offset) => {
  const d = new Date(Date.now() + offset * DAY);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

// ---------- static GTFS (daily) ----------
async function readCsv(stream, onRow) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let idx;
  for await (const line of rl) {
    if (!line) continue;
    const cols = line.includes('"') ? parseCsvLine(line) : line.split(',');
    if (!idx) { idx = Object.fromEntries(cols.map((h, i) => [h.replace(/^﻿/, ''), i])); continue; }
    onRow(cols, idx);
  }
}

async function downloadZip() {
  const stat = await fs.stat(ZIP).catch(() => null);
  if (stat && Date.now() - stat.mtimeMs < DAY) return;
  console.log('Dienstregeling downloaden (±280 MB, eenmalig per dag)…');
  const res = await fetch(`${FEED}/gtfs-nl.zip`, {
    headers: { ...UA, ...(stat && { 'If-Modified-Since': stat.mtime.toUTCString() }) },
  });
  if (res.status === 304) return fs.utimes(ZIP, new Date(), new Date());
  if (!res.ok) throw new Error(`gtfs-nl.zip: HTTP ${res.status}`);
  const tmp = new URL('gtfs-nl.zip.part', DATA);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await fs.rename(tmp, ZIP);
}

async function buildStatic() {
  await fs.mkdir(DATA, { recursive: true });
  await downloadZip();
  console.log('Dienstregeling verwerken (lijnen, haltes, routes)…');
  const zip = await unzipper.Open.file(fileURLToPath(ZIP));
  const open = (name) => zip.files.find((f) => f.path === name).stream();

  const agency = {};
  await readCsv(open('agency.txt'), (c, i) => (agency[c[i.agency_id]] = c[i.agency_name]));
  const r = {};
  await readCsv(open('routes.txt'), (c, i) => (r[c[i.route_id]] = {
    short: c[i.route_short_name], long: c[i.route_long_name], type: c[i.route_type],
    agency: agency[c[i.agency_id]] ?? c[i.agency_id], agencyId: c[i.agency_id],
  }));
  const isRetMetro = (id) => r[id]?.agencyId === 'RET' && modeOf(r[id].type) === 'metro'; // the whole Rotterdam metro network

  const s = {}, local = [];
  await readCsv(open('stops.txt'), (c, i) => {
    const stop = { id: c[i.stop_id], name: c[i.stop_name], lat: +c[i.stop_lat], lon: +c[i.stop_lon] };
    s[stop.id] = stop.name;
    if (c[i.location_type] === '1') return;
    const d = distKm(AREA, stop); // all metro stations of the network (Den Haag–Hoek van Holland–Nesselande ≈ 35 km)
    if (d <= AREA.radiusKm || (d <= 40 && /\bmetro/i.test(stop.name))) local.push(stop);
  });

  // Services running yesterday (after-midnight trips), today and tomorrow.
  const days = [-1, 0, 1].map(serviceDate);
  const serviceDays = new Map();
  await readCsv(open('calendar_dates.txt'), (c, i) => {
    if (c[i.exception_type] === '1' && days.includes(c[i.date])) {
      const a = serviceDays.get(c[i.service_id]) ?? [];
      serviceDays.set(c[i.service_id], [...a, c[i.date]]);
    }
  });

  const shapeRoute = new Map(), trips = {};
  await readCsv(open('trips.txt'), (c, i) => {
    if (c[i.shape_id]) shapeRoute.set(c[i.shape_id], c[i.route_id]);
    const dates = serviceDays.get(c[i.service_id]);
    if (dates) trips[c[i.trip_id]] = { route: c[i.route_id], headsign: c[i.trip_headsign], dates, last: 0 };
  });

  // Timetable for our stations only. stop_times is >1 GB, so one streaming pass.
  const stationList = groupStations(local);
  const stationOf = new Map();
  for (const st of stationList) for (const id of st.stopIds) stationOf.set(id, st);
  const timetable = {}, served = new Map();
  await readCsv(open('stop_times.txt'), (c, i) => {
    const t = trips[c[i.trip_id]];
    if (!t) return;
    const seq = +c[i.stop_sequence];
    if (seq > t.last) t.last = seq;
    const st = stationOf.get(c[i.stop_id]);
    if (!st) return;
    (timetable[st.id] ??= []).push([c[i.trip_id], gtfsSecs(c[i.departure_time] || c[i.arrival_time]), seq]);
    if (!served.has(st.id)) served.set(st.id, new Set());
    served.get(st.id).add(t.route);
  });
  const used = new Set(Object.values(timetable).flatMap((rows) => rows.map((x) => x[0])));
  for (const id in trips) if (!used.has(id)) delete trips[id];
  for (const st of stationList) {
    const rs = [...(served.get(st.id) ?? [])].map((id) => r[id]).filter(Boolean);
    st.modes = [...new Set(rs.map((x) => modeOf(x.type)))];
    st.lines = [...new Set(rs.map((x) => x.short))].sort((a, b) => a.localeCompare(b, 'nl', { numeric: true }));
    if (st.modes.length) st.metro = st.modes.includes('metro');
  }

  // Pass 1: which shapes pass through the area, and how long is each.
  const dLat = AREA.radiusKm / 111, dLon = AREA.radiusKm / 69; // bbox prefilter, cheap per row
  const touching = new Set(), count = new Map();
  await readCsv(open('shapes.txt'), (c, i) => {
    const id = c[i.shape_id];
    count.set(id, (count.get(id) ?? 0) + 1);
    if (touching.has(id)) return;
    const lat = +c[i.shape_pt_lat], lon = +c[i.shape_pt_lon];
    if (Math.abs(lat - AREA.lat) < dLat && Math.abs(lon - AREA.lon) < dLon && distKm(AREA, { lat, lon }) <= AREA.radiusKm) touching.add(id);
  });
  // shortcut: one (longest) shape per route; branches/short-turn variants are not drawn separately.
  const best = new Map();
  for (const id of count.keys()) {
    const route = shapeRoute.get(id);
    if (!touching.has(id) && !isRetMetro(route)) continue;
    if (route && r[route] && modeOf(r[route].type) !== 'train' && (count.get(id) > (count.get(best.get(route)) ?? 0))) best.set(route, id);
  }
  const wanted = new Map([...best].map(([route, id]) => [id, route]));

  // Pass 2: collect the points of the chosen shapes.
  const pts = new Map();
  await readCsv(open('shapes.txt'), (c, i) => {
    const id = c[i.shape_id];
    if (!wanted.has(id)) return;
    let a = pts.get(id);
    if (!a) pts.set(id, (a = []));
    a.push([+c[i.shape_pt_sequence], +(+c[i.shape_pt_lon]).toFixed(5), +(+c[i.shape_pt_lat]).toFixed(5)]);
  });
  const lines = [...pts].map(([id, a]) => {
    const route = r[wanted.get(id)], mode = modeOf(route.type);
    return {
      routeId: wanted.get(id), line: route.short, name: route.long, mode, color: lineColor(route.short, mode, route.agency), operator: route.agency,
      coords: thin(a.sort((x, y) => x[0] - y[0]).map((p) => [p[1], p[2]])),
    };
  });
  await snapToRoads(lines);
  const railed = await onRealTracks(lines);

  const data = { date: serviceDate(0), savedAt: Date.now(), railMissing: lines.railMissing, routes: r, stops: s, stations: stationList, lines: railed, trips, timetable };
  await fs.writeFile(STATIC_CACHE, JSON.stringify(data));
  return data;
}

// Some operators (RET buses) publish shapes as straight hops between stops. Route those through
// the road network with the public OSRM demo (≤1 req/s, once a day). Dense shapes are already exact.
async function snapToRoads(lines) {
  const cacheFile = new URL('snapped.json', DATA); // shapes rarely change: only ask OSRM for new ones
  const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8').catch(() => '{}'));
  const sparse = lines.filter((l) => l.mode === 'bus' && l.coords.length >= 2 && l.coords.length <= 100
    && (polylineKm(l.coords) * 1000) / l.coords.length > 150);
  let asked = 0;
  for (const l of sparse) {
    const id = `${l.routeId}:${l.coords.length}:${l.coords[0]}:${l.coords.at(-1)}`;
    if (!cache[id]) {
      if (!asked++) console.log(`${sparse.length} buslijnen op de weg leggen (nieuwe via OSRM)…`);
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${l.coords.map((p) => p.join(',')).join(';')}?geometries=geojson&overview=full&continue_straight=false`;
        const j = await fetch(url, { headers: UA }).then((res) => res.json());
        const geo = j.routes?.[0]?.geometry.coordinates;
        // a big detour means OSRM took a road the bus doesn't (bus lane, one-way); keep the original then
        cache[id] = geo && polylineKm(geo) < polylineKm(l.coords) * 1.6 ? thin(geo.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]), 8) : l.coords;
      } catch (e) { console.error(`Lijn ${l.line} niet op de weg gelegd:`, e.message); }
      await new Promise((ok) => setTimeout(ok, 1100)); // OSRM demo policy: max 1 request per second
    }
    if (cache[id]) l.coords = cache[id];
  }
  await fs.writeFile(cacheFile, JSON.stringify(cache));
}

// Metro and tram: GTFS only has straight hops between stations. Take the real track from OpenStreetMap
// (route relations operated by RET), cached for a week; on failure keep the GTFS shape.
async function onRealTracks(lines) {
  const cacheFile = new URL('osm-rail-v2.json', DATA); // v2: corridors instead of one polyline per line
  let osm;
  const stat = await fs.stat(cacheFile).catch(() => null);
  if (stat && Date.now() - stat.mtimeMs < 7 * DAY) osm = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  else {
    try {
      console.log('Metro- en tramsporen ophalen bij OpenStreetMap…');
      const q = '[out:json][timeout:150];relation["type"="route"]["route"~"^(subway|light_rail|tram)$"]["operator"="RET"]->.r;.r out body qt;way(r.r);out skel geom qt;';
      // public Overpass servers are often busy (502/504): try the mirrors in turn
      let els, lastErr;
      for (const host of ['https://overpass-api.de', 'https://overpass.private.coffee', 'https://maps.mail.ru/osm/tools/overpass']) {
        try {
          const res = await fetch(`${host}/api/interpreter`, { method: 'POST', headers: UA, body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(180_000) });
          if (!res.ok) throw new Error(`${host}: HTTP ${res.status}`);
          els = (await res.json()).elements;
          break;
        } catch (e) { lastErr = e; }
      }
      if (!els) throw lastErr;
      osm = osmToRail(els);
      await fs.writeFile(cacheFile, JSON.stringify(osm));
    } catch (e) {
      console.error('OSM-sporen ophalen mislukt, rechte lijnen blijven:', e.message);
      osm = stat ? JSON.parse(await fs.readFile(cacheFile, 'utf8')) : null;
    }
  }
  lines.railMissing = !osm; // loadStatic retries soon instead of keeping straight metro lines all day
  osm ??= [];
  // one template per RET rail line we know from GTFS; its GTFS shape is replaced by the corridors
  const tmpl = new Map();
  for (const l of lines) if (l.operator === 'RET' && (l.mode === 'metro' || l.mode === 'tram')) tmpl.set(`${l.mode}|${l.line}`, l);
  const onOsm = new Set(osm.flatMap((c) => c.lines).filter((k) => tmpl.has(k)));
  const out = lines.filter((l) => !(l.operator === 'RET' && onOsm.has(`${l.mode}|${l.line}`)));
  for (const c of osm) {
    const here = c.lines.filter((k) => tmpl.has(k));
    here.forEach((k, i) => out.push({ ...tmpl.get(k), coords: c.coords, lane: i - (here.length - 1) / 2 })); // lane: side-by-side slot
  }
  return out;
}

let loaded = null; // { date, savedAt, railMissing } of what is in memory
const stale = (d) => !d || d.date !== serviceDate(0) || (d.railMissing && Date.now() - d.savedAt > 15 * 60e3);

async function loadStatic() {
  if (!stale(loaded)) return;
  let data;
  try {
    data = JSON.parse(await fs.readFile(STATIC_CACHE, 'utf8'));
    if (stale(data)) data = null; // timetable is per day; missing OSM tracks are retried after 15 min
  } catch {}
  data ??= await buildStatic();
  loaded = { date: data.date, savedAt: data.savedAt, railMissing: data.railMissing };
  routes = new Map(Object.entries(data.routes));
  stops = new Map(Object.entries(data.stops));
  stations = data.stations;
  timetable = data.timetable;
  tripInfo = data.trips;
  for (const l of data.lines) { // colour is not cached: it must match the live vehicles' colour exactly
    l.operator ??= data.routes[l.routeId]?.agency;
    l.color = lineColor(l.line, l.mode, l.operator);
  }
  lineKeys = new Set(data.lines.map(lineKey));
  staticGz = zlib.gzipSync(JSON.stringify({ lines: data.lines, stations: stations.map(({ stopIds, ...st }) => st), area: AREA }));
  console.log(`Dienstregeling: ${data.lines.length} lijnen in de buurt, ${stations.length} haltes`);
}

// ---------- realtime ----------
const feeds = {}; // name → { modified, msg }; conditional GET keeps us under OVapi's rate limit
async function getFeed(name) {
  const prev = feeds[name];
  const res = await fetch(`${FEED}/${name}`, { headers: { ...UA, ...(prev?.modified && { 'If-Modified-Since': prev.modified }) } });
  if (res.status === 304) return false;
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  feeds[name] = { modified: res.headers.get('last-modified'), msg: FeedMessage.decode(new Uint8Array(await res.arrayBuffer())) };
  return true;
}

function rebuild() {
  const vp = feeds['vehiclePositions.pb']?.msg, tu = feeds['tripUpdates.pb']?.msg;
  if (!vp) return;
  liveTrips = indexTripUpdates(tu);
  const t = Number(vp.header?.timestamp ?? Date.now() / 1000);
  // every vehicle on a line we draw, wherever it is on that line, plus anything else in the area
  const keep = (pos, r) => lineKeys.has(lineKey(r)) || distKm(AREA, pos) <= AREA.radiusKm;
  const headsignOf = (id) => (tripInfo[id]?.headsign ? cleanStopName(tripInfo[id].headsign) : null);
  const vehicles = buildVehicles(vp, liveTrips, routes, stops, Date.now() / 1000, keep, headsignOf);
  for (const v of vehicles) applyKv6(v, kv6.get(v.id)); // the live stream is newer than OVapi's minute feed
  // previous GPS fix per vehicle, so a browser can estimate speed from its very first snapshot
  const fixes = new Map();
  for (const v of vehicles) {
    const p = lastFixes.get(v.id);
    v.prev = p && p.ts !== v.updatedAt ? [p.lon, p.lat, p.ts] : p?.prev ?? null;
    fixes.set(v.id, { lon: v.lon, lat: v.lat, ts: v.updatedAt, prev: v.prev });
  }
  lastFixes = fixes;
  if (routes.size) record(vehicles, t); // only once line names are known
  snapshot = {
    vehicles, fetchedAt: t * 1000,
    stats: { since: history.frames[0]?.t ?? t, operators: punctuality(history.tripDelays) },
  };
  snapshotIds = new Map(vehicles.map((v) => [v.id, v]));
  lastMsg = null;
  for (const res of clients) res.write(snapshotMsg());
}
// serialised once per change, sent to every client; patches mark it stale for the next new client
let lastMsg = null, snapshotIds = new Map();
const snapshotMsg = () => (lastMsg ??= `data: ${JSON.stringify(snapshot)}\n\n`);

// ---------- KV6 live stream (GOVI, formerly NDOV Loket): positions and stop events within ~1 s ----------
// OVapi's GTFS-rt refreshes once a minute with ~20 s old positions and says nothing about stops. KV6 reports
// ARRIVAL / DEPARTURE / ONROUTE per vehicle as it happens. Open best-effort feed, CC0 data, fair use:
// one connection per consumer. https://govi.nu/realtime.html
const KV6_ENVELOPES = ['RIG', 'QBUZZ', 'ARR', 'EBS', 'CXX', 'IVU'].map((op) => `/${op}/KV6posinfo`); // RIG = RET + HTM
const kv6 = new Map(); // vehicle id → { lon, lat, ts, state, stateTs, delay }
const patches = new Map(); // id → latest state, flushed to browsers every second
const STATE = { ARRIVAL: 'stop', ONSTOP: 'stop', INIT: 'stop', DEPARTURE: 'moving', ONROUTE: 'moving' };

function applyKv6(v, k) {
  if (!k) return;
  if (k.lon != null && k.ts > v.updatedAt) Object.assign(v, { lon: k.lon, lat: k.lat, updatedAt: k.ts });
  if (k.delay != null) v.delaySec = k.delay;
  v.state = k.state ?? null;
  v.stateTs = k.stateTs ?? null;
}

function onKv6(ev) {
  if (!ev.ts || ev.type === 'END') { kv6.delete(ev.id); return; }
  const k = kv6.get(ev.id) ?? {};
  if (k.stateTs && ev.ts < k.stateTs - 1) return; // late, out-of-order message
  if (ev.lat != null && !(ev.ts < k.ts)) Object.assign(k, { lon: +ev.lon.toFixed(6), lat: +ev.lat.toFixed(6), ts: ev.ts });
  if (STATE[ev.type]) Object.assign(k, { state: STATE[ev.type], stateTs: ev.ts });
  if (ev.delay != null) k.delay = ev.delay;
  kv6.set(ev.id, k);
  const v = snapshotIds.get(ev.id); // only vehicles the map shows
  if (v) { applyKv6(v, k); patches.set(ev.id, v); }
}

async function listenKv6() {
  for (;;) {
    const sock = new Subscriber({ receiveTimeout: 120_000 }); // silence for 2 min = dead connection
    try {
      sock.connect('tcp://pubsub.besteffort.ndovloket.nl:7658');
      for (const e of KV6_ENVELOPES) sock.subscribe(e);
      console.log('KV6-livestream verbonden');
      for await (const [, ...parts] of sock) {
        const body = Buffer.concat(parts);
        let xml;
        try { xml = zlib.gunzipSync(body).toString(); } catch { xml = body.toString(); } // gzip, but be lenient
        for (const ev of parseKV6(xml)) onKv6(ev);
      }
    } catch (e) {
      console.error('KV6-livestream onderbroken, opnieuw over 30 s:', e.message ?? e.code);
    } finally { sock.close(); }
    await new Promise((ok) => setTimeout(ok, 30_000));
  }
}

setInterval(() => {
  if (!patches.size) return;
  // [id, lon, lat, positionTs, state, stateTs, delay] per changed vehicle
  const rows = [...patches.values()].map((v) => [v.id, v.lon, v.lat, v.updatedAt, v.state, v.stateTs, v.delaySec]);
  patches.clear();
  lastMsg = null;
  const msg = `event: patch\ndata: ${JSON.stringify(rows)}\n\n`;
  for (const res of clients) res.write(msg);
}, 1000);
setInterval(() => { const old = Date.now() / 1000 - 1800; for (const [id, k] of kv6) if ((k.stateTs ?? k.ts) < old) kv6.delete(id); }, 60_000);

// Timelapse downloads are big (a few MB gzipped): compress once per new frame and 10-minute window, not per request.
let historyGz = { key: '', body: null };
function historyBody(since) {
  const bucket = Math.floor(since / 600) * 600;
  const key = `${history.date}:${bucket}:${history.frames.length}`;
  if (historyGz.key !== key) historyGz = { key, body: zlib.gzipSync(JSON.stringify(history.frames.filter((f) => f.t > bucket))) };
  return historyGz.body;
}

async function poll(name) {
  try { if (await getFeed(name)) rebuild(); }
  catch (err) { console.error('Realtime ophalen mislukt:', err.message); } // keep serving the last good copy
}

// ---------- http ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { // for the host's health check: live data younger than 5 min
    const ok = staticGz && Date.now() - snapshot.fetchedAt < 5 * 60e3;
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: !!ok, vehicles: snapshot.vehicles.length, clients: clients.size }));
  }
  if (url.pathname === '/api/stream') {
    if (clients.size >= MAX_CLIENTS) { res.writeHead(503, { 'Retry-After': '60' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(clockMsg() + snapshotMsg()); // clock first, so the very first prediction is right
    clients.add(res);
    return req.on('close', () => clients.delete(res));
  }
  if (url.pathname === '/api/static') {
    if (!staticGz) { res.writeHead(503); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-cache' }); // changes daily
    return res.end(staticGz);
  }
  if (url.pathname === '/api/history') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
    return res.end(historyBody(Number(url.searchParams.get('since')) || 0));
  }
  const dep = url.pathname.match(/^\/api\/station\/(st\d+)$/);
  if (dep) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(stationDepartures(timetable[dep[1]] ?? [], tripInfo, routes, liveTrips)));
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!/^[\w.-]+$/.test(file)) { res.writeHead(404); return res.end(); } // no path traversal
  try {
    const body = await fs.readFile(new URL(`./public/${file}`, import.meta.url));
    // no-cache: always revalidate, so an update never runs against a stale app.js (that caused "0 onderweg")
    res.writeHead(200, { 'Content-Type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));

await fs.mkdir(DATA, { recursive: true });
await loadHistory();
// Positions change often → poll every 10 s (only downloads when changed, ~once a minute).
poll('vehiclePositions.pb'); poll('tripUpdates.pb');
setInterval(() => poll('vehiclePositions.pb'), 10_000);
// trip updates: 1.5 MB gzipped per change (~2 GB/day at once a minute). KV6 now delivers delays live,
// so every 2 min is enough for destinations and station departures, and halves the traffic.
setInterval(() => poll('tripUpdates.pb'), 120_000);
listenKv6(); // runs forever, reconnects itself
await loadStatic().catch((e) => console.error('Dienstregeling mislukt:', e.message));
rebuild();
setInterval(() => loadStatic().catch((e) => console.error('Dienstregeling verversen mislukt:', e.message)), 20 * 60e3); // cheap when cached
// SSE keep-alive so proxies don't drop idle streams
// Server time for the browsers (their clocks may be off; predictions depend on "now"). Doubles as the
// SSE keep-alive so proxies don't drop idle streams. Run the server with NTP (Linux default).
const clockMsg = () => `event: clock\ndata: ${Date.now()}\n\n`;
setInterval(() => { const msg = clockMsg(); for (const res of clients) res.write(msg); }, 15_000);
