/* Guelph Transit proposed network, animated.
 *
 * Everything is simulated from data/network.json: per route, two directions with a
 * line and stops, and per day type a list of service windows (start, end, headway,
 * average speed). See README.md for the assumptions.
 */
(function () {
  'use strict';

  const COLORS = { frequent: '#d94f00', base: '#1b6fb5', university: '#7b3fb8' };
  const DAY_LABEL = { weekday: 'Weekday', saturday: 'Saturday', sunday: 'Sunday' };
  const T_MIN = 300 * 60;   // 05:00
  const T_MAX = 1560 * 60;  // 02:00 next day

  // The rider: walks in straight lines at WALK_SPEED, with WALK_DETOUR for the streets
  // not being straight.
  const WALK_SPEED = 4.8 / 3.6;   // m/s
  const WALK_DETOUR = 1.3;
  const TRANSFER_RADIUS = 300;    // m, straight line, between stops when changing buses
  const TRANSFER_SLACK = 60;      // s needed at a stop before boarding the next bus
  const BOARD_PENALTY = 180;      // s a boarding must save to be worth making
  const MAX_BOARDINGS = 4;

  const state = { day: 'weekday', t: 7 * 3600, playing: true, speed: 300 };
  const rider = { pos: null, plan: null, marker: null, destMarker: null, step: null, draggedAt: 0 };
  let net = null;
  let map = null;
  let lastWidths = '';

  // ---------- geometry ----------

  function haversine(a, b) {
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Index of the last element of a sorted array that is <= x (clamped to [0, n-2]).
  function segment(arr, x) {
    let lo = 0, hi = arr.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= x) lo = mid; else hi = mid;
    }
    return lo;
  }

  function prepare(data) {
    for (const route of data.routes) {
      for (const dir of route.dirs) {
        const cum = [0];
        for (let i = 1; i < dir.line.length; i++) cum.push(cum[i - 1] + haversine(dir.line[i - 1], dir.line[i]));
        dir.cum = cum;
        dir.stopD = dir.stops.map(s => s.d);
        dir.stopM = dir.stops.map(s => s.m);
      }
    }
    // Physical stops (several routes share one) and, for each, the stops close enough
    // to walk to for a transfer.
    const index = new Map();
    data.ustops = [];
    for (const route of data.routes) for (const dir of route.dirs) for (const s of dir.stops) {
      const key = s.lon + ',' + s.lat;
      if (!index.has(key)) { index.set(key, data.ustops.length); data.ustops.push({ name: s.name, pos: [s.lon, s.lat], near: [] }); }
      s.u = index.get(key);
    }
    for (let a = 0; a < data.ustops.length; a++) for (let b = a + 1; b < data.ustops.length; b++) {
      const m = haversine(data.ustops[a].pos, data.ustops[b].pos);
      if (m > TRANSFER_RADIUS) continue;
      const secs = m * WALK_DETOUR / WALK_SPEED;
      data.ustops[a].near.push({ u: b, secs });
      data.ustops[b].near.push({ u: a, secs });
    }
    return data;
  }

  // Point `m` metres along a direction's line.
  function pointAtM(dir, m) {
    const j = segment(dir.cum, m);
    const c0 = dir.cum[j], c1 = dir.cum[j + 1];
    const g = c1 > c0 ? Math.min(1, Math.max(0, (m - c0) / (c1 - c0))) : 0;
    const a = dir.line[j], b = dir.line[j + 1];
    return [a[0] + g * (b[0] - a[0]), a[1] + g * (b[1] - a[1])];
  }

  // Position of a bus that has covered `d` metres (Remix distance) of a direction.
  // Remix distances are mapped onto our line through the stops, so a shape that is a
  // little longer or shorter than Remix's still puts the bus at each stop on time.
  function positionAt(dir, d) {
    const i = segment(dir.stopD, d);
    const d0 = dir.stopD[i], d1 = dir.stopD[i + 1];
    const f = d1 > d0 ? Math.min(1, Math.max(0, (d - d0) / (d1 - d0))) : 0;
    return pointAtM(dir, dir.stopM[i] + f * (dir.stopM[i + 1] - dir.stopM[i]));
  }

  // The part of a direction's line between two of its stops.
  function lineBetween(dir, i0, i1) {
    const m0 = dir.stopM[i0], m1 = dir.stopM[i1];
    const pts = [pointAtM(dir, m0)];
    for (let j = 0; j < dir.cum.length; j++) if (dir.cum[j] > m0 && dir.cum[j] < m1) pts.push(dir.line[j]);
    pts.push(pointAtM(dir, m1));
    return pts;
  }

  // ---------- simulation ----------

  // A window sends a bus from the start of direction 0 every `headway` seconds, from
  // `start` up to but not including `end`. Each bus runs direction 0, lays over, runs
  // direction 1, and is then done.
  function tripTimes(route, w) {
    const v = w.speed / 3.6;
    const run0 = route.dirs[0].length / v;
    const run1 = route.dirs[1].length / v;
    const lay = Math.max(net.layover.seconds, net.layover.share * run0);
    return { v, run0, run1, lay, cycle: run0 + lay + run1 };
  }

  function busesAt(t, day) {
    const out = [];
    for (let r = 0; r < net.routes.length; r++) {
      const route = net.routes[r];
      for (const w of route.service[day]) {
        const start = w.start * 60, end = w.end * 60;
        if (t < start) continue;
        const tt = tripTimes(route, w);
        const kLast = Math.min(Math.floor((t - start) / w.headway), Math.ceil((end - start) / w.headway) - 1);
        const kFirst = Math.max(0, Math.floor((t - start - tt.cycle) / w.headway) + 1);
        for (let k = kFirst; k <= kLast; k++) {
          const e = t - (start + k * w.headway);
          if (e < 0 || e >= tt.cycle) continue;
          let dirIdx, d, waiting = false;
          if (e < tt.run0) { dirIdx = 0; d = e * tt.v; }
          else if (e < tt.run0 + tt.lay) { dirIdx = 0; d = route.dirs[0].length; waiting = true; }
          else { dirIdx = 1; d = (e - tt.run0 - tt.lay) * tt.v; }
          out.push({ r, dirIdx, waiting, pos: positionAt(route.dirs[dirIdx], d) });
        }
      }
    }
    return out;
  }

  function headwayAt(route, t, day) {
    for (const w of route.service[day]) if (t >= w.start * 60 && t < w.end * 60) return w.headway;
    return 0;
  }

  // ---------- trip planning ----------
  //
  // The rider uses the same made-up timetable the bus dots follow: a bus of a window's
  // trip k is at stop i of direction 0 at start + k * headway + d_i / v, and of
  // direction 1 the outbound run and the layover later.

  function walkSecs(a, b) {
    return haversine(a, b) * WALK_DETOUR / WALK_SPEED;
  }

  // The first bus of a direction that leaves stop `i` at or after `ready`.
  function earliestTrip(route, di, i, ready, day) {
    let best = null;
    for (const w of route.service[day]) {
      const tt = tripTimes(route, w);
      const base = w.start * 60 + (di ? tt.run0 + tt.lay : 0) + route.dirs[di].stopD[i] / tt.v;
      const kMax = Math.ceil((w.end - w.start) * 60 / w.headway) - 1;
      const k = Math.max(0, Math.ceil((ready - base) / w.headway - 1e-9));
      if (k > kMax) continue;
      const dep = base + k * w.headway;
      if (!best || dep < best.dep) best = { dep, start: dep - route.dirs[di].stopD[i] / tt.v, v: tt.v };
    }
    return best;
  }

  // Earliest arrival from `from` to `to` leaving at `t0`, in rounds of one more boarding
  // each (RAPTOR). Returns the legs to follow, with their times.
  function planTrip(from, to, t0, day) {
    const stops = net.ustops, n = stops.length;
    const best = new Float64Array(n);
    let prev = new Float64Array(n);
    const how = [new Array(n)];             // how[k][u]: what brought the rider to u in round k
    for (let u = 0; u < n; u++) prev[u] = best[u] = t0 + walkSecs(from, stops[u].pos);

    const direct = t0 + walkSecs(from, to);
    let win = { score: direct, k: 0, u: -1 };

    for (let k = 1; k <= MAX_BOARDINGS; k++) {
      const cur = new Float64Array(n).fill(Infinity);
      how.push(new Array(n));
      const reached = [];
      net.routes.forEach((route, r) => route.dirs.forEach((dir, di) => {
        let trip = null;
        for (let i = 0; i < dir.stops.length; i++) {
          const u = dir.stops[i].u;
          if (trip && i > trip.i0) {
            const arr = trip.start + dir.stopD[i] / trip.v;
            if (arr < cur[u] && arr < best[u]) {
              cur[u] = arr;
              how[k][u] = { r, di, i0: trip.i0, i1: i, start: trip.start, v: trip.v };
            }
          }
          if (prev[u] === Infinity) continue;
          const c = earliestTrip(route, di, i, prev[u] + (k > 1 ? TRANSFER_SLACK : 0), day);
          if (!c) continue;
          // Take an earlier bus, or board the same bus here if the rider is here sooner
          // (the stop nearest to where they started, not the first one on the line).
          const gain = trip ? trip.start + dir.stopD[i] / trip.v - c.dep : Infinity;
          if (gain > 1e-6 || (gain > -1e-6 && prev[u] < trip.ready)) trip = { start: c.start, v: c.v, i0: i, ready: prev[u] };
        }
      }));
      for (let u = 0; u < n; u++) if (cur[u] < Infinity) reached.push([u, cur[u], how[k][u]]);
      if (!reached.length) break;
      // Walk from where a bus dropped the rider to the stops nearby.
      for (const [u, arr, ride] of reached) for (const nb of stops[u].near) {
        const a = arr + nb.secs;
        if (a < cur[nb.u] && a < best[nb.u]) { cur[nb.u] = a; how[k][nb.u] = Object.assign({ walkFrom: u }, ride); }
      }
      for (let u = 0; u < n; u++) {
        if (cur[u] === Infinity) continue;
        best[u] = Math.min(best[u], cur[u]);
        const score = cur[u] + walkSecs(stops[u].pos, to) + k * BOARD_PENALTY;
        if (score < win.score) win = { score, k, u };
      }
      prev = cur;
    }

    // Walk the winner back to the start, then time the legs forwards.
    const legs = [];
    let { k, u } = win;
    let end = to, endName = null;
    while (k > 0) {
      const h = how[k][u];
      if (h.walkFrom !== undefined) {
        legs.unshift({ type: 'walk', a: stops[h.walkFrom].pos, b: end, to: endName });
        end = stops[h.walkFrom].pos;
      } else if (end !== stops[u].pos) {
        legs.unshift({ type: 'walk', a: stops[u].pos, b: end, to: endName });
      }
      const dir = net.routes[h.r].dirs[h.di];
      legs.unshift({ type: 'ride', r: h.r, di: h.di, i0: h.i0, i1: h.i1, start: h.start, v: h.v,
        t0: h.start + dir.stopD[h.i0] / h.v, t1: h.start + dir.stopD[h.i1] / h.v });
      u = dir.stops[h.i0].u;
      end = stops[u].pos;
      endName = stops[u].name;
      k--;
    }
    legs.unshift({ type: 'walk', a: from, b: end, to: endName });

    let t = t0;
    for (const leg of legs) {
      if (leg.type === 'walk') { leg.t0 = t; leg.t1 = t + walkSecs(leg.a, leg.b); }
      else leg.ready = t;           // the rider waits at the stop from `ready` to `t0`
      t = leg.t1;
    }
    return { from, to, day, t0, t1: t, legs: legs.filter(leg => leg.type === 'ride' || leg.t1 - leg.t0 >= 1) };
  }

  // Where the rider of a plan is at time `t`, and which leg they are on.
  function riderAt(plan, t) {
    if (t <= plan.t0) return { pos: plan.from, step: -1 };
    for (let i = 0; i < plan.legs.length; i++) {
      const leg = plan.legs[i];
      if (t >= leg.t1) continue;
      if (leg.type === 'walk') {
        const f = Math.max(0, (t - leg.t0) / (leg.t1 - leg.t0));
        return { pos: [leg.a[0] + f * (leg.b[0] - leg.a[0]), leg.a[1] + f * (leg.b[1] - leg.a[1])], step: i };
      }
      const dir = net.routes[leg.r].dirs[leg.di];
      return { pos: positionAt(dir, Math.max(t, leg.t0) * leg.v - leg.start * leg.v), step: i };
    }
    return { pos: plan.to, step: plan.legs.length };
  }

  function tripFeatures(plan) {
    const features = [];
    if (plan) for (const leg of plan.legs) {
      const ride = leg.type === 'ride';
      features.push({
        type: 'Feature',
        properties: { kind: leg.type, cls: ride ? net.routes[leg.r].class : '' },
        geometry: { type: 'LineString', coordinates: ride ? lineBetween(net.routes[leg.r].dirs[leg.di], leg.i0, leg.i1) : [leg.a, leg.b] },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  function widthFor(headway) {
    if (!headway) return 1.2;
    if (headway <= 600) return 6;
    if (headway <= 900) return 4.5;
    if (headway <= 1200) return 3.5;
    if (headway <= 1800) return 2.5;
    return 1.6;
  }

  // ---------- map ----------

  function routeFeatures() {
    const features = [];
    net.routes.forEach((route, r) => {
      route.dirs.forEach((dir, di) => {
        features.push({
          type: 'Feature',
          id: r * 2 + di,
          properties: { r, cls: route.class },
          geometry: { type: 'LineString', coordinates: dir.line },
        });
      });
    });
    return { type: 'FeatureCollection', features };
  }

  function stopFeatures() {
    const seen = new Set(), features = [];
    for (const route of net.routes) for (const dir of route.dirs) for (const s of dir.stops) {
      const key = s.lon + ',' + s.lat;
      if (seen.has(key)) continue;
      seen.add(key);
      features.push({ type: 'Feature', properties: { name: s.name }, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } });
    }
    return { type: 'FeatureCollection', features };
  }

  function busFeatures(buses) {
    return {
      type: 'FeatureCollection',
      features: buses.map(b => ({
        type: 'Feature',
        properties: { id: net.routes[b.r].id, cls: net.routes[b.r].class, waiting: b.waiting },
        geometry: { type: 'Point', coordinates: b.pos },
      })),
    };
  }

  const classColor = ['match', ['get', 'cls'], 'frequent', COLORS.frequent, 'university', COLORS.university, COLORS.base];

  function addLayers() {
    map.addSource('routes', { type: 'geojson', data: routeFeatures() });
    map.addSource('stops', { type: 'geojson', data: stopFeatures() });
    map.addSource('buses', { type: 'geojson', data: busFeatures([]) });

    const W = ['coalesce', ['feature-state', 'w'], 2];
    const linePaint = {
      'line-color': classColor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['*', 0.55, W], 13, W, 16, ['*', 1.6, W]],
      'line-opacity': ['case', ['boolean', ['feature-state', 'on'], true], 0.8, 0.3],
    };
    // Order: base, then university (dashed), then high-frequency on top.
    map.addLayer({ id: 'routes-base', type: 'line', source: 'routes', filter: ['==', ['get', 'cls'], 'base'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: linePaint });
    map.addLayer({ id: 'routes-university', type: 'line', source: 'routes', filter: ['==', ['get', 'cls'], 'university'],
      layout: { 'line-join': 'round' }, paint: Object.assign({ 'line-dasharray': [2, 1.5] }, linePaint) });
    map.addLayer({ id: 'routes-frequent', type: 'line', source: 'routes', filter: ['==', ['get', 'cls'], 'frequent'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: linePaint });

    map.addLayer({ id: 'stops', type: 'circle', source: 'stops', minzoom: 13.5,
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13.5, 1.5, 17, 4], 'circle-color': '#fff',
        'circle-stroke-color': '#55606e', 'circle-stroke-width': 1 } });

    map.addSource('trip', { type: 'geojson', data: tripFeatures(null) });
    map.addLayer({ id: 'trip-ride-case', type: 'line', source: 'trip', filter: ['==', ['get', 'kind'], 'ride'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1c2330', 'line-width': 9 } });
    map.addLayer({ id: 'trip-ride', type: 'line', source: 'trip', filter: ['==', ['get', 'kind'], 'ride'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': classColor, 'line-width': 5 } });
    map.addLayer({ id: 'trip-walk', type: 'line', source: 'trip', filter: ['==', ['get', 'kind'], 'walk'],
      paint: { 'line-color': '#1c2330', 'line-width': 3, 'line-dasharray': [0.6, 1.4] } });

    map.addLayer({ id: 'buses', type: 'circle', source: 'buses',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 13, 5.5, 16, 10],
        'circle-color': classColor,
        'circle-opacity': ['case', ['get', 'waiting'], 0.55, 1],
        'circle-stroke-color': '#fff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 1.6],
      } });
    map.addLayer({ id: 'bus-labels', type: 'symbol', source: 'buses', minzoom: 13.2,
      layout: { 'text-field': ['get', 'id'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 13.2, 8.5, 16, 11.5],
        'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': '#fff' } });
  }

  function updateWidths() {
    const hw = net.routes.map(route => headwayAt(route, state.t, state.day));
    const key = hw.join(',');
    if (key === lastWidths) return;
    lastWidths = key;
    hw.forEach((h, r) => {
      for (let di = 0; di < 2; di++) map.setFeatureState({ source: 'routes', id: r * 2 + di }, { w: widthFor(h), on: h > 0 });
    });
  }

  // Frame the whole network in the part of the map the panel does not cover.
  function fitNetwork() {
    const bounds = new maplibregl.LngLatBounds();
    for (const route of net.routes) for (const dir of route.dirs) for (const s of dir.stops) bounds.extend([s.lon, s.lat]);
    const narrow = window.matchMedia('(max-width: 640px)').matches;
    map.fitBounds(bounds, { padding: narrow ? 24 : { top: 40, bottom: 40, right: 40, left: 340 }, animate: false });
  }

  // ---------- UI ----------

  const $ = id => document.getElementById(id);

  function fmtClock(t) {
    const m = Math.floor(t / 60) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  function fmtHeadway(h) {
    return h ? 'every ' + Math.round(h / 60) + ' min' : 'not running now';
  }

  function render() {
    if (!net) return;
    const buses = busesAt(state.t, state.day);
    map.getSource('buses').setData(busFeatures(buses));
    updateWidths();
    const routesRunning = net.routes.filter(route => headwayAt(route, state.t, state.day)).length;
    $('clock-time').textContent = fmtClock(state.t);
    $('clock-day').textContent = DAY_LABEL[state.day] + (state.t >= 86400 ? ', after midnight' : '');
    $('count').textContent = buses.length
      ? buses.length + ' buses out · ' + routesRunning + ' of ' + net.routes.length + ' routes running'
      : 'No buses out';
    $('time').value = Math.round(state.t / 60);
    renderRider();
  }

  // ---------- the rider ----------

  const FIGURE = '<svg viewBox="0 0 26 38" aria-hidden="true"><circle cx="13" cy="6.5" r="5"/>'
    + '<path d="M13 13c-4.2 0-7 2.6-7 6v7.5h3V36.5h3.3v-9h1.4v9H17V26.5h3V19c0-3.4-2.8-6-7-6z"/></svg>';

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function fmtMin(secs) {
    return Math.max(1, Math.round(secs / 60)) + ' min';
  }

  function addRider() {
    const el = document.createElement('div');
    el.className = 'rider';
    el.title = 'Drag me, then click the map';
    el.innerHTML = FIGURE;
    const central = net.ustops.find(s => /Guelph Central Station/.test(s.name));
    rider.pos = central ? central.pos : map.getCenter().toArray();
    rider.marker = new maplibregl.Marker({ element: el, anchor: 'bottom', draggable: true }).setLngLat(rider.pos).addTo(map);
    rider.marker.on('dragstart', () => clearTrip());
    rider.marker.on('dragend', () => {
      rider.pos = rider.marker.getLngLat().toArray();
      rider.draggedAt = performance.now();
    });

    const dest = document.createElement('div');
    dest.className = 'dest';
    rider.destMarker = new maplibregl.Marker({ element: dest });

    map.on('click', e => {
      const target = e.originalEvent && e.originalEvent.target;
      if (target && target.closest && target.closest('.rider')) return;
      if (performance.now() - rider.draggedAt < 300) return;   // the release of a drag
      sendRider(e.lngLat.toArray());
    });
  }

  // Forget the trip and leave the rider where they are now.
  function clearTrip() {
    if (rider.plan) rider.pos = riderAt(rider.plan, state.t).pos;
    rider.plan = null;
    rider.step = null;
    rider.destMarker.remove();
    rider.marker.setLngLat(rider.pos);
    map.getSource('trip').setData(tripFeatures(null));
    $('trip-steps').innerHTML = '';
    $('trip-hint').hidden = false;
  }

  function sendRider(to) {
    const from = rider.plan ? riderAt(rider.plan, state.t).pos : rider.pos;
    if (haversine(from, to) < 15) return;
    rider.pos = from;
    rider.plan = planTrip(from, to, state.t, state.day);
    rider.step = null;
    rider.destMarker.setLngLat(to).addTo(map);
    map.getSource('trip').setData(tripFeatures(rider.plan));
    renderSteps(rider.plan);
    if (!state.playing) setPlaying(true);
    renderRider();
  }

  function renderSteps(plan) {
    const rows = plan.legs.map(leg => {
      if (leg.type === 'walk') {
        return '<li><time>' + fmtClock(leg.t0) + '</time><span>Walk ' + fmtMin(leg.t1 - leg.t0) + ' to '
          + (leg.to ? esc(leg.to) : 'where you clicked') + '</span></li>';
      }
      const route = net.routes[leg.r], dir = route.dirs[leg.di];
      const wait = leg.t0 - leg.ready;
      return '<li><time>' + fmtClock(leg.t0) + '</time><span>' + (wait >= 60 ? 'Wait ' + fmtMin(wait) + ', then ride ' : 'Ride ')
        + '<b style="color:' + COLORS[route.class] + '">' + esc(route.id) + '</b> ' + esc(route.name) + ' for '
        + fmtMin(leg.t1 - leg.t0) + ' to ' + esc(dir.stops[leg.i1].name) + '</span></li>';
    });
    const onFoot = plan.legs.every(leg => leg.type === 'walk');
    rows.push('<li class="arrive"><time>' + fmtClock(plan.t1) + '</time><span>Arrive, ' + fmtMin(plan.t1 - plan.t0)
      + ' after setting out' + (onFoot ? '. No bus gets there sooner.' : '') + '</span></li>');
    $('trip-steps').innerHTML = rows.join('');
    $('trip-hint').hidden = true;
  }

  function renderRider() {
    if (!rider.plan) return;
    const at = riderAt(rider.plan, state.t);
    rider.marker.setLngLat(at.pos);
    if (at.step === rider.step) return;
    rider.step = at.step;
    [...$('trip-steps').children].forEach((li, i) => {
      li.classList.toggle('done', i < at.step);
      li.classList.toggle('now', i === at.step);
    });
  }

  function setPlaying(on) {
    state.playing = on;
    $('play').textContent = on ? 'Pause' : 'Play';
    $('play').setAttribute('aria-label', on ? 'Pause' : 'Play');
  }

  function bindControls() {
    $('days').addEventListener('click', e => {
      const btn = e.target.closest('button[data-day]');
      if (!btn) return;
      if (net && btn.dataset.day !== state.day) clearTrip();   // the trip was planned on the other day's buses
      state.day = btn.dataset.day;
      for (const b of $('days').children) b.classList.toggle('on', b === btn);
      render();
    });
    $('play').addEventListener('click', () => setPlaying(!state.playing));
    $('speed').addEventListener('change', e => { state.speed = +e.target.value; });
    $('time').addEventListener('input', e => { state.t = +e.target.value * 60; render(); });
  }

  function bindHover() {
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: '280px' });
    const lineLayers = ['routes-base', 'routes-university', 'routes-frequent'];
    map.on('mousemove', e => {
      const pad = 4;
      const hits = map.queryRenderedFeatures([[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]], { layers: lineLayers });
      const ids = [...new Set(hits.map(f => f.properties.r))].sort((a, b) => a - b);
      map.getCanvas().style.cursor = ids.length ? 'pointer' : '';
      if (!ids.length) { popup.remove(); return; }
      const rows = ids.map(r => {
        const route = net.routes[r], h = headwayAt(route, state.t, state.day);
        return '<div' + (h ? '' : ' class="off"') + '><b style="color:' + COLORS[route.class] + '">' + route.id + '</b> '
          + route.name + ' · ' + fmtHeadway(h) + '</div>';
      });
      popup.setLngLat(e.lngLat).setHTML('<div class="pop">' + rows.join('') + '</div>').addTo(map);
    });
  }

  function loop() {
    let prev = performance.now();
    function frame(now) {
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      if (state.playing) {
        state.t += dt * state.speed;
        if (state.t > T_MAX) {
          // A new day starts: a trip still under way ends where it was going.
          if (rider.plan) { state.t = Math.max(state.t, rider.plan.t1); clearTrip(); }
          state.t = T_MIN;
        }
        render();
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ---------- start ----------

  async function start() {
    bindControls();
    const [data] = await Promise.all([
      fetch('data/network.json').then(r => r.json()),
      new Promise(resolve => {
        map = new maplibregl.Map({
          container: 'map',
          style: 'https://tiles.openfreemap.org/styles/positron',
          center: [-80.2481, 43.5348],
          zoom: 11.6,
          attributionControl: { compact: false },
        });
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        map.once('style.load', resolve);  // do not wait for basemap tiles
        map.on('error', e => console.error('map error:', e.error && e.error.message));
      }),
    ]);
    net = prepare(data);
    fitNetwork();
    addLayers();
    bindHover();
    addRider();
    render();
    loop();
    // For checking the simulation from the console.
    window.sim = { net, map, state, rider, busesAt, tripTimes, headwayAt, render, planTrip, riderAt, sendRider, clearTrip };
  }

  start().catch(err => {
    console.error(err);
    $('count').textContent = 'Could not load the map: ' + err.message;
  });
})();
