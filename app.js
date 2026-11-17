/* Guelph Transit proposed network, animated.
 *
 * Everything is simulated from data/network.json: per route, two directions with a
 * line and stops, and per day type a list of service windows (start, end, headway,
 * average speed). See README.md for the assumptions.
 */
(function () {
  'use strict';

  const INK = '#1c2330';
  const DAY_LABEL = { weekday: 'Weekday', saturday: 'Saturday', sunday: 'Sunday' };
  const T_MIN = 300 * 60;   // 05:00
  const T_MAX = 1560 * 60;  // 02:00 next day

  // The rider walks along the streets of data/streets.json at WALK_SPEED. Until that
  // file has loaded (or if it does not), they walk in straight lines, with WALK_DETOUR
  // for the streets not being straight. All walking limits are metres walked.
  const WALK_SPEED = 4.8 / 3.6;   // m/s
  const WALK_DETOUR = 1.3;
  const BIKE_SPEED = 15 / 3.6;    // m/s: the shadow bicycle, stops and lights included
  const ACCESS_MARGIN = 500;      // m: the rider uses the nearest stop, or one up to this much farther
  const NEAR_MARGIN = 130;        // m: stops this close to the nearest one count as the nearest
  const FAR_STOP_GAIN = 60;       // s sooner a trip must arrive to start at a stop farther than those
  const WALK_ALL_MAX = 15 * 60;   // s: the longest trip the rider will walk when a bus could do it
  const WALK_ALL_RATIO = 1.5;     // ...unless the buses would take this many times as long
  const TRANSFER_WALK = 500;      // m on foot between stops when changing buses
  const TRANSFER_SLACK = 60;      // s needed at a stop before boarding the next bus
  const BOARD_PENALTY = 180;      // s a boarding must save to be worth making
  const MAX_BOARDINGS = 5;
  const TIE = 60;                 // s: arrivals closer than this are a tie
  const RACK_REACH = 150;         // m: a rack farther than this from any street is not used
  const RACK_COLOR = '#0e8a6a';

  // `parking`: the shadow bicycle is left at a rack at each end, and walked to and from.
  const state = { day: 'weekday', t: 7 * 3600, playing: true, speed: 120, parking: true };
  const rider = { nowR: null, nowB: null, pos: null, plan: null, marker: null, bikeMarker: null, destMarker: null, step: null, draggedAt: 0, rail: null, awarded: null, afoot: false };
  let net = null;
  let streets = null;
  let racks = null;               // bicycle parking: [{ pos, snap }], from data/parking.json
  let map = null;
  let lastWidths = '';

  // A phone: style.css puts everything in one sheet, under the map or (on its side)
  // beside it. The same query as there.
  const compact = window.matchMedia('(max-width: 820px), (max-height: 500px) and (max-width: 1000px)');
  let sheetH = -1;

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

  // Black or white, whichever reads better on a colour.
  function inkOn(hex) {
    const lum = c => {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const L = lum(hex);
    return 1.05 / (L + 0.05) >= (L + 0.05) / (lum(INK) + 0.05) ? '#fff' : INK;
  }

  // The legend's badges stand for a family of routes, 8X for the 80s: each takes the
  // average of its routes' colours, mixed in linear light so it is not darker than them.
  function paintLegend(routes) {
    const lin = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    const unlin = v => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
    for (const el of document.querySelectorAll('#legend .badge[data-tens]')) {
      const those = routes.filter(r => /^\d\d/.test(r.id) && r.id[0] === el.dataset.tens);
      if (!those.length) continue;
      const hex = '#' + [1, 3, 5].map(i => unlin(those.reduce((sum, r) => sum + lin(parseInt(r.color.slice(i, i + 2), 16) / 255), 0) / those.length)
        .toString(16).padStart(2, '0')).join('');
      el.style.background = hex;
      el.style.color = inkOn(hex);
      el.title = 'Routes ' + those.map(r => r.id).join(', ');
    }
  }

  function prepare(data) {
    for (const route of data.routes) {
      route.ink = inkOn(route.color);
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
      const m = haversine(data.ustops[a].pos, data.ustops[b].pos) * WALK_DETOUR;
      if (m > TRANSFER_WALK) continue;
      data.ustops[a].near.push({ u: b, secs: m / WALK_SPEED });
      data.ustops[b].near.push({ u: a, secs: m / WALK_SPEED });
    }
    return data;
  }

  // ---------- streets ----------
  //
  // data/streets.json is the walkable street network as nodes and the ways joining
  // them. Here it becomes a graph of straight segments, in metres on a flat local grid.

  const CELL = 100;   // m, of the grid used to find the street nearest a point

  function buildStreets(data) {
    const n = data.xy.length / 2, sc = data.scale, [lon0, lat0] = data.origin;
    let top = 0;
    for (let i = 1; i < data.xy.length; i += 2) top = Math.max(top, data.xy[i]);
    const ky = 111320, kx = ky * Math.cos((lat0 + top / sc / 2) * Math.PI / 180);
    const X = new Float64Array(n), Y = new Float64Array(n);
    for (let i = 0; i < n; i++) { X[i] = data.xy[2 * i] / sc * kx; Y[i] = data.xy[2 * i + 1] / sc * ky; }

    let m = 0;
    for (const w of data.ways) m += w.length - 1;
    const A = new Int32Array(m), B = new Int32Array(m), L = new Float64Array(m);
    const off = new Int32Array(n + 1);
    let k = 0;
    for (const w of data.ways) for (let i = 1; i < w.length; i++, k++) {
      A[k] = w[i - 1]; B[k] = w[i];
      L[k] = Math.hypot(X[A[k]] - X[B[k]], Y[A[k]] - Y[B[k]]);
      off[A[k] + 1]++; off[B[k] + 1]++;
    }
    for (let i = 0; i < n; i++) off[i + 1] += off[i];
    const fill = off.slice(0, n), adjNode = new Int32Array(2 * m), adjLen = new Float64Array(2 * m);
    const grid = new Map();
    for (k = 0; k < m; k++) {
      adjNode[fill[A[k]]] = B[k]; adjLen[fill[A[k]]++] = L[k];
      adjNode[fill[B[k]]] = A[k]; adjLen[fill[B[k]]++] = L[k];
      const x0 = Math.min(X[A[k]], X[B[k]]), x1 = Math.max(X[A[k]], X[B[k]]);
      const y0 = Math.min(Y[A[k]], Y[B[k]]), y1 = Math.max(Y[A[k]], Y[B[k]]);
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
        const key = gx * 4096 + gy;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(k);
      }
    }
    return { n, X, Y, A, B, L, off, adjNode, adjLen, grid, kx, ky, lon0, lat0 };
  }

  // The point of the street network nearest to `p`: on segment `k`, the share `t` of the
  // way along it, `off` metres from `p`.
  function snap(p) {
    const S = streets, px = (p[0] - S.lon0) * S.kx, py = (p[1] - S.lat0) * S.ky;
    const gx = Math.floor(px / CELL), gy = Math.floor(py / CELL);
    let best = Infinity, bk = -1, bt = 0;
    for (let r = 0; r < 300 && best > r * CELL; r++) {
      for (let ix = gx - r; ix <= gx + r; ix++) for (let iy = gy - r; iy <= gy + r; iy++) {
        if (ix < 0 || iy < 0 || Math.max(Math.abs(ix - gx), Math.abs(iy - gy)) !== r) continue;
        const list = S.grid.get(ix * 4096 + iy);
        if (!list) continue;
        for (const k of list) {
          const ax = S.X[S.A[k]], ay = S.Y[S.A[k]], dx = S.X[S.B[k]] - ax, dy = S.Y[S.B[k]] - ay;
          const t = S.L[k] > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (S.L[k] * S.L[k]))) : 0;
          const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
          if (d < best) { best = d; bk = k; bt = t; }
        }
      }
    }
    if (bk < 0) return null;
    const a = S.A[bk], b = S.B[bk];
    return { p, k: bk, t: bt, off: best,
      pt: [S.lon0 + (S.X[a] + bt * (S.X[b] - S.X[a])) / S.kx, S.lat0 + (S.Y[a] + bt * (S.Y[b] - S.Y[a])) / S.ky] };
  }

  // Shortest walks from a snapped point to every node within `limit` metres (Dijkstra).
  function walkTree(s, limit) {
    const S = streets, dist = new Float64Array(S.n).fill(Infinity), prev = new Int32Array(S.n).fill(-1);
    const hk = [], hv = [];   // a binary heap of (metres, node, came from)
    const push = (d, v, from) => {
      let i = hk.length;
      hk.push(d); hv.push(v, from);
      while (i > 0) {
        const up = (i - 1) >> 1;
        if (hk[up] <= d) break;
        hk[i] = hk[up]; hv[2 * i] = hv[2 * up]; hv[2 * i + 1] = hv[2 * up + 1];
        i = up;
      }
      hk[i] = d; hv[2 * i] = v; hv[2 * i + 1] = from;
    };
    const pop = () => {
      const top = [hk[0], hv[0], hv[1]], d = hk.pop(), from = hv.pop(), v = hv.pop(), n = hk.length;
      let i = 0;
      while (n) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && hk[c + 1] < hk[c]) c++;
        if (hk[c] >= d) break;
        hk[i] = hk[c]; hv[2 * i] = hv[2 * c]; hv[2 * i + 1] = hv[2 * c + 1];
        i = c;
      }
      if (n) { hk[i] = d; hv[2 * i] = v; hv[2 * i + 1] = from; }
      return top;
    };
    push(s.t * S.L[s.k], S.A[s.k], -1);
    push((1 - s.t) * S.L[s.k], S.B[s.k], -1);
    while (hk.length) {
      const [d, u, from] = pop();
      if (d > limit) break;
      if (dist[u] <= d) continue;
      dist[u] = d; prev[u] = from;
      for (let e = S.off[u]; e < S.off[u + 1]; e++) {
        const v = S.adjNode[e];
        if (dist[v] === Infinity) push(d + S.adjLen[e], v, u);
      }
    }
    return { s, dist, prev };
  }

  // Metres on foot from the start of a tree to a snapped point, door to door, and the
  // node the walk reaches the point's segment at (-1: both are on the same segment).
  function reach(tree, s) {
    const S = streets, len = S.L[s.k];
    const viaA = tree.dist[S.A[s.k]] + s.t * len, viaB = tree.dist[S.B[s.k]] + (1 - s.t) * len;
    const same = tree.s.k === s.k ? Math.abs(tree.s.t - s.t) * len : Infinity;
    const m = Math.min(viaA, viaB, same);
    return { m: tree.s.off + s.off + m, end: m === same ? -1 : m === viaA ? S.A[s.k] : S.B[s.k] };
  }

  function metresTo(tree, s) {
    return reach(tree, s).m;
  }

  // The same walk with its line, from the start of the tree to the point.
  function walkTo(tree, s) {
    const S = streets, r = reach(tree, s), mid = [];
    for (let u = r.end; u >= 0; u = tree.prev[u]) mid.push([S.lon0 + S.X[u] / S.kx, S.lat0 + S.Y[u] / S.ky]);
    return { m: r.m, line: [tree.s.p, tree.s.pt, ...mid.reverse(), s.pt, s.p] };
  }

  // A walk with no streets to follow.
  function crowWalk(a, b) {
    return { m: haversine(a, b) * WALK_DETOUR, line: [a, b] };
  }

  // Once the streets are in: put every stop on them, and redo which stops are close
  // enough to walk between.
  function useStreets(data) {
    streets = buildStreets(data);
    const stops = net.ustops;
    for (const s of stops) { s.snap = snap(s.pos); s.near = []; }
    for (let a = 0; a < stops.length; a++) {
      const tree = walkTree(stops[a].snap, TRANSFER_WALK);
      for (let b = 0; b < stops.length; b++) {
        if (b === a || haversine(stops[a].pos, stops[b].pos) > TRANSFER_WALK) continue;
        const m = metresTo(tree, stops[b].snap);
        if (m <= TRANSFER_WALK) stops[a].near.push({ u: b, secs: m / WALK_SPEED });
      }
    }
    snapRacks();
  }

  // ---------- bicycle parking ----------
  //
  // data/parking.json is where a bicycle can be parked: the racks of the Guelph Bike
  // Parking Map (https://guelph.bike/), a sibling project.

  function useParking(data) {
    racks = [];
    for (let i = 0; i < data.lonlat.length; i += 2) racks.push({ pos: [data.lonlat[i], data.lonlat[i + 1]], snap: null });
    snapRacks();
    document.getElementById('parking').disabled = false;
    if (state.parking) setParking(true);   // a trip made before the racks came in is planned again
  }

  // Put the racks on the streets, once both are in (they arrive in either order), and
  // drop the ones the street network does not reach.
  function snapRacks() {
    if (!racks) return;
    if (streets) {
      for (const r of racks) r.snap = snap(r.pos);
      racks = racks.filter(r => r.snap && r.snap.off <= RACK_REACH);
    }
    map.getSource('racks').setData(rackFeatures());
  }

  function rackFeatures() {
    return { type: 'FeatureCollection',
      features: (racks || []).map(r => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: r.pos } })) };
  }

  // Cumulative metres along a line, and the point a share `f` of the way along it.
  function measure(line) {
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversine(line[i - 1], line[i]));
    return cum;
  }

  function alongLine(line, cum, f) {
    const m = Math.min(1, Math.max(0, f)) * cum[cum.length - 1], j = segment(cum, m);
    const g = cum[j + 1] > cum[j] ? (m - cum[j]) / (cum[j + 1] - cum[j]) : 0;
    return [line[j][0] + g * (line[j + 1][0] - line[j][0]), line[j][1] + g * (line[j + 1][1] - line[j][1])];
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

  // Everything about walking one trip: how far each stop is on foot from the start and
  // from the end, and the walk straight there.
  function tripWalks(from, to) {
    const stops = net.ustops;
    const sf = streets && snap(from), st = streets && snap(to);
    if (!sf || !st) {
      return { from, to, direct: crowWalk(from, to),
        access: stops.map(s => haversine(from, s.pos) * WALK_DETOUR), egress: stops.map(s => haversine(s.pos, to) * WALK_DETOUR) };
    }
    const fromTree = walkTree(sf, Infinity), toTree = walkTree(st, Infinity);
    return { from, to, fromTree, toTree, direct: walkTo(fromTree, st),
      access: stops.map(s => metresTo(fromTree, s.snap)), egress: stops.map(s => metresTo(toTree, s.snap)) };
  }

  // The walk of one leg: from the start to stop `ub`, from stop `ua` to the end, or
  // between the two stops (-1 standing for the start or the end).
  function legWalk(walks, ua, ub) {
    const stops = net.ustops;
    if (ua < 0 && ub < 0) return walks.direct;
    if (ua < 0) return walks.fromTree ? walkTo(walks.fromTree, stops[ub].snap) : crowWalk(walks.from, stops[ub].pos);
    if (ub < 0) {
      if (!walks.toTree) return crowWalk(stops[ua].pos, walks.to);
      const w = walkTo(walks.toTree, stops[ua].snap);
      return { m: w.m, line: w.line.reverse() };
    }
    return walks.fromTree ? walkTo(walkTree(stops[ua].snap, TRANSFER_WALK), stops[ub].snap) : crowWalk(stops[ua].pos, stops[ub].pos);
  }

  // Seconds on foot for each stop the rider would use from a point, given the metres to
  // every stop: the nearest one and any up to `margin` farther (the stop across the
  // street, the other route round the corner). Infinity for the rest.
  function stopsNear(metres, margin) {
    const limit = Math.min(...metres) + margin;
    return Float64Array.from(metres, m => m <= limit ? m / WALK_SPEED : Infinity);
  }

  // The trip from `from` to `to` leaving at `t0`. The rider starts at the nearest stop
  // unless a farther one gets them there sooner: walking past it to the line they would
  // change to anyway, only to board the same bus, is not what people do.
  function planTrip(from, to, t0, day) {
    const walks = tripWalks(from, to);
    const near = planFrom(walks, t0, day, NEAR_MARGIN);
    const far = planFrom(walks, t0, day, ACCESS_MARGIN);
    // If the nearest stop has no bus worth taking, the wider plan decides whether to walk.
    const rides = near.legs.some(leg => leg.type === 'ride');
    const plan = !rides || far.t1 <= near.t1 - FAR_STOP_GAIN ? far : near;
    setBike(plan, walks);
    return plan;
  }

  // Give a plan its shadow bicycle (again, when the parking switch is thrown mid-trip).
  function setBike(plan, walks) {
    walks = walks || tripWalks(plan.from, plan.to);
    plan.bike = planBike(walks, plan.t0);
    // The shortest way by the streets, door to door: the one distance both are timed over.
    plan.direct = walks.direct.m;
    // Whoever is there first is the fastest commuter, by however little.
    // ...unless they are there within a minute of each other: then nobody is, and they
    // shake hands on it.
    plan.winner = Math.abs(plan.bike.t1 - plan.t1) < TIE ? 'tie' : plan.bike.t1 < plan.t1 ? 'bike' : 'rider';
  }

  // The shadow bicycle: the same start, end and leaving time, along the shortest way by
  // the streets, door to door. With parking on, the bicycle is only ridden between two
  // racks: the shadow walks to the rack nearest the start, rides to the one nearest the
  // end and walks from there. If that is one and the same rack, or no quicker than
  // walking the whole way, the shadow walks. Returns timed legs, as a rider's plan has.
  function planBike(walks, t0) {
    const { from, to, direct } = walks;
    const timed = parts => {
      let t = t0, m = 0, walkSecs = 0;
      const legs = parts.map(p => {
        const secs = p.m / (p.type === 'ride' ? BIKE_SPEED : WALK_SPEED);
        const leg = { type: p.type, m: p.m, line: p.line, cum: measure(p.line), t0: t, t1: t + secs };
        t = leg.t1; m += p.m;
        if (p.type === 'walk') walkSecs += secs;
        return leg;
      });
      const shown = legs.filter(leg => leg.t1 - leg.t0 >= 1);
      return { legs: shown.length ? shown : legs, m, t1: t, walkSecs, racks: null, afoot: false };
    };
    if (!state.parking || !racks || !racks.length) return timed([{ type: 'ride', m: direct.m, line: direct.line }]);

    const onStreets = !!walks.fromTree;
    const nearest = (tree, p) => {
      let best = -1, least = Infinity;
      racks.forEach((r, i) => {
        const m = tree ? metresTo(tree, r.snap) : haversine(p, r.pos) * WALK_DETOUR;
        if (m < least) { least = m; best = i; }
      });
      return best;
    };
    const a = nearest(walks.fromTree, from), b = nearest(walks.toTree, to);
    const afoot = () => Object.assign(timed([{ type: 'walk', m: direct.m, line: direct.line }]), { afoot: true });
    if (a < 0 || b < 0 || a === b) return afoot();
    const A = racks[a], B = racks[b];
    const out = onStreets ? walkTo(walks.fromTree, A.snap) : crowWalk(from, A.pos);
    const ride = onStreets ? walkTo(walkTree(A.snap, Infinity), B.snap) : crowWalk(A.pos, B.pos);
    const back = onStreets ? walkTo(walks.toTree, B.snap) : crowWalk(to, B.pos);
    const bike = timed([{ type: 'walk', m: out.m, line: out.line }, { type: 'ride', m: ride.m, line: ride.line },
      { type: 'walk', m: back.m, line: back.line.slice().reverse() }]);
    if (!(bike.t1 < t0 + direct.m / WALK_SPEED)) return afoot();
    bike.racks = [A.pos, B.pos];
    return bike;
  }

  // Where the shadow of a plan is at time `t`, and whether it is walking.
  function shadowAt(plan, t) {
    const legs = plan.bike.legs;
    for (const leg of legs) {
      if (t < leg.t1) return { pos: alongLine(leg.line, leg.cum, (t - leg.t0) / (leg.t1 - leg.t0)), afoot: leg.type === 'walk',
        v: t <= plan.t0 ? 0 : leg.type === 'walk' ? WALK_SPEED : BIKE_SPEED };
    }
    const last = legs[legs.length - 1];
    return { pos: last.line[last.line.length - 1], afoot: last.type === 'walk', v: 0 };
  }

  // A bus that reaches its terminus lays over and comes back as the other direction;
  // a rider who stays with it is on one bus, and has not changed.
  function sameBus(plan, j) {
    const leg = plan.legs[j], before = plan.legs[j - 1];
    if (!before || before.type !== 'ride' || before.r !== leg.r || before.di !== 0 || leg.di !== 1) return false;
    const run0 = net.routes[leg.r].dirs[0].length / before.v;
    return Math.abs(leg.start - before.start - run0 - Math.max(net.layover.seconds, net.layover.share * run0)) < 1;
  }

  // The rider's bus at time `t`: the one they are on, or the next one they will board,
  // from the moment the trip is planned. Before the rider's direction it is on its
  // outbound run or laying over; before that it is not `out` yet, and waits at its
  // terminus. `stop` is where the rider boards it, while they are not on it yet.
  function riderBusAt(plan, t) {
    const j = plan.legs.findIndex(leg => leg.type === 'ride' && t < leg.t1);
    if (j < 0) return null;
    const leg = plan.legs[j], route = net.routes[leg.r], e = t - leg.start;
    let pos, out = true;
    if (e >= 0) pos = positionAt(route.dirs[leg.di], e * leg.v);
    else if (leg.di === 0) { pos = positionAt(route.dirs[0], 0); out = false; }
    else {
      const len = route.dirs[0].length, run0 = len / leg.v;
      const d = (e + Math.max(net.layover.seconds, net.layover.share * run0) + run0) * leg.v;
      pos = positionAt(route.dirs[0], Math.min(len, Math.max(0, d)));
      out = d >= 0;
    }
    const s = route.dirs[leg.di].stops[leg.i0];
    return { leg, route, pos, out, stop: t < leg.t0 && !sameBus(plan, j) ? [s.lon, s.lat] : null };
  }

  function riderBusFeatures(bus) {
    const features = [];
    const add = (properties, coordinates) => features.push({ type: 'Feature', properties, geometry: { type: 'Point', coordinates } });
    if (bus) {
      if (bus.stop) add({ kind: 'stop' }, bus.stop);
      add({ kind: 'bus', id: bus.route.id, color: bus.out ? bus.route.color : '#fff', ink: bus.out ? bus.route.ink : INK }, bus.pos);
    }
    return { type: 'FeatureCollection', features };
  }

  // Earliest arrival from `from` to `to` leaving at `t0`, in rounds of one more boarding
  // each (RAPTOR). The rider walks only to the stops near the start (up to `margin`
  // farther than the nearest), between nearby stops to change buses, and from the stops
  // near the end. Returns the legs, with their times.
  function planFrom(walks, t0, day, margin) {
    const stops = net.ustops, n = stops.length, { from, to } = walks;
    const access = stopsNear(walks.access, margin), egress = stopsNear(walks.egress, ACCESS_MARGIN);
    const best = new Float64Array(n);
    let prev = new Float64Array(n);
    const how = [new Array(n)];             // how[k][u]: what brought the rider to u in round k
    for (let u = 0; u < n; u++) prev[u] = best[u] = t0 + access[u];

    const direct = t0 + walks.direct.m / WALK_SPEED;
    let win = { score: Infinity, k: 0, u: -1 };

    for (let k = 1; k <= MAX_BOARDINGS; k++) {
      const cur = new Float64Array(n).fill(Infinity);
      how.push(new Array(n));
      const reached = [];
      net.routes.forEach((route, r) => route.dirs.forEach((dir, di) => {
        let trip = null;
        for (let i = 0; i < dir.stops.length; i++) {
          const u = dir.stops[i].u;
          if (trip && dir.stopD[i] > dir.stopD[trip.i0]) {
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
      // Only a bus brings the rider to the stops near the end: the last walk is from
      // one of those to the door.
      for (const [u, arr, ride] of reached) {
        if (egress[u] === Infinity) continue;
        const score = arr + egress[u] + k * BOARD_PENALTY;
        if (score < win.score) win = { score, k, u, ride };
      }
      // Walk from where a bus dropped the rider to the stops nearby.
      for (const [u, arr, ride] of reached) for (const nb of stops[u].near) {
        const a = arr + nb.secs;
        if (a < cur[nb.u] && a < best[nb.u]) { cur[nb.u] = a; how[k][nb.u] = Object.assign({ walkFrom: u }, ride); }
      }
      for (let u = 0; u < n; u++) {
        if (cur[u] === Infinity) continue;
        best[u] = Math.min(best[u], cur[u]);
      }
      prev = cur;
    }

    // Walking all the way wins if no bus gets there, if it is short and no slower, or
    // if the buses would take over WALK_ALL_RATIO times as long.
    const noBus = win.k === 0, onFoot = direct - t0;
    if (onFoot <= win.score - t0 && (onFoot <= WALK_ALL_MAX || onFoot * WALK_ALL_RATIO < win.score - t0)) win = { score: direct, k: 0, u: -1 };

    // Walk the winner back to the start, then time the legs forwards.
    const legs = [];
    let { k, u } = win;
    let end = -1;                   // the stop the next walk leads to; -1: where they are going
    const walkLeg = ua => Object.assign({ type: 'walk', to: end < 0 ? null : stops[end].name }, legWalk(walks, ua, end));
    while (k > 0) {
      const h = k === win.k ? win.ride : how[k][u];
      if (h.walkFrom !== undefined) {
        legs.unshift(walkLeg(h.walkFrom));
      } else if (end !== u) {
        legs.unshift(walkLeg(u));
      }
      const dir = net.routes[h.r].dirs[h.di];
      legs.unshift({ type: 'ride', r: h.r, di: h.di, i0: h.i0, i1: h.i1, start: h.start, v: h.v,
        t0: h.start + dir.stopD[h.i0] / h.v, t1: h.start + dir.stopD[h.i1] / h.v });
      end = u = dir.stops[h.i0].u;
      k--;
    }
    legs.unshift(walkLeg(-1));

    let t = t0;
    for (const leg of legs) {
      if (leg.type === 'walk') { leg.t0 = t; leg.t1 = t + leg.m / WALK_SPEED; leg.cum = measure(leg.line); }
      else leg.ready = t;           // the rider waits at the stop from `ready` to `t0`
      t = leg.t1;
    }
    return { from, to, day, t0, t1: t, noBus, legs: legs.filter(leg => leg.type === 'ride' || leg.t1 - leg.t0 >= 1) };
  }

  // Where the rider of a plan is at time `t`, and which leg they are on.
  function riderAt(plan, t) {
    if (t <= plan.t0) return { pos: plan.from, step: -1 };
    for (let i = 0; i < plan.legs.length; i++) {
      const leg = plan.legs[i];
      if (t >= leg.t1) continue;
      if (leg.type === 'walk') return { pos: alongLine(leg.line, leg.cum, (t - leg.t0) / (leg.t1 - leg.t0)), step: i };
      const dir = net.routes[leg.r].dirs[leg.di];
      return { pos: positionAt(dir, Math.max(t, leg.t0) * leg.v - leg.start * leg.v), step: i };
    }
    return { pos: plan.to, step: plan.legs.length };
  }

  function tripFeatures(plan) {
    const features = [];
    const add = (kind, color, coordinates) => features.push({ type: 'Feature', properties: { kind, color }, geometry: { type: 'LineString', coordinates } });
    if (plan) {
      for (const leg of plan.bike.legs) add(leg.type === 'walk' ? 'bike-walk' : 'bike', INK, leg.line);
      for (const pos of plan.bike.racks || []) features.push({ type: 'Feature', properties: { kind: 'rack' }, geometry: { type: 'Point', coordinates: pos } });
      for (const leg of plan.legs) {
        if (leg.type === 'walk') add('walk', INK, leg.line);
        else add('ride', net.routes[leg.r].color, lineBetween(net.routes[leg.r].dirs[leg.di], leg.i0, leg.i1));
      }
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
          properties: { r, cls: route.class, color: route.color },
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
        properties: { id: net.routes[b.r].id, color: net.routes[b.r].color, ink: net.routes[b.r].ink, waiting: b.waiting },
        geometry: { type: 'Point', coordinates: b.pos },
      })),
    };
  }

  // Each line in the colour the city gives it on its own maps.
  const lineColor = ['get', 'color'];

  function addLayers() {
    map.addSource('routes', { type: 'geojson', data: routeFeatures() });
    map.addSource('stops', { type: 'geojson', data: stopFeatures() });
    map.addSource('buses', { type: 'geojson', data: busFeatures([]) });

    const W = ['coalesce', ['feature-state', 'w'], 2];
    const linePaint = {
      'line-color': lineColor,
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

    // Bicycle parking, shown while the shadow bicycle uses it.
    map.addSource('racks', { type: 'geojson', data: rackFeatures() });
    map.addLayer({ id: 'racks', type: 'circle', source: 'racks', layout: { visibility: state.parking ? 'visible' : 'none' },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 14, 3.2, 17, 6], 'circle-color': RACK_COLOR,
        'circle-opacity': 0.85, 'circle-stroke-color': '#fff', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 14, 1] } });

    map.addSource('trip', { type: 'geojson', data: tripFeatures(null) });
    map.addLayer({ id: 'trip-bike', type: 'line', source: 'trip', filter: ['==', ['get', 'kind'], 'bike'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#7a8494', 'line-width': 2.5, 'line-opacity': 0.75 } });
    map.addLayer({ id: 'trip-bike-walk', type: 'line', source: 'trip', filter: ['==', ['get', 'kind'], 'bike-walk'],
      layout: { 'line-join': 'round' }, paint: { 'line-color': '#7a8494', 'line-width': 2.5, 'line-dasharray': [0.6, 1.4] } });
    map.addLayer({ id: 'trip-ride-case', type: 'line', source: 'trip', filter: ['==', ['get', 'kind'], 'ride'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': INK, 'line-width': 9 } });
    map.addLayer({ id: 'trip-ride', type: 'line', source: 'trip', filter: ['==', ['get', 'kind'], 'ride'],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': lineColor, 'line-width': 5 } });
    map.addLayer({ id: 'trip-walk', type: 'line', source: 'trip', filter: ['==', ['get', 'kind'], 'walk'],
      layout: { 'line-join': 'round' }, paint: { 'line-color': INK, 'line-width': 3, 'line-dasharray': [0.6, 1.4] } });
    // The two racks the shadow leaves its bicycle at.
    map.addLayer({ id: 'trip-racks', type: 'circle', source: 'trip', filter: ['==', ['get', 'kind'], 'rack'],
      paint: { 'circle-radius': 5.5, 'circle-color': '#fff', 'circle-stroke-color': RACK_COLOR, 'circle-stroke-width': 3.5 } });

    map.addLayer({ id: 'buses', type: 'circle', source: 'buses',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 13, 5.5, 16, 10],
        'circle-color': lineColor,
        'circle-opacity': ['case', ['get', 'waiting'], 0.55, 1],
        'circle-stroke-color': '#fff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 1.6],
      } });
    map.addLayer({ id: 'bus-labels', type: 'symbol', source: 'buses', minzoom: 13.2,
      layout: { 'text-field': ['get', 'id'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 13.2, 8.5, 16, 11.5],
        'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': ['get', 'ink'] } });

    // The rider's bus, from the click until they get off: larger, cased in ink as their
    // ride's line is, and numbered at every zoom. The stop they board at is ringed.
    map.addSource('rider-bus', { type: 'geojson', data: riderBusFeatures(null) });
    const isBus = ['==', ['get', 'kind'], 'bus'];
    const R = ['interpolate', ['linear'], ['zoom'], 10, 7.5, 13, 9.5, 16, 14];
    map.addLayer({ id: 'rider-stop', type: 'circle', source: 'rider-bus', filter: ['==', ['get', 'kind'], 'stop'],
      paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': INK, 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'rider-bus-halo', type: 'circle', source: 'rider-bus', filter: isBus,
      paint: { 'circle-radius': R, 'circle-color': '#fff', 'circle-stroke-color': '#fff', 'circle-stroke-width': 5 } });
    map.addLayer({ id: 'rider-bus', type: 'circle', source: 'rider-bus', filter: isBus,
      paint: { 'circle-radius': R, 'circle-color': lineColor, 'circle-stroke-color': INK, 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'rider-bus-label', type: 'symbol', source: 'rider-bus', filter: isBus,
      layout: { 'text-field': ['get', 'id'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 10, 8.5, 13, 10.5, 16, 13],
        'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': ['get', 'ink'] } });
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
    layoutSheet();
    map.fitBounds(bounds, { padding: compact.matches ? 24 : { top: 40, bottom: 40, right: 40, left: 340 }, animate: false });
  }

  // On a phone the map ends where the sheet begins, as tall as the sheet is closed: an
  // opened sheet lies over the map and does not move it.
  function layoutSheet() {
    const root = document.documentElement;
    let h = 0;
    if (compact.matches) {
      if ($('panel').classList.contains('open') || $('trip-panel').classList.contains('open')) return;
      const ui = $('ui');
      h = ui.offsetWidth < root.clientWidth ? 0 : ui.offsetHeight;   // beside the map, nothing is under it
    }
    if (h === sheetH) return;
    sheetH = h;
    if (compact.matches) root.style.setProperty('--sheet-h', h + 'px'); else root.style.removeProperty('--sheet-h');
    if (map) map.resize();
  }

  // Open or close one of the sheet's two folds: 'panel' (the legend, the racks, the
  // notes) or 'trip-panel' (the steps). Only one is open at a time.
  function setOpen(id, on) {
    for (const [fold, button] of [['panel', 'more'], ['trip-panel', 'trip-expand']]) {
      const open = fold === id && on;
      $(fold).classList.toggle('open', open);
      $(button).setAttribute('aria-expanded', open);
    }
    if (id === 'trip-panel' && on) { rider.step = null; layoutRail(); }   // the rows were not laid out while hidden
    layoutSheet();
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

  const BIKE = '<svg viewBox="0 0 34 22" aria-hidden="true"><circle cx="7" cy="15" r="5.5"/><circle cx="27" cy="15" r="5.5"/>'
    + '<path d="M7 15l5-9h10l5 9M12 6l5 9 5-9M10.5 3h4M22 6l-1-3.5h3"/></svg>';
  const AFOOT = FIGURE.replace('<svg', '<svg class="foot"');   // the shadow, walking

  // The fastest commuter's medal: two ribbon tails, a gold disc, and a pair of chevrons
  // for speed. Styled inline, so the rules for the other glyphs leave it alone.
  const MEDAL = '<svg viewBox="0 0 20 27" aria-hidden="true">'
    + '<path d="M3.2 0h5.4l3.2 8.6-4.6 2.4z" style="fill:#1c2330;stroke:none"/>'
    + '<path d="M16.8 0h-5.4L8.2 8.6l4.6 2.4z" style="fill:#3a6ea5;stroke:none"/>'
    + '<circle cx="10" cy="17.5" r="8.4" style="fill:#f4b929;stroke:#9a6a00;stroke-width:1.2"/>'
    + '<circle cx="10" cy="17.5" r="5.9" style="fill:none;stroke:#fff;stroke-width:0.9;stroke-opacity:0.75"/>'
    + '<path d="M6.6 14.6l2.9 2.9-2.9 2.9M10.6 14.6l2.9 2.9-2.9 2.9" style="fill:none;stroke:#1c2330;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round"/></svg>';
  const AWARD = '<span class="award" title="Fastest commuter">' + MEDAL + '<small>Fastest commuter</small></span>';
  // The same pin holds the handshake of a tie, shown in the medal's place.
  const PIN = '<span class="medal">' + MEDAL + '<i>🤝</i></span>';
  const FRIENDS = '<span class="award friends" title="Both there within a minute"><i>🤝</i><small>Friendship won</small></span>';

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function fmtMin(secs) {
    return Math.max(1, Math.round(secs / 60)) + ' min';
  }

  // Door-to-door speed: the shortest way by the streets over the whole time taken, the
  // waits and detours included. The same metres for the rider and the bicycle, so the
  // one with the higher speed is the one that is there first.
  function fmtSpeed(m, secs) {
    const kmh = m / Math.max(1, secs) * 3.6;
    return (kmh < 0.05 ? '0' : kmh < 9.95 ? kmh.toFixed(1) : Math.round(kmh)) + ' km/h';
  }

  function addRider() {
    const el = document.createElement('div');
    el.className = 'rider';
    el.title = 'Drag me, then click the map';
    el.innerHTML = FIGURE + PIN;
    const central = net.ustops.find(s => /Guelph Central Station/.test(s.name));
    rider.pos = central ? central.pos : map.getCenter().toArray();
    rider.marker = new maplibregl.Marker({ element: el, anchor: 'bottom', draggable: true }).setLngLat(rider.pos).addTo(map);
    rider.marker.on('dragstart', () => clearTrip());
    rider.marker.on('dragend', () => {
      rider.pos = rider.marker.getLngLat().toArray();
      rider.draggedAt = performance.now();
    });

    const bike = document.createElement('div');
    bike.className = 'bike';
    bike.title = 'The same trip by bicycle';
    bike.innerHTML = BIKE + AFOOT + PIN;
    rider.bikeMarker = new maplibregl.Marker({ element: bike, anchor: 'bottom' });
    // The same two on the lanes of the phone's race.
    $('lane-rider').querySelector('.runner').innerHTML = FIGURE + PIN;
    $('lane-bike').querySelector('.runner').innerHTML = BIKE + AFOOT + PIN;

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
    rider.rail = null;
    setAward(null);
    rider.destMarker.remove();
    rider.bikeMarker.remove();
    rider.marker.setLngLat(rider.pos);
    map.getSource('trip').setData(tripFeatures(null));
    map.getSource('rider-bus').setData(riderBusFeatures(null));
    $('trip-steps').innerHTML = '';
    $('trip-panel').hidden = true;
    document.body.classList.remove('racing');
    setOpen('trip-panel', false);
  }

  function sendRider(to) {
    const from = rider.plan ? riderAt(rider.plan, state.t).pos : rider.pos;
    if (haversine(from, to) < 15) return;
    rider.pos = from;
    setOpen('panel', false);
    rider.plan = planTrip(from, to, state.t, state.day);
    rider.step = null;
    rider.destMarker.setLngLat(to).addTo(map);
    rider.bikeMarker.setLngLat(from).addTo(map);
    map.getSource('trip').setData(tripFeatures(rider.plan));
    renderSteps(rider.plan);
    showTrip(rider.plan);
    if (!state.playing) setPlaying(true);
    renderRider();
  }

  // Move the map so the whole trip is clear of the two panels, if it is not already.
  function showTrip(plan) {
    const pts = tripFeatures(plan).features.flatMap(f => f.geometry.type === 'LineString' ? f.geometry.coordinates : []);
    const box = map.getContainer().getBoundingClientRect(), tp = $('trip-panel').getBoundingClientRect();
    const pad = compact.matches ? { top: 44, bottom: 28, left: 30, right: 30 }
      : { top: 56, bottom: 40, left: 340, right: box.width >= 1000 ? box.right - tp.left + 30 : 60 };
    const clear = pts.every(p => {
      const q = map.project(p);
      return q.x >= pad.left - 10 && q.x <= box.width - pad.right + 10 && q.y >= pad.top - 10 && q.y <= box.height - pad.bottom + 10;
    });
    if (clear && !compact.matches) return;   // a phone's map is small: there the trip always fills it
    const bounds = new maplibregl.LngLatBounds();
    for (const p of pts) bounds.extend(p);
    map.fitBounds(bounds, { padding: pad, maxZoom: Math.max(map.getZoom(), compact.matches ? 15 : 14), duration: 600 });
  }

  function badge(route) {
    return '<b class="badge" style="background:' + route.color + ';color:' + route.ink + '">' + esc(route.id) + '</b>';
  }

  function fmtDist(m) {
    return m < 950 ? Math.max(10, Math.round(m / 10) * 10) + ' m' : (m / 1000).toFixed(1) + ' km';
  }

  // The floating trip panel: when, which buses, and each step with its times. One <li>
  // per walk, wait and ride, then the arrival.
  function renderSteps(plan) {
    const rides = plan.legs.filter(leg => leg.type === 'ride');
    const buses = plan.legs.filter((leg, j) => leg.type === 'ride' && !sameBus(plan, j));
    const total = plan.t1 - plan.t0;
    // One row per thing the rider does: a walk, a wait of half a minute or more, a ride.
    // `marks` keeps each row's stamped time and when it is over, for the row now under
    // way and for the bicycle's line beside them.
    const rows = [], marks = [];
    const row = (cls, t0, t1, what, notes) => {
      marks.push({ t: t0, t1 });
      rows.push('<li class="' + cls + '"><time>' + fmtClock(t0) + '</time><span>' + what
        + notes.map(s => '<small>' + s + '</small>').join('') + '</span><em>' + fmtMin(t1 - t0) + '</em></li>');
    };
    plan.legs.forEach((leg, j) => {
      if (leg.type === 'walk') {
        row('walk', leg.t0, leg.t1, 'Walk to ' + (leg.to ? esc(leg.to) : 'where you clicked'), [fmtDist(leg.m)]);
        return;
      }
      const route = net.routes[leg.r], dir = route.dirs[leg.di];
      const n = leg.i1 - leg.i0, at = esc(dir.stops[leg.i0].name), stay = sameBus(plan, j);
      const waits = leg.t0 - leg.ready >= 30;
      if (waits) row('wait', leg.ready, leg.t0, stay ? 'Stay on the ' + esc(route.id) + ' at its terminus' : 'Wait for the ' + esc(route.id), [at]);
      row('ride', leg.t0, leg.t1, badge(route) + ' ' + esc(route.name), (waits ? [] : [(stay ? 'Same bus, from ' : 'Board at ') + at])
        .concat('Off at ' + esc(dir.stops[leg.i1].name) + ', ' + fmtClock(leg.t1) + ' · ' + n + (n === 1 ? ' stop' : ' stops')));
    });
    marks.push({ t: plan.t1, t1: Infinity });
    plan.marks = marks;
    rows.push('<li class="arrive"><time>' + fmtClock(plan.t1) + '</time><span>Arrive' + (plan.winner === 'rider' ? ' ' + AWARD : plan.winner === 'tie' ? ' ' + FRIENDS : '') + '</span><em>' + fmtMin(plan.t1 - plan.t0) + '</em></li>');

    // The head: the two totals, the thing compared, with each one's door-to-door speed.
    const big = secs => '<b>' + fmtMin(secs).replace(' min', '<span>min</span>') + '</b>';
    const over = 'Door to door: ' + fmtDist(plan.direct) + ' by the shortest way along the streets, over the whole trip';
    const speed = secs => '<u title="' + over + '">' + fmtSpeed(plan.direct, secs) + '</u>';
    // Under it, how fast each is going at the moment: filled in by renderRider.
    const now = who => '<small class="cur" title="Speed at the moment">now <u class="cur-' + who + '"></u></small>';
    rider.nowR = rider.nowB = null;
    $('trip-when').innerHTML = big(total) + '<small><span>' + fmtClock(plan.t0) + ' → ' + fmtClock(plan.t1) + '</span>' + speed(total) + '</small>' + now('rider');
    $('trip-buses').innerHTML = rides.length
      ? buses.map(leg => badge(net.routes[leg.r])).join('<i>→</i>')
        + '<span>' + (buses.length === 1 ? 'one bus' : buses.length + ' buses, ' + (buses.length - 1) + (buses.length === 2 ? ' change' : ' changes')) + '</span>'
      : '<span>' + (plan.noBus && total > WALK_ALL_MAX ? 'No bus gets there from here at this hour, so they walk.' : 'On foot: no bus is quicker.') + '</span>';
    $('trip-steps').innerHTML = rows.join('');
    // The bicycle's own timeline, beside the steps and on their clock: one line from
    // setting out to arriving, with a dot that rides down it.
    // With parking on it is cut where the shadow gets on and off, the walks dotted.
    const bike = plan.bike;
    const how = bike.afoot ? 'On foot all the way: riding between the two nearest racks would be no quicker'
      : bike.racks ? 'The same trip by bicycle, parked at a rack at each end' : 'The same trip by bicycle';
    const foot = bike.afoot ? 'on foot all the way' : bike.racks ? fmtMin(bike.walkSecs) + ' of it on foot' : '';
    $('trip-bike').innerHTML = big(bike.t1 - plan.t0) + '<small>' + (bike.afoot ? AFOOT : BIKE) + speed(bike.t1 - plan.t0) + '</small>' + now('bike');
    $('trip-bike').title = how;
    $('trip-rail').innerHTML = bike.legs.map(leg => '<i class="line ' + leg.type + '"></i>').join('')
      + '<i class="at"></i><div class="end"><b>' + fmtClock(bike.t1) + '</b><strong>' + fmtMin(bike.t1 - plan.t0) + '</strong><small>'
      + fmtDist(bike.m) + '</small>' + (foot ? '<small>' + foot + '</small>' : '') + (plan.winner === 'bike' ? AWARD : plan.winner === 'tie' ? FRIENDS : '') + '</div>';
    $('trip-rail').setAttribute('aria-label', how + ': ' + fmtMin(bike.t1 - plan.t0) + ', there at ' + fmtClock(bike.t1)
      + ', ' + fmtSpeed(plan.direct, bike.t1 - plan.t0) + ' door to door'
      + (foot ? ', ' + foot : '') + (plan.winner === 'bike' ? ', the fastest commuter' : plan.winner === 'tie' ? ', within a minute of the rider: friendship won' : ''));
    // On a phone, the race: two lanes on one clock, from setting out to the later arrival.
    const span = Math.max(plan.t1, bike.t1) - plan.t0;
    const pct = secs => (secs / span * 100).toFixed(2) + '%';
    const seg = (cls, a, b, color) => '<i class="' + cls + '" style="left:' + pct(a - plan.t0) + ';width:' + pct(b - a)
      + (color ? ';background:' + color : '') + '"></i>';
    const lane = (id, who, legs, t1, label) => {
      const el = $(id);
      el.querySelector('.segs').innerHTML = seg('base', plan.t0, t1)
        + legs.map(leg => seg(leg.type, leg.t0, leg.t1, leg.r === undefined ? '' : net.routes[leg.r].color)).join('')
        + '<i class="fin" style="left:' + pct(t1 - plan.t0) + '"></i>';
      el.querySelector('.total').innerHTML = big(t1 - plan.t0) + '<small title="' + over + '">avg ' + fmtSpeed(plan.direct, t1 - plan.t0) + '</small>' + now(who);
      el.setAttribute('aria-label', label + ': ' + fmtMin(t1 - plan.t0) + ', there at ' + fmtClock(t1));
    };
    lane('lane-rider', 'rider', plan.legs, plan.t1, rides.length ? 'By bus' : 'On foot');
    lane('lane-bike', 'bike', bike.legs, bike.t1, how);
    plan.span = span;
    $('trip-panel').hidden = false;
    document.body.classList.add('racing');
    layoutSheet();
    layoutRail();
  }

  // Put the bicycle's line on the clock of the steps beside it. The steps are rows, not
  // a scale, so the time stamped on each row is a mark and times between two rows fall
  // between them: a bicycle that is there at 07:13 ends between the rows stamped 07:10
  // and 07:15. One that is there after the rider runs on below the last row.
  function layoutRail() {
    const plan = rider.plan, rail = $('trip-rail');
    if (!plan || !rail.firstChild) return;
    const marks = [...$('trip-steps').children].map((li, i) => ({ t: plan.marks[i].t, y: li.offsetTop + 14 }));
    const first = marks[0], last = marks[marks.length - 1];
    const pace = last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;   // px a second, past the last row
    const yAt = t => {
      if (t <= first.t) return first.y;
      if (t >= last.t) return last.y + Math.min(90, (t - last.t) * pace);
      const i = marks.findIndex(m => m.t > t), a = marks[i - 1], b = marks[i];
      return a.y + (t - a.t) / (b.t - a.t) * (b.y - a.y);
    };
    const at = rail.querySelector('.at'), end = rail.querySelector('.end'), yEnd = yAt(plan.bike.t1);
    rail.querySelectorAll('.line').forEach((line, i) => {
      const leg = plan.bike.legs[i], y0 = yAt(leg.t0);
      line.style.top = y0 + 'px';
      line.style.height = Math.max(0, yAt(leg.t1) - y0) + 'px';
    });
    end.style.top = yEnd + 'px';
    rail.style.minHeight = Math.ceil(yEnd + end.offsetHeight) + 'px';
    rider.rail = { at, yAt };
    at.style.transform = 'translateY(' + yAt(Math.min(state.t, plan.bike.t1)) + 'px)';
  }

  // Hang the medal on whoever has it (null: nobody yet), in the panel and on the map.
  function setAward(who) {
    rider.awarded = who;
    $('trip-panel').classList.toggle('won', !!who);
    rider.marker.getElement().classList.toggle('medalled', who === 'rider');
    rider.bikeMarker.getElement().classList.toggle('medalled', who === 'bike');
    // A tie: one handshake on the map, where the two stand together, and one a lane.
    rider.marker.getElement().classList.toggle('friends', who === 'tie');
    for (const [id, whose] of [['lane-rider', 'rider'], ['lane-bike', 'bike']]) {
      $(id).classList.toggle('won', who === whose);
      $(id).querySelector('.runner').classList.toggle('medalled', who === whose);
      $(id).querySelector('.runner').classList.toggle('friends', who === 'tie');
    }
  }

  function renderRider() {
    if (!rider.plan) return;
    const at = riderAt(rider.plan, state.t), bike = rider.plan.bike, shadow = shadowAt(rider.plan, state.t);
    rider.marker.setLngLat(at.pos);
    rider.bikeMarker.setLngLat(shadow.pos);
    if (shadow.afoot !== rider.afoot) {
      rider.afoot = shadow.afoot;
      rider.bikeMarker.getElement().classList.toggle('afoot', shadow.afoot);
      $('lane-bike').querySelector('.runner').classList.toggle('afoot', shadow.afoot);
    }
    // The two runners of the phone's race, each as far along as its clock.
    const plan = rider.plan, along = t1 => (Math.min(Math.max(state.t, plan.t0), t1) - plan.t0) / plan.span * 100 + '%';
    $('lane-rider').querySelector('.runner').style.left = along(plan.t1);
    $('lane-bike').querySelector('.runner').style.left = along(bike.t1);
    if (rider.rail) rider.rail.at.style.transform = 'translateY(' + rider.rail.yAt(Math.min(state.t, bike.t1)) + 'px)';
    // The medal is won on arriving, and lost again if the clock is dragged back.
    // A tie is shaken on once both are there.
    const settled = plan.winner === 'tie' ? Math.max(plan.t1, bike.t1) : Math.min(plan.t1, bike.t1);
    const awarded = plan.winner && state.t >= settled ? plan.winner : null;
    if (awarded !== rider.awarded) setAward(awarded);
    const legs = rider.plan.legs.length, leg = rider.plan.legs[at.step];
    // Their bus on the map, and how long until it is at their stop.
    const bus = riderBusAt(plan, state.t);
    map.getSource('rider-bus').setData(riderBusFeatures(bus));
    const due = bus && state.t < bus.leg.t0 ? ' the ' + bus.route.id + ' · ' + Math.max(1, Math.ceil((bus.leg.t0 - state.t) / 60)) + ' min' : '';
    // A rider who stays on through the terminus is on the bus, not waiting for it.
    const status = at.step < 0 ? 'Setting out' : at.step >= legs ? 'Arrived'
      : leg.type === 'walk' ? (due ? 'Walking to' + due : 'Walking')
      : state.t < leg.t0 && !sameBus(plan, at.step) ? 'Waiting for' + due : 'On the ' + net.routes[leg.r].id;
    if ($('trip-status').textContent !== status) $('trip-status').textContent = status;
    // How fast each is going now: a bus at its average for the hour, a wait at nothing.
    const vR = at.step < 0 || at.step >= legs ? 0 : leg.type === 'walk' ? WALK_SPEED : state.t < leg.t0 ? 0 : leg.v;
    const nowR = fmtSpeed(vR, 1), nowB = fmtSpeed(shadow.v, 1);
    if (nowR !== rider.nowR) { rider.nowR = nowR; document.querySelectorAll('.cur-rider').forEach(el => { el.textContent = nowR; }); }
    if (nowB !== rider.nowB) { rider.nowB = nowB; document.querySelectorAll('.cur-bike').forEach(el => { el.textContent = nowB; }); }
    // The row under way: the first one not yet over (-1 before setting out).
    const step = at.step < 0 ? -1 : rider.plan.marks.findIndex(m => state.t < m.t1);
    if (step === rider.step) return;
    rider.step = step;
    [...$('trip-steps').children].forEach((li, i) => {
      li.classList.toggle('done', i < step);
      li.classList.toggle('now', i === step);
      // The steps scroll on a phone, where they are only there once opened.
      if (i === step && (!compact.matches || $('trip-panel').classList.contains('open'))) li.scrollIntoView({ block: 'nearest' });
    });
    layoutRail();   // the row now in bold may have wrapped, and moved the rows below it
  }

  // Throw the parking switch. A trip under way keeps its start, end and leaving time,
  // and only its shadow is planned again.
  function setParking(on) {
    state.parking = on;
    $('parking').checked = on;
    map.setLayoutProperty('racks', 'visibility', on ? 'visible' : 'none');
    const plan = rider.plan;
    if (!plan) return;
    setBike(plan);
    map.getSource('trip').setData(tripFeatures(plan));
    renderSteps(plan);
    rider.step = null;    // the rows are new, and none is marked yet
    setAward(null);       // nor is the medal: it is given again below if it is won
    renderRider();
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
    $('trip-close').addEventListener('click', () => clearTrip());
    $('more').addEventListener('click', () => setOpen('panel', !$('panel').classList.contains('open')));
    $('trip-expand').addEventListener('click', () => setOpen('trip-panel', !$('trip-panel').classList.contains('open')));
    // The sheet's height sets where the map ends; turning the phone closes what was open.
    for (const id of ['panel', 'trip-panel']) new ResizeObserver(layoutSheet).observe($(id));
    compact.addEventListener('change', () => { sheetH = -1; setOpen('panel', false); });
    window.addEventListener('resize', layoutSheet);
    $('parking').addEventListener('change', e => setParking(e.target.checked));
    $('speed').addEventListener('change', e => { state.speed = +e.target.value; });
    $('time').addEventListener('input', e => { state.t = +e.target.value * 60; render(); });
    // The rows move whenever the steps are laid out again: a new width, a font arriving.
    new ResizeObserver(layoutRail).observe($('trip-steps'));
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
        return '<div' + (h ? '' : ' class="off"') + '>' + badge(route) + ' '
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
    paintLegend(net.routes);
    fitNetwork();
    addLayers();
    if (window.matchMedia('(hover: hover)').matches) bindHover();   // a finger does not hover: its tap sends the rider
    addRider();
    render();
    loop();
    // The streets arrive after the first frame; until then walks are straight lines.
    fetch('data/streets.json').then(r => r.json()).then(useStreets)
      .catch(err => console.error('no street network, walking in straight lines:', err));
    fetch('data/parking.json').then(r => r.json()).then(useParking)
      .catch(err => console.error('no bicycle parking, the bicycle rides door to door:', err));
    // For checking the simulation from the console.
    window.sim = { net, map, state, rider, busesAt, tripTimes, headwayAt, render, planTrip, riderAt, sendRider, clearTrip, positionAt, snap, walkTree, metresTo, shadowAt, riderBusAt, setParking, get streets() { return streets; }, get racks() { return racks; } };
  }

  start().catch(err => {
    console.error(err);
    $('count').textContent = 'Could not load the map: ' + err.message;
  });
})();
