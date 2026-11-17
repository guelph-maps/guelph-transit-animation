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

  const state = { day: 'weekday', t: 7 * 3600, playing: true, speed: 300 };
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
    return data;
  }

  // Position of a bus that has covered `d` metres (Remix distance) of a direction.
  // Remix distances are mapped onto our line through the stops, so a shape that is a
  // little longer or shorter than Remix's still puts the bus at each stop on time.
  function positionAt(dir, d) {
    const i = segment(dir.stopD, d);
    const d0 = dir.stopD[i], d1 = dir.stopD[i + 1];
    const f = d1 > d0 ? Math.min(1, Math.max(0, (d - d0) / (d1 - d0))) : 0;
    const m = dir.stopM[i] + f * (dir.stopM[i + 1] - dir.stopM[i]);
    const j = segment(dir.cum, m);
    const c0 = dir.cum[j], c1 = dir.cum[j + 1];
    const g = c1 > c0 ? Math.min(1, Math.max(0, (m - c0) / (c1 - c0))) : 0;
    const a = dir.line[j], b = dir.line[j + 1];
    return [a[0] + g * (b[0] - a[0]), a[1] + g * (b[1] - a[1])];
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
        if (state.t > T_MAX) state.t = T_MIN;
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
        map.on('load', resolve);
        map.on('error', e => console.error('map error:', e.error && e.error.message));
      }),
    ]);
    net = prepare(data);
    addLayers();
    bindHover();
    render();
    loop();
    // For checking the simulation from the console.
    window.sim = { net, state, busesAt, tripTimes, headwayAt, render };
  }

  start().catch(err => {
    console.error(err);
    $('count').textContent = 'Could not load the map: ' + err.message;
  });
})();
