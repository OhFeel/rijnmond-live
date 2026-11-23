import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVehicles, chainWays, osmToRail, parseKV6, rdToWgs84, vehicleModel, dayStart, groupStations, gtfsSecs, indexTripUpdates, modeOf, parseCsvLine, punctuality, stationDepartures, thin } from './lib.js';

test('builds nearby vehicles with delay, next stop and destination; drops far and stale ones', () => {
  const now = 1_000_000;
  const vp = { entity: [
    { id: 'a', vehicle: { position: { latitude: 51.918, longitude: 4.60 }, timestamp: now - 10, trip: { tripId: 't1', routeId: 'r1' } } },
    { id: 'far', vehicle: { position: { latitude: 52.37, longitude: 4.89 }, timestamp: now, trip: { tripId: 't1', routeId: 'r1' } } },
    { id: 'stale', vehicle: { position: { latitude: 51.918, longitude: 4.60 }, timestamp: now - 900, trip: {} } },
    { id: 'm', vehicle: { position: { latitude: 51.921, longitude: 4.556 }, timestamp: now, trip: { routeId: 'r2' } } },
  ] };
  const tu = indexTripUpdates({ entity: [{ tripUpdate: { trip: { tripId: 't1' }, stopTimeUpdate: [
    { stopId: 's0', arrival: { time: now - 120, delay: 60 } },
    { stopId: 's1', arrival: { time: now + 60, delay: 240 } },
    { stopId: 's2', arrival: { time: now + 600, delay: 240 } },
  ] } }] });
  const routes = new Map([['r1', { short: '30', type: '3' }], ['r2', { short: 'C', type: '1' }]]);
  const stops = new Map([['s1', 'Raadhuisplein'], ['s2', 'Rotterdam Centraal']]);

  const out = buildVehicles(vp, tu, routes, stops, now);
  assert.deepEqual(out.map((v) => v.id), ['a', 'm']);
  assert.equal(out[0].delaySec, 240);
  assert.equal(out[0].nextStop, 'Raadhuisplein');
  assert.equal(out[0].destination, 'Rotterdam Centraal');
  assert.equal(out[1].mode, 'metro');
  assert.equal(out[1].delaySec, null);
  // the timetable's headsign wins over the last live-updated stop
  assert.equal(buildVehicles(vp, tu, routes, stops, now, undefined, (id) => (id === 't1' ? 'Capelsebrug' : null))[0].destination, 'Capelsebrug');
});

test('groups platforms into one station', () => {
  const stations = groupStations([
    { id: '1', name: 'Rotterdam, Metro Capelsebrug (Perron D)', lat: 51.92086, lon: 4.55689 },
    { id: '2', name: 'Rotterdam, Capelsebrug Hoog', lat: 51.921025, lon: 4.557323 },
    { id: '3', name: '[Capelsebrug] Metrostation Capelsebrug', lat: 51.921254, lon: 4.5579 },
    { id: '4', name: 'Krimpen a/d IJssel, Centrum', lat: 51.917, lon: 4.6 },
  ]);
  assert.equal(stations.length, 2);
  assert.equal(stations[0].name, 'Capelsebrug');
  assert.equal(stations[0].metro, true);
  assert.deepEqual(stations[0].stopIds, ['1', '2', '3']);

});

test('station departures: timetable + live delay propagated from an earlier stop; terminus skipped', () => {
  const day = '20261123', start = dayStart(day);
  const now = start + gtfsSecs('10:00:00');
  const trips = {
    t1: { route: 'm', headsign: 'Rotterdam, De Akkers', dates: [day], last: 30 },
    t2: { route: 'm', headsign: 'De Terp', dates: [day], last: 5 },
    t3: { route: 'b', headsign: 'Krimpen', dates: ['20261124'], last: 9 }, // tomorrow: outside window
  };
  const rows = [['t1', gtfsSecs('10:05:00'), 7], ['t2', gtfsSecs('10:02:00'), 5], ['t3', gtfsSecs('10:03:00'), 2]];
  const live = indexTripUpdates({ entity: [{ tripUpdate: { trip: { tripId: 't1' }, stopTimeUpdate: [
    { stopSequence: 3, stopId: 'x', departure: { time: now, delay: 120 } },
  ] } }] });
  const routes = new Map([['m', { short: 'C', type: '1' }], ['b', { short: '30', type: '3' }]]);
  const out = stationDepartures(rows, trips, routes, live, now);
  assert.deepEqual(out.map((d) => [d.line, d.destination, d.delaySec, d.time - now]), [['C', 'De Akkers', 120, 420]]);
  assert.equal(gtfsSecs('25:10:00'), 90600);
});

test('thin keeps endpoints and drops near-duplicate points', () => {
  assert.deepEqual(thin([[4.5, 51.9], [4.50001, 51.9], [4.51, 51.9]]), [[4.5, 51.9], [4.51, 51.9]]);
});

test('punctuality per operator: -1..+3 min counts as on time; unknown delays ignored', () => {
  const m = new Map([
    ['a', { op: 'RET', delay: 0 }], ['b', { op: 'RET', delay: 240 }], ['c', { op: 'RET', delay: -30 }],
    ['d', { op: 'Arriva', delay: -120 }], ['e', { op: 'Arriva', delay: null }],
  ]);
  assert.deepEqual(punctuality(m), [
    { operator: 'RET', trips: 3, onTimePct: 67, latePct: 33, avgDelayMin: 1.2 },
    { operator: 'Arriva', trips: 1, onTimePct: 0, latePct: 0, avgDelayMin: -2 },
  ]);
});

test('chainWays joins ways that share endpoints, reversing where needed', () => {
  const out = chainWays([[[0, 0], [1, 0]], [[2, 0], [1, 0]], [[2, 0], [3, 0]], [[9, 9], [9, 8]]]);
  assert.deepEqual(out, [[[0, 0], [1, 0], [2, 0], [3, 0]], [[9, 9], [9, 8]]]);
});

test('osmToRail splits track into corridors per set of lines, oriented west→east', () => {
  const els = [
    { type: 'way', id: 1, geometry: [{ lon: 4.2, lat: 51.9 }, { lon: 4.1, lat: 51.9 }] }, // shared, drawn east→west
    { type: 'way', id: 2, geometry: [{ lon: 4.2, lat: 51.9 }, { lon: 4.3, lat: 51.9 }] }, // A only
    { type: 'relation', tags: { route: 'subway', ref: 'B' }, members: [{ type: 'way', ref: 1, role: '' }, { type: 'node', ref: 9, role: 'stop' }] },
    { type: 'relation', tags: { route: 'subway', ref: 'A' }, members: [{ type: 'way', ref: 1, role: '' }, { type: 'way', ref: 2, role: '' }] },
  ];
  assert.deepEqual(osmToRail(els), [
    { lines: ['metro|A', 'metro|B'], coords: [[4.1, 51.9], [4.2, 51.9]] },
    { lines: ['metro|A'], coords: [[4.2, 51.9], [4.3, 51.9]] },
  ]);
});

test('vehicle model from RET fleet number', () => {
  assert.deepEqual(vehicleModel('RET', 'metro', '5702'), { model: 'Bombardier HSG3', since: 2015 });
  assert.deepEqual(vehicleModel('RET', 'tram', '2027'), { model: 'Alstom Citadis 302', since: 2003 });
  assert.equal(vehicleModel('RET', 'bus', '1001'), null);
  assert.equal(vehicleModel('RET', 'metro', '9999'), null);
});

test('rdToWgs84: Amersfoort origin and the published Westertoren reference point', () => {
  const o = rdToWgs84(155000, 463000);
  assert.equal(o.lat.toFixed(6), '52.155174');
  assert.equal(o.lon.toFixed(6), '5.387206');
  const w = rdToWgs84(120700.723, 487525.501); // Westertoren, Amsterdam: 52.37453253 N, 4.88352559 E
  assert.equal(w.lat.toFixed(6), '52.374533');
  assert.equal(w.lon.toFixed(6), '4.883526');
});

test('parseKV6 reads prefixed and plain KV6 messages; -1 coordinates mean no position', () => {
  const xml = `<tmi8:KV6posinfo><tmi8:ONROUTE><tmi8:dataownercode>RET</tmi8:dataownercode><tmi8:lineplanningnumber>M009</tmi8:lineplanningnumber>
    <tmi8:operatingday>2026-11-23</tmi8:operatingday><tmi8:journeynumber>595959</tmi8:journeynumber><tmi8:userstopcode>HA0114</tmi8:userstopcode>
    <tmi8:timestamp>2026-11-23T13:30:01.402+01:00</tmi8:timestamp><tmi8:vehiclenumber>5337</tmi8:vehiclenumber><tmi8:punctuality>48</tmi8:punctuality>
    <tmi8:rd-x>155000</tmi8:rd-x><tmi8:rd-y>463000</tmi8:rd-y></tmi8:ONROUTE>
    <DEPARTURE><dataownercode>QBUZZ</dataownercode><lineplanningnumber>g314</lineplanningnumber><operatingday>2026-11-23</operatingday>
    <journeynumber>36</journeynumber><timestamp>2026-11-23T13:30:05+01:00</timestamp><punctuality>-20</punctuality><rd-x>-1</rd-x><rd-y>-1</rd-y></DEPARTURE></tmi8:KV6posinfo>`;
  const [a, b] = parseKV6(xml);
  assert.equal(a.type, 'ONROUTE');
  assert.equal(a.id, '2026-11-23:RET:M009:595959');
  assert.equal(a.ts, Date.parse('2026-11-23T12:30:01.402Z') / 1000);
  assert.equal(a.lat.toFixed(4), '52.1552');
  assert.equal(a.delay, 48);
  assert.equal(a.vehicleNo, '5337');
  assert.deepEqual([b.type, b.id, b.delay, b.lat], ['DEPARTURE', '2026-11-23:QBUZZ:g314:36', -20, undefined]);
});

test('helpers', () => {
  assert.equal(modeOf('700'), 'bus');
  assert.equal(modeOf('401'), 'metro');
  assert.deepEqual(parseCsvLine('1,"a, ""b""",c'), ['1', 'a, "b"', 'c']);
});
