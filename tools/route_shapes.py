"""Build road-following route shapes for the Remix network by routing on OSM.

For each direction of each line's primary pattern the ordered stops are sent
to OSRM as one multi-waypoint request; each leg is validated against the
distance Remix recorded between the same two stops, and legs that fail are
re-routed: the other kerb setting, then Valhalla's bus profile, then the bus
profile ignoring access/one-way tags (accepted only when its length matches
Remix; label "valhalla-bus-relaxed"). If nothing is within tolerance the
closest candidate within 50% is kept; failing that the leg is drawn straight,
unless a straight segment would be even further from the Remix length than
the best route, in which case the route is kept.

Stop order. Remix's distanceFromStart contradicts the stop coordinates for
some stops (two populations on different scales), so sorting by it does not
always give travel order. Per direction the script therefore finds the
longest "trusted" chain of sorted stops whose consecutive Remix deltas are
at least 0.9 x the straight-line distance, routes through those only, and
re-inserts every other ("displaced") stop by projecting it onto the routed
line. A displaced stop more than 60 m from the line is tried as an extra
waypoint. Travel order is the order along the line.

shapes.json per direction: line, order (indices into the distance-sorted
directionStops, in travel order), stopM (metres along line), stopD
(Remix-scale metres from the first trusted stop; interpolated for displaced
stops), displaced (sorted-list indices), legMethod (one per leg between
consecutive trusted stops; "+via" marks a leg rerouted through a displaced
stop).

Cache names: source/osrm/<route>_<dir>[_curb].json for whole directions,
<route>_<dir>_leg<i>[_curb].json for single legs; source/valhalla/
<route>_<dir>_leg<i>[_relaxed<k>].json. Where stops are displaced the whole
direction is <route>_<dir>_t<crc of trusted indices>, a leg spanning skipped
stops is _leg<a>to<b>, and waypoint/extension retries are _via.../_ext....

Run:  python -I tools/route_shapes.py
Outputs: source/derived/shapes.json, source/derived/shapes_report.txt
Caches:  source/osrm/*.json, source/valhalla/*.json (reruns make no requests)
"""
import json
import math
import sys
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REMIX = ROOT / "source" / "remix" / "maps_85f5b7bf.json"
OSRM_DIR = ROOT / "source" / "osrm"
VALHALLA_DIR = ROOT / "source" / "valhalla"
OUT_DIR = ROOT / "source" / "derived"

OSRM_URL = "https://router.project-osrm.org/route/v1/driving/"
VALHALLA_URL = "https://valhalla1.openstreetmap.de/route"
USER_AGENT = "transit-shape-builder/0.1"
MIN_INTERVAL = 1.1  # seconds between network requests

TOL_ABS = 60.0     # metres
TOL_REL = 0.25
SNAP_MAX = 40.0    # metres
KEEP_REL = 0.50    # last-resort acceptance before falling back to straight
AB_SAMPLE = ["92", "12A", "3"]
FEASIBLE = 0.9        # a stop pair is feasible if Remix delta >= this x straight line
PASS_MAX = 40.0       # a pass of the line within this of a displaced stop is a candidate
OFFLINE_MAX = 60.0    # displaced stop further than this from the line is flagged
VIA_DETOUR = 1.6      # via-waypoint route may be this x the straight path through the points
TOTAL_MAX_PCT = 8.0   # per-direction routed vs Remix total
SHOW_ORDER = ["11/0", "9/0"]

_last_request = 0.0
requests_made = 0
server_problems = []


def haversine(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def line_length(pts):
    return sum(haversine(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def tolerance(remix):
    return max(TOL_ABS, TOL_REL * remix)


def fetch(cache_path, url, body=None):
    """Cache-first JSON fetch. Returns the parsed JSON or None on server failure.

    Routing answers (including a definitive 'no route' 400) are cached;
    rate limits, 5xx and network errors are not.
    """
    global _last_request, requests_made
    if cache_path.exists():
        return json.loads(cache_path.read_text(encoding="utf-8"))
    for attempt in range(4):
        wait = MIN_INTERVAL - (time.monotonic() - _last_request)
        if wait > 0:
            time.sleep(wait)
        headers = {"User-Agent": USER_AGENT}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers)
        _last_request = time.monotonic()
        requests_made += 1
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                text = resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            if e.code == 400:
                try:
                    parsed = json.loads(text)
                except ValueError:
                    parsed = None
                if isinstance(parsed, dict):
                    cache_path.parent.mkdir(parents=True, exist_ok=True)
                    cache_path.write_text(text, encoding="utf-8")
                    return parsed
            server_problems.append(f"HTTP {e.code} from {url.split('/')[2]} ({cache_path.name})")
            time.sleep(5 * (attempt + 1))
            continue
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            server_problems.append(f"{type(e).__name__} from {url.split('/')[2]} ({cache_path.name})")
            time.sleep(5 * (attempt + 1))
            continue
        parsed = json.loads(text)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(text, encoding="utf-8")
        return parsed
    return None


def osrm_route(name, coords, curb):
    """Route through coords. Returns list of legs (dict) or None."""
    path = OSRM_DIR / f"{name}{'_curb' if curb else ''}.json"
    url = (OSRM_URL + ";".join(f"{c[0]:.6f},{c[1]:.6f}" for c in coords)
           + "?overview=false&geometries=geojson&steps=true"
             "&continue_straight=true&annotations=false")
    if curb:
        url += "&approaches=" + ";".join(["curb"] * len(coords))
    resp = fetch(path, url)
    if not resp or resp.get("code") != "Ok" or not resp.get("routes"):
        return None
    wps = resp["waypoints"]
    legs = []
    for i, leg in enumerate(resp["routes"][0]["legs"]):
        pts = []
        for step in leg["steps"]:
            for p in step["geometry"]["coordinates"]:
                if not pts or pts[-1] != p:
                    pts.append(p)
        if not pts:
            pts = [wps[i]["location"], wps[i + 1]["location"]]
        legs.append({
            "method": "osrm-curb" if curb else "osrm",
            "pts": pts,
            "length": leg["distance"],
            "snap": (wps[i]["distance"], wps[i + 1]["distance"]),
        })
    return legs


def decode_polyline6(s):
    pts, idx, lat, lon = [], 0, 0, 0
    while idx < len(s):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[idx]) - 63
                idx += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            d = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += d
            else:
                lon += d
        pts.append([lon / 1e6, lat / 1e6])
    return pts


RELAXED = [
    {"ignore_oneways": True, "ignore_restrictions": True, "ignore_access": True},
    {"ignore_restrictions": True, "ignore_access": True},
]


def valhalla_route(name, pts_in, relaxed=None):
    """Bus-profile route through the given points (one result for the lot). relaxed=None is the plain bus profile;
    relaxed=0/1 picks a RELAXED option set, for roads OSM currently tags as
    closed or one-way against the bus (construction, contraflow bus lanes)."""
    suffix = "" if relaxed is None else f"_relaxed{relaxed}"
    path = VALHALLA_DIR / f"{name}{suffix}.json"
    body = {
        "locations": [{"lat": q[1], "lon": q[0], "type": "break"} for q in pts_in],
        "costing": "bus",
        "units": "kilometers",
        "directions_type": "none",
    }
    if relaxed is not None:
        body["costing_options"] = {"bus": RELAXED[relaxed]}
    resp = fetch(path, VALHALLA_URL, body)
    if not resp or "trip" not in resp or resp["trip"].get("status") != 0:
        return None
    pts = []
    for leg in resp["trip"]["legs"]:
        for p in decode_polyline6(leg["shape"]):
            if not pts or pts[-1] != p:
                pts.append(p)
    if not pts:
        return None
    return {
        "method": "valhalla-bus" if relaxed is None else "valhalla-bus-relaxed",
        "pts": pts,
        "length": resp["trip"]["summary"]["length"] * 1000.0,
        "snap": (haversine(pts_in[0], pts[0]), haversine(pts_in[-1], pts[-1])),
    }


def load_directions():
    d = json.loads(REMIX.read_text(encoding="utf-8"))
    stops = {s["id"]: s for s in d["stops"]}
    out = []
    for line in d["lines"]:
        pattern = next(p for p in line["patterns"] if p.get("isPrimary"))
        for di, direction in enumerate(pattern["directions"]):
            ds = sorted(direction["directionStops"], key=lambda x: x["distanceFromStart"])
            out.append({
                "route": line["gtfsShortName"],
                "dir": di,
                "key": f"{line['gtfsShortName']}/{di}",
                "name": f"{line['gtfsShortName']}_{di}",
                "names": [stops[x["placeId"]]["name"] for x in ds],
                "coords": [stops[x["placeId"]]["geometry"]["coordinates"][:2] for x in ds],
                "dist": [x["distanceFromStart"] for x in ds],
            })
    return out


def leg_ok(cand, remix):
    return (abs(cand["length"] - remix) <= tolerance(remix)
            and max(cand["snap"]) <= SNAP_MAX)


def leg_problem(cand, remix):
    bits = []
    if abs(cand["length"] - remix) > tolerance(remix):
        bits.append("length")
    if max(cand["snap"]) > SNAP_MAX:
        bits.append(f"snap {max(cand['snap']):.0f} m")
    return "+".join(bits)


def count_flags(d, legs):
    if legs is None:
        return len(d["coords"]) - 1
    return sum(0 if leg_ok(l, d["dist"][i + 1] - d["dist"][i]) else 1
               for i, l in enumerate(legs))


def trusted_chain(d):
    """Longest subsequence of the distance-sorted stops in which every
    consecutive pair is feasible (Remix delta >= 0.9 x straight line).
    Ties prefer chains that keep the first and the last stop."""
    n = len(d["coords"])
    best = [(1, 1 if j == 0 else 0) for j in range(n)]
    parent = [None] * n
    for j in range(n):
        for i in range(j):
            if (d["dist"][j] - d["dist"][i]
                    >= FEASIBLE * haversine(d["coords"][i], d["coords"][j])):
                cand = (best[i][0] + 1, best[i][1])
                if cand > best[j]:
                    best[j], parent[j] = cand, i
    end = max(range(n), key=lambda j: (best[j][0], best[j][1] + (1 if j == n - 1 else 0), j))
    chain = []
    while end is not None:
        chain.append(end)
        end = parent[end]
    return chain[::-1]


def project(line, cum, p):
    """Closest approach of point p to each pass of the polyline.

    Returns (candidates, nearest): candidates are (perp_m, measure_m) local
    minima within PASS_MAX, one per separate pass of the line; nearest is the
    global closest (perp_m, measure_m)."""
    kx = 111320.0 * math.cos(math.radians(p[1]))
    ky = 110540.0
    per_seg = []
    for i in range(len(line) - 1):
        ax, ay = (line[i][0] - p[0]) * kx, (line[i][1] - p[1]) * ky
        bx, by = (line[i + 1][0] - p[0]) * kx, (line[i + 1][1] - p[1]) * ky
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L2))
        per_seg.append((math.hypot(ax + t * dx, ay + t * dy),
                        cum[i] + t * (cum[i + 1] - cum[i])))
    nearest = min(per_seg)
    cands, group, last_m = [], [], None
    for dist, m in per_seg:
        if dist > PASS_MAX:
            continue
        if last_m is not None and m - last_m > 100.0:
            cands.append(min(group))
            group = []
        group.append((dist, m))
        last_m = m
    if group:
        cands.append(min(group))
    return cands, nearest


def stitch(d):
    """Concatenate pre + legs + post into d['line'], d['cum'], d['tM']."""
    line = []

    def add(pts):
        for p in pts:
            q = [round(p[0], 6), round(p[1], 6)]
            if not line or line[-1] != q:
                line.append(q)

    add(d["pre"])
    tidx = []
    for k, leg in enumerate(d["legs"]):
        if k == 0:
            add(leg["pts"][:1])
            tidx.append(len(line) - 1)
        add(leg["pts"])
        tidx.append(len(line) - 1)
    add(d["post"])
    cum = [0.0]
    for k in range(1, len(line)):
        cum.append(cum[-1] + haversine(line[k - 1], line[k]))
    d["line"], d["cum"] = line, cum
    d["tM"] = [cum[k] for k in tidx]
    d["tSnap"] = [haversine(d["coords"][j], line[k]) for j, k in zip(d["T"], tidx)]


def place_displaced(d):
    """Along-line measure and perpendicular distance for each displaced stop."""
    T = d["T"]
    d["dM"], d["dPerp"] = {}, {}
    for j in d["D"]:
        cands, nearest = project(d["line"], d["cum"], d["coords"][j])
        pick = nearest
        if len(cands) == 1:
            pick = cands[0]
        elif len(cands) > 1:
            before = [k for k, t in enumerate(T) if t < j]
            after = [k for k, t in enumerate(T) if t > j]
            lo = d["tM"][before[-1]] if before else -1.0
            hi = d["tM"][after[0]] if after else float("inf")
            fits = [c for c in cands if lo <= c[1] <= hi]
            pick = min(fits) if fits else min(cands)
        d["dPerp"][j], d["dM"][j] = pick


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    dirs = load_directions()
    out = []

    def say(s=""):
        print(s, flush=True)
        out.append(s)

    # --- kerb-approach A/B on a sample (all stops, as sorted) ---------------
    ab = {False: 0, True: 0}
    for d in dirs:
        if d["route"] in AB_SAMPLE:
            for curb in (False, True):
                ab[curb] += count_flags(d, osrm_route(d["name"], d["coords"], curb))
    use_curb = ab[True] < ab[False]
    say(f"Kerb A/B on routes {', '.join(AB_SAMPLE)} (both directions): "
        f"flagged legs unrestricted={ab[False]}, curb={ab[True]} "
        f"-> using {'approaches=curb' if use_curb else 'unrestricted approaches'}")
    say()

    # --- trusted chain -------------------------------------------------------
    say("== Trusted chain (stops whose Remix distances are mutually feasible) ==")
    n_displaced = 0
    for d in dirs:
        n = len(d["coords"])
        T = trusted_chain(d)
        d["T"] = T
        d["D"] = [j for j in range(n) if j not in set(T)]
        d["tcoords"] = [d["coords"][j] for j in T]
        d["remix"] = [d["dist"][T[k + 1]] - d["dist"][T[k]] for k in range(len(T) - 1)]
        if d["D"]:
            d["rname"] = f"{d['name']}_t{zlib.crc32(','.join(map(str, T)).encode()):08x}"
        else:
            d["rname"] = d["name"]
        d["pre"], d["post"] = [], []
        n_displaced += len(d["D"])
        if d["D"]:
            ends = []
            if T[0] != 0:
                ends.append("FIRST sorted stop is not in the chain")
            if T[-1] != n - 1:
                ends.append("LAST sorted stop is not in the chain")
            say(f"{d['key']:>6}: {len(T)} trusted, {len(d['D'])} displaced: "
                + "; ".join(d["names"][j] for j in d["D"])
                + (" | " + ", ".join(ends) if ends else ""))
    say(f"Displaced stops in total: {n_displaced} "
        f"(in {sum(1 for d in dirs if d['D'])} directions)")
    say()

    def leg_name(d, k):
        a, b = d["T"][k], d["T"][k + 1]
        return f"{d['name']}_leg{a}" if b == a + 1 else f"{d['name']}_leg{a}to{b}"

    def leg_label(d, k):
        return f"{d['names'][d['T'][k]]} -> {d['names'][d['T'][k + 1]]}"

    # --- main pass -----------------------------------------------------------
    say("== Initial pass (one OSRM request per direction, trusted stops only) ==")
    total_legs = initial_flagged = 0
    for d in dirs:
        legs = osrm_route(d["rname"], d["tcoords"], use_curb)
        whole_other = False
        if legs is None:
            legs = osrm_route(d["rname"], d["tcoords"], not use_curb)
            whole_other = True
        if legs is None:
            legs = [{"method": "none", "pts": [d["tcoords"][k], d["tcoords"][k + 1]],
                     "length": float("inf"), "snap": (0.0, 0.0)}
                    for k in range(len(d["tcoords"]) - 1)]
        d["legs"] = legs
        d["flagged0"] = [k for k, l in enumerate(legs) if not leg_ok(l, d["remix"][k])]
        total_legs += len(legs)
        initial_flagged += len(d["flagged0"])
        say(f"{d['key']:>6}: trusted stops={len(d['T']):2d} "
            f"routed={sum(l['length'] for l in legs):8.0f} m "
            f"remix={sum(d['remix']):8.0f} m flagged={len(d['flagged0'])}"
            + ("  [whole direction used the other kerb setting]" if whole_other else ""))
    say(f"Legs routed: {total_legs}; flagged initially: {initial_flagged}")
    say()

    # --- fix cascade ---------------------------------------------------------
    say("== Flagged legs and what was done ==")
    unresolved = []
    for d in dirs:
        d["notes"] = {}
        for k in d["flagged0"]:
            remix = d["remix"][k]
            a, b = d["tcoords"][k], d["tcoords"][k + 1]
            first = d["legs"][k]
            cands = [first] if first["method"] != "none" else []
            chosen = None
            first_curb = first["method"] == "osrm-curb"
            # (a) the other kerb setting, as a 2-point request
            alt = osrm_route(leg_name(d, k), [a, b], not first_curb)
            if alt:
                cands.append(alt[0])
                if leg_ok(alt[0], remix):
                    chosen = alt[0]
            # (b) bus-aware router
            if chosen is None:
                v = valhalla_route(leg_name(d, k), [a, b])
                if v:
                    cands.append(v)
                    if leg_ok(v, remix):
                        chosen = v
            # (b2) bus router again, ignoring access/one-way tags
            if chosen is None:
                for r in range(len(RELAXED)):
                    v = valhalla_route(leg_name(d, k), [a, b], relaxed=r)
                    if v:
                        cands.append(v)
                        if leg_ok(v, remix):
                            chosen = v
                        break
            # (c) best effort
            reason = "fixed"
            if chosen is None:
                # a route that ignores access tags is only trusted when Remix
                # confirms its length, so it never enters the best-effort pool
                pool = [c for c in cands if c["method"] != "valhalla-bus-relaxed"]
                in_len = [c for c in pool if abs(c["length"] - remix) <= tolerance(remix)]
                near = [c for c in pool if abs(c["length"] - remix) <= KEEP_REL * remix]
                if in_len:
                    chosen = min(in_len, key=lambda c: max(c["snap"]))
                    reason = "length ok, snap still far"
                elif near:
                    chosen = min(near, key=lambda c: abs(c["length"] - remix))
                    reason = "out of tolerance, closest candidate within 50% kept"
                else:
                    crow = haversine(a, b)
                    best = min(pool, key=lambda c: abs(c["length"] - remix), default=None)
                    if best and abs(best["length"] - remix) <= abs(crow - remix):
                        # every route is far too short for Remix; a straight
                        # segment would be shorter still, so keep the road
                        chosen = best
                        reason = ("no candidate within 50%, routed kept because a "
                                  "straight segment is even further from Remix")
                    else:
                        chosen = {"method": "straight", "pts": [a, b],
                                  "length": crow, "snap": (0.0, 0.0)}
                        reason = "no candidate within 50%, straight segment"
            d["legs"][k] = chosen
            tried = "; ".join(f"{c['method']}={c['length']:.0f} m (snap {max(c['snap']):.0f})"
                              for c in cands) or "no route from any server"
            line = (f"{d['key']:>6} leg {k:2d}: {leg_label(d, k)} | "
                    f"remix={remix:.0f} m | first: {leg_problem(first, remix) or 'no route'} | "
                    f"tried: {tried} | final: {chosen['method']} {chosen['length']:.0f} m ({reason})")
            say(line)
            d["notes"][k] = reason
            if reason != "fixed":
                unresolved.append(line)
    say()

    # --- re-insert displaced stops by geometry -------------------------------
    say("== Displaced stops re-inserted by projection onto the routed line ==")
    off_line = []
    for d in dirs:
        stitch(d)
        place_displaced(d)
        tried_via = set()
        vias = {}  # trusted leg index -> displaced stops already added as waypoints
        while True:
            todo = [j for j in d["D"] if d["dPerp"][j] > OFFLINE_MAX and j not in tried_via]
            if not todo:
                break
            j = max(todo, key=lambda x: d["dPerp"][x])  # farthest first
            tried_via.add(j)
            s, m = d["coords"][j], d["dM"][j]
            msg = (f"{d['key']:>6}: {d['names'][j]} is {d['dPerp'][j]:.0f} m off the line "
                   f"at {m:.0f} m -> ")
            if m <= d["tM"][0] + 1.0 or m >= d["tM"][-1] - 1.0:
                # beyond a trusted terminal: extend the line to reach the stop
                at_start = m <= d["tM"][0] + 1.0
                t = d["tcoords"][0] if at_start else d["tcoords"][-1]
                pts = [s, t] if at_start else [t, s]
                name = f"{d['name']}_ext{j}"
                cand = None
                for get in (lambda: osrm_route(name, pts, False), lambda: [valhalla_route(name, pts)]):
                    c = get()
                    if c and c[0] and max(c[0]["snap"]) <= OFFLINE_MAX \
                            and c[0]["length"] <= 3 * haversine(s, t) + 200:
                        cand = c[0]
                        break
                if cand:
                    d["pre" if at_start else "post"] = cand["pts"]
                    msg += (f"line extended {'before the first' if at_start else 'past the last'}"
                            f" trusted stop by {cand['length']:.0f} m ({cand['method']})")
                else:
                    msg += "no plausible extension found, left off the line"
            else:
                k = max(k for k in range(len(d["legs"])) if d["tM"][k] <= m)
                a, b = d["tcoords"][k], d["tcoords"][k + 1]
                old, remix = d["legs"][k], d["remix"][k]
                old_len = d["tM"][k + 1] - d["tM"][k]
                vs = sorted(vias.get(k, []) + [j], key=lambda x: d["dM"][x])
                wp = [a] + [d["coords"][x] for x in vs] + [b]
                name = f"{d['name']}_via{'-'.join(map(str, vs))}_{d['T'][k]}_{d['T'][k + 1]}"
                # Every listed stop is served, so the line has to pass it: accept
                # the detour if it fits Remix, or failing that if it is not an
                # absurd way to drive through the points.
                geo_max = VIA_DETOUR * sum(haversine(wp[i], wp[i + 1])
                                           for i in range(len(wp) - 1)) + 150.0
                cand = None
                tried = []
                for get in (lambda: osrm_route(name, wp, False),
                            lambda: [valhalla_route(name, wp)]):
                    c = get()
                    if not c or not c[0]:
                        continue
                    length = sum(x["length"] for x in c) if len(c) > 1 else c[0]["length"]
                    tried.append(f"{c[0]['method']}={length:.0f}")
                    if (abs(length - remix) <= tolerance(remix)
                            or abs(length - remix) <= abs(old_len - remix)
                            or length <= geo_max):
                        pts = [p for x in c for p in x["pts"]]
                        cand = {"method": c[0]["method"].replace("-curb", "") + "+via", "pts": pts,
                                "length": length, "snap": (c[0]["snap"][0], c[-1]["snap"][1])}
                        break
                if cand:
                    d["legs"][k] = cand
                    vias[k] = vs
                    msg += (f"added as a waypoint in leg {leg_label(d, k)}: "
                            f"{old_len:.0f} m -> {cand['length']:.0f} m (remix {remix:.0f})")
                else:
                    msg += (f"waypoint in leg {leg_label(d, k)} rejected as implausible "
                            f"(was {old_len:.0f} m, remix {remix:.0f}, tried {', '.join(tried) or 'no route'})")
            stitch(d)
            place_displaced(d)
            msg += f"; now {d['dPerp'][j]:.0f} m off"
            say(msg)
        for j in d["D"]:
            if d["dPerp"][j] > OFFLINE_MAX:
                off_line.append(f"{d['key']} {d['names'][j]}: {d['dPerp'][j]:.0f} m from the line")
    for d in dirs:
        if d["D"]:
            say(f"{d['key']:>6}: " + "; ".join(
                f"{d['names'][j]} at {d['dM'][j]:.0f} m ({d['dPerp'][j]:.0f} m off)" for j in d["D"]))
    say(f"Displaced stops still more than {OFFLINE_MAX:.0f} m from their line: {len(off_line)}")
    for s in off_line:
        say("  " + s)
    say()

    # --- order, measures, output --------------------------------------------
    shapes = {}
    method_count = {}
    far_total = []
    say("== After fixes (routed vs Remix between first and last trusted stop) ==")
    for d in dirs:
        T = d["T"]
        m_of = dict(zip(T, d["tM"]))
        m_of.update(d["dM"])
        order = sorted(range(len(d["coords"])), key=lambda j: (m_of[j], j))
        d0 = d["dist"][T[0]]
        tD = [d["dist"][j] - d0 for j in T]
        stop_d = []
        for j in order:
            if j in d["dM"]:
                m = m_of[j]
                left = max((k for k in range(len(T)) if d["tM"][k] <= m), default=None)
                right = min((k for k in range(len(T)) if d["tM"][k] >= m), default=None)
                if left is None:
                    v = tD[0] - (d["tM"][0] - m)
                elif right is None:
                    v = tD[-1] + (m - d["tM"][-1])
                elif d["tM"][right] == d["tM"][left]:
                    v = tD[left]
                else:
                    f = (m - d["tM"][left]) / (d["tM"][right] - d["tM"][left])
                    v = tD[left] + f * (tD[right] - tD[left])
            else:
                v = d["dist"][j] - d0
            stop_d.append(round(v, 1))
        for leg in d["legs"]:
            method_count[leg["method"]] = method_count.get(leg["method"], 0) + 1
        shapes[d["key"]] = {
            "line": d["line"],
            "order": order,
            "stopM": [round(m_of[j], 1) for j in order],
            "stopD": stop_d,
            "displaced": sorted(d["D"]),
            "legMethod": [l["method"] for l in d["legs"]],
        }
        d["order"] = order
        d["m_of"] = m_of
        routed = d["tM"][-1] - d["tM"][0]
        remix_total = d["dist"][T[-1]] - d["dist"][T[0]]
        diff = 100 * (routed / remix_total - 1)
        bad = [k for k in range(len(d["legs"]))
               if abs((d["tM"][k + 1] - d["tM"][k]) - d["remix"][k]) > tolerance(d["remix"][k])]
        far = [f"{d['names'][j]} ({s:.0f} m)" for j, s in zip(T, d["tSnap"]) if s > SNAP_MAX]
        if abs(diff) > TOTAL_MAX_PCT:
            far_total.append(f"{d['key']}: routed {routed:.0f} m vs Remix {remix_total:.0f} m ({diff:+.1f}%)")
        say(f"{d['key']:>6}: routed={routed:8.0f} m remix={remix_total:8.0f} m diff={diff:+5.1f}% "
            f"displaced={len(d['D'])} legs out of tolerance={len(bad)}"
            + (f" | trusted stops >{SNAP_MAX:.0f} m from line: {', '.join(far)}" if far else ""))
        for k in bad:
            say(f"         leg {k:2d} {leg_label(d, k)}: "
                f"line={d['tM'][k + 1] - d['tM'][k]:.0f} m remix={d['remix'][k]:.0f} m "
                f"method={d['legs'][k]['method']} "
                f"({d['notes'].get(k, 'join between differently-routed legs')})")
    say()
    say(f"Directions whose routed total differs from Remix by more than {TOTAL_MAX_PCT:.0f}%: "
        f"{len(far_total)}")
    for s in far_total:
        say("  " + s)
    say()
    say("Legs by final method: " + ", ".join(f"{k}={v}" for k, v in sorted(method_count.items())))
    say(f"Legs not cleanly fixed: {len(unresolved)}")
    for u in unresolved:
        say("  " + u)
    say()
    say("Legs whose Remix delta is more than twice the kept route and the straight line "
        "(not repaired; cause unknown: stale distance, or a loop with no stop on it):")
    for d in dirs:
        for k in d["flagged0"]:
            crow = haversine(d["tcoords"][k], d["tcoords"][k + 1])
            if d["remix"][k] > 2 * max(crow, d["legs"][k]["length"]) and d["remix"][k] > 500:
                say(f"{d['key']:>6} leg {k}: {leg_label(d, k)} "
                    f"(remix {d['remix'][k]:.0f}, straight {crow:.0f}, "
                    f"kept {d['legs'][k]['method']} {d['legs'][k]['length']:.0f})")
    say()
    for d in dirs:
        if d["key"] in SHOW_ORDER:
            say(f"== Travel order {d['key']} (* = displaced, re-inserted) ==")
            for pos, j in enumerate(d["order"]):
                say(f"  {pos:2d} {d['m_of'][j]:7.0f} m  {'*' if j in d['dM'] else ' '} "
                    f"{d['names'][j]}  [sorted index {j}, remix {d['dist'][j]:.0f}]")
            say()
    say(f"Network requests this run: {requests_made}")
    if server_problems:
        say(f"Server problems this run ({len(server_problems)}):")
        for s in sorted(set(server_problems)):
            say("  " + s)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "shapes.json").write_text(
        json.dumps(shapes, separators=(",", ":")), encoding="utf-8")
    (OUT_DIR / "shapes_report.txt").write_text("\n".join(out) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
