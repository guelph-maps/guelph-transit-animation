"""Build data/streets.json, the simplified street network the rider walks on.

Inputs (local only, not published):
  source/remix/maps_85f5b7bf.json   for the extent of the stops
  source/osm/highways.json          every OpenStreetMap highway way in that extent; fetched
                                    from the Overpass API on the first run and kept

Output: every way a person can walk on, cut down to what the walk needs: driveways,
parking aisles and private ways dropped, bends straightened to within TOLERANCE metres,
and anything not connected to the main network removed. Sidewalks and crossings mapped
as their own lines are dropped too, the street they run along standing in for them; a
path that met one is joined to that street instead, if it is within REACH metres.

  {"origin": [lon, lat], "scale": 100000,
   "xy":   [x0, y0, x1, y1, ...],     node k is at origin + (x, y) / scale degrees
   "ways": [[k, k, k, ...], ...]}     consecutive nodes of a way are joined by a segment

Run:  python -I tools/build_streets.py
"""
import json
import math
import os
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMIX = os.path.join(ROOT, "source", "remix", "maps_85f5b7bf.json")
RAW = os.path.join(ROOT, "source", "osm", "highways.json")
OUT = os.path.join(ROOT, "data", "streets.json")
OVERPASS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
)

MARGIN = 1500      # metres around the stops
TOLERANCE = 4.0    # metres a simplified line may stray from the mapped one
REACH = 30.0       # metres from the end of a path at a sidewalk to the street it runs along
SCALE = 100000     # 1e-5 degree, about a metre

ROADS = {
    "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street",
    "trunk_link", "primary_link", "secondary_link", "tertiary_link", "service", "pedestrian",
    "footway", "path", "cycleway", "steps", "track", "bridleway", "busway", "corridor",
    # Streets being rebuilt as this is written (Wyndham and Quebec downtown): the
    # proposed buses run on them, so they will be open by then.
    "construction",
}
NO_SERVICE = {"driveway", "parking_aisle", "drive-through", "emergency_access"}
FOOT_OK = {"yes", "designated", "permissive", "destination"}
STREETS = ROADS - {"footway", "path", "cycleway", "steps", "track", "bridleway", "corridor"}


def kerbside(tags):
    return tags.get("highway") == "footway" and tags.get("footway") in ("sidewalk", "crossing")


def join_to_streets(ways, dropped, node, kx, ky):
    """Join each node where a kept way met a dropped sidewalk to the nearest street.

    Adds two-node ways (and, where the nearest point is inside a segment, a new node in
    that street). Returns how many joins were made.
    """
    cell = 60.0
    grid = {}
    streets = [w for w in ways if w["tags"]["highway"] in STREETS]
    on_street = {n for w in streets for n in w["nodes"]}
    for wi, w in enumerate(streets):
        for i in range(len(w["nodes"]) - 1):
            (ax, ay), (bx, by) = ((node[n][0] * kx, node[n][1] * ky) for n in w["nodes"][i:i + 2])
            for gx in range(int(min(ax, bx) // cell), int(max(ax, bx) // cell) + 1):
                for gy in range(int(min(ay, by) // cell), int(max(ay, by) // cell) + 1):
                    grid.setdefault((gx, gy), []).append((wi, i))
    lost = {n for w in dropped for n in w["nodes"]}
    ends = {n for w in ways for n in w["nodes"] if n in lost} - on_street
    inserts = {}     # (street, segment) -> [(t, new node)]
    links = []
    for n in sorted(ends):
        px, py = node[n][0] * kx, node[n][1] * ky
        best = (REACH, None)
        gx, gy = int(px // cell), int(py // cell)
        for key in ((gx + i, gy + j) for i in (-1, 0, 1) for j in (-1, 0, 1)):
            for wi, i in grid.get(key, ()):
                a, b = streets[wi]["nodes"][i:i + 2]
                ax, ay, bx, by = node[a][0] * kx, node[a][1] * ky, node[b][0] * kx, node[b][1] * ky
                L2 = (bx - ax) ** 2 + (by - ay) ** 2
                t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / L2))
                d = math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay))
                if d < best[0]:
                    best = (d, (wi, i, t, a, b, math.sqrt(L2)))
        if best[1] is None:
            continue
        wi, i, t, a, b, L = best[1]
        if t * L < 3:
            target = a
        elif (1 - t) * L < 3:
            target = b
        else:
            target = -len(node) - 1          # ids OpenStreetMap does not use
            node[target] = (node[a][0] + t * (node[b][0] - node[a][0]), node[a][1] + t * (node[b][1] - node[a][1]))
            inserts.setdefault((wi, i), []).append((t, target))
        links.append({"nodes": [n, target], "tags": {"highway": "footway"}})
    for (wi, i), new in sorted(inserts.items(), key=lambda kv: -kv[0][1]):
        streets[wi]["nodes"][i + 1:i + 1] = [n for _, n in sorted(new)]
    ways += links
    return len(links)


def walkable(tags):
    hw = tags.get("highway")
    if hw not in ROADS:
        return False
    foot = tags.get("foot")
    if foot in FOOT_OK:
        return True
    if foot in ("no", "private"):
        return False
    if tags.get("access") in ("no", "private"):
        return False
    if tags.get("motorroad") == "yes":
        return False
    if hw == "service" and tags.get("service") in NO_SERVICE:
        return False
    # An expressway: a trunk road nobody mapped a place to walk on.
    if hw in ("trunk", "trunk_link") and tags.get("sidewalk", "no") in ("no", "none", "separate"):
        return False
    return True


def bbox():
    remix = json.load(open(REMIX, encoding="utf-8"))
    lons = [s["geometry"]["coordinates"][0] for s in remix["stops"]]
    lats = [s["geometry"]["coordinates"][1] for s in remix["stops"]]
    dlat = MARGIN / 111320
    dlon = dlat / math.cos(math.radians(sum(lats) / len(lats)))
    return (round(min(lats) - dlat, 4), round(min(lons) - dlon, 4), round(max(lats) + dlat, 4), round(max(lons) + dlon, 4))


def fetch():
    if os.path.exists(RAW):
        return json.load(open(RAW, encoding="utf-8"))
    s, w, n, e = bbox()
    query = f"[out:json][timeout:180];way[highway]({s},{w},{n},{e});out body;>;out skel qt;"
    print("fetching", query)
    body = None
    for url in OVERPASS:
        req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": query}).encode(),
                                     headers={"User-Agent": "street-network-builder"})
        try:
            body = urllib.request.urlopen(req, timeout=300).read()
            json.loads(body)
            break
        except Exception as err:   # a busy server: try the next one
            print(f"  {url}: {err}")
            body = None
    if body is None:
        sys.exit("no Overpass server answered")
    os.makedirs(os.path.dirname(RAW), exist_ok=True)
    with open(RAW, "wb") as f:
        f.write(body)
    return json.loads(body)


def simplify(pts, tol):
    """Douglas-Peucker on [(x, y)] in metres; returns the indices kept."""
    keep = [0, len(pts) - 1]
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        worst, at = -1.0, a
        for i in range(a + 1, b):
            px, py = pts[i]
            if L2 == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
                d = math.hypot(px - ax - t * dx, py - ay - t * dy)
            if d > worst:
                worst, at = d, i
        if worst > tol:
            keep.append(at)
            stack += [(a, at), (at, b)]
    return sorted(keep)


def main():
    raw = fetch()
    node = {e["id"]: (e["lon"], e["lat"]) for e in raw["elements"] if e["type"] == "node"}
    every = [e for e in raw["elements"] if e["type"] == "way" and walkable(e.get("tags", {}))]
    ways = [w for w in every if not kerbside(w["tags"])]
    lat0 = sum(node[n][1] for w in ways for n in w["nodes"]) / sum(len(w["nodes"]) for w in ways)
    kx, ky = 111320 * math.cos(math.radians(lat0)), 111320
    joins = join_to_streets(ways, [w for w in every if kerbside(w["tags"])], node, kx, ky)

    # Cut every way at the nodes it shares with another (or meets itself at), so that
    # straightening a piece never moves a junction.
    uses = {}
    for w in ways:
        for i, n in enumerate(w["nodes"]):
            uses[n] = uses.get(n, 0) + (1 if 0 < i < len(w["nodes"]) - 1 else 2)
    pieces = []
    for w in ways:
        cur = [w["nodes"][0]]
        for n in w["nodes"][1:]:
            cur.append(n)
            if uses[n] > 1:
                pieces.append(cur)
                cur = [n]
        if len(cur) > 1:
            pieces.append(cur)
    before = sum(len(p) - 1 for p in pieces)
    slim = []
    for p in pieces:
        pts = [(node[n][0] * kx, node[n][1] * ky) for n in p]
        slim.append([p[i] for i in simplify(pts, TOLERANCE)])

    # Keep the largest connected part.
    parent = {}

    def find(a):
        while parent.setdefault(a, a) != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for p in slim:
        for a, b in zip(p, p[1:]):
            parent[find(a)] = find(b)
    size = {}
    for p in slim:
        size[find(p[0])] = size.get(find(p[0]), 0) + len(p) - 1
    main_part = max(size, key=size.get)
    kept = [p for p in slim if find(p[0]) == main_part]

    lon0 = min(node[n][0] for p in kept for n in p)
    lat_min = min(node[n][1] for p in kept for n in p)
    index, xy = {}, []
    out_ways = []
    metres = 0.0
    for p in kept:
        row = []
        for n in p:
            if n not in index:
                index[n] = len(index)
                xy += [round((node[n][0] - lon0) * SCALE), round((node[n][1] - lat_min) * SCALE)]
            row.append(index[n])
        for a, b in zip(p, p[1:]):
            metres += math.hypot((node[a][0] - node[b][0]) * kx, (node[a][1] - node[b][1]) * ky)
        out_ways.append(row)

    out = {"origin": [round(lon0, 5), round(lat_min, 5)], "scale": SCALE, "xy": xy, "ways": out_ways}
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, separators=(",", ":"))

    segs = sum(len(p) - 1 for p in kept)
    print(f"{len(every)} walkable ways, {len(every) - len(ways) + joins} of them sidewalks and crossings, replaced by {joins} joins")
    print(f"{len(ways)} ways kept of {sum(1 for e in raw['elements'] if e['type'] == 'way')}")
    print(f"{before} segments before straightening, {sum(len(p) - 1 for p in slim)} after, {segs} in the main part"
          f" ({len(size) - 1} islands dropped)")
    print(f"{len(index)} nodes, {metres / 1000:.0f} km")
    print(f"wrote {OUT} ({os.path.getsize(OUT) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
