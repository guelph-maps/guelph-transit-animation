"""Take each direction's line from the Remix map itself and place its stops on it.

The map data (source/remix/maps_85f5b7bf.json) has no geometry, but the public map
draws its lines from a second request, which this script repeats once:

  POST https://platform.remix.com/api/maps/85f5b7bf/directions/detail  {"ids": [...]}

Each direction comes back as a hex string of TWKB (Tiny Well-Known Binary): a
MultiLineString whose parts are the stretches between the points the planner clicked.

Stops are placed by projecting them onto the line, not by Remix's distanceFromStart:
in a quarter of the directions that field is left over from an earlier, longer or shorter
version of the line and is off by hundreds of metres from some stop onward. Where the
line passes a stop more than once (a street driven out and back, a loop), the pass that
comes nearest is taken, then the one with the stop on its right, and distanceFromStart
only settles what is left.

shapes.json per direction ("<route>/<0|1>"): line ([lon, lat]), order (indices into
the stops sorted by distanceFromStart, in travel order), stopM (metres along line),
off (metres from each stop to the line), straight (the parts of 100 m or more that are
one straight segment, as [from metres, to metres]; nearly all are straight streets).

Run:  python -I tools/remix_shapes.py
Outputs: source/derived/shapes.json, source/derived/shapes_report.txt
Cache:   source/remix/directions_detail_85f5b7bf.json (a rerun makes no request)
"""
import json
import math
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REMIX = ROOT / "source" / "remix" / "maps_85f5b7bf.json"
DETAIL = ROOT / "source" / "remix" / "directions_detail_85f5b7bf.json"
OUT_DIR = ROOT / "source" / "derived"
URL = "https://platform.remix.com/api/maps/85f5b7bf/directions/detail"

PASS_MAX = 60.0       # metres: a pass of the line this near a stop may be where it stops
PASS_GAP = 80.0       # metres along the line between two separate passes
NEAR = 25.0           # metres: passes this much farther off than the nearest are not considered
OFF_MAX = 40.0        # metres: a stop farther than this from its line is reported
STRAIGHT_MIN = 100.0  # metres: a two-point part this long is listed in the report


def haversine(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def twkb_lines(raw):
    """Parts of a TWKB LineString or MultiLineString, each a list of [lon, lat]."""
    pos = 2

    def varint():
        nonlocal pos
        shift = value = 0
        while True:
            byte = raw[pos]
            pos += 1
            value |= (byte & 0x7F) << shift
            shift += 7
            if byte < 0x80:
                return value

    def zigzag(n):
        return (n >> 1) ^ -(n & 1)

    kind, scale, meta = raw[0] & 0x0F, 10 ** zigzag(raw[0] >> 4), raw[1]
    if meta & 0x08:
        raise ValueError("TWKB with extra dimensions")
    if meta & 0x02:
        varint()                      # size
    if meta & 0x01:
        for _ in range(4):            # bounding box
            varint()
    if meta & 0x10:
        return []                     # empty geometry
    if kind not in (2, 5):
        raise ValueError(f"TWKB type {kind} is not a line")
    x = y = 0
    parts = []
    for _ in range(varint() if kind == 5 else 1):
        pts = []
        for _ in range(varint()):
            x += zigzag(varint())
            y += zigzag(varint())
            pts.append([x / scale, y / scale])
        parts.append(pts)
    if pos != len(raw):
        raise ValueError("TWKB has bytes left over")
    return parts


def fetch_detail(ids):
    if DETAIL.exists():
        detail = json.loads(DETAIL.read_text(encoding="utf-8"))
        if {d["id"] for d in detail["directions"]} >= set(ids):
            return detail
    req = urllib.request.Request(URL, data=json.dumps({"ids": ids}).encode("utf-8"), headers={
        "User-Agent": "transit-shape-builder/0.2", "Content-Type": "application/json",
        "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode("utf-8")
    DETAIL.write_text(text, encoding="utf-8")
    return json.loads(text)


def passes(line, cum, p):
    """Where the line comes near point p: one (metres off, metres along, on the right)
    per separate pass within PASS_MAX, and the nearest point of all."""
    kx, ky = 111320.0 * math.cos(math.radians(p[1])), 110540.0
    per = []
    for i in range(len(line) - 1):
        ax, ay = (line[i][0] - p[0]) * kx, (line[i][1] - p[1]) * ky
        bx, by = (line[i + 1][0] - p[0]) * kx, (line[i + 1][1] - p[1]) * ky
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L2))
        # p is the origin here; it is on the right of travel when a->b passes it clockwise
        right = ax * dy - ay * dx < 0
        per.append((math.hypot(ax + t * dx, ay + t * dy), cum[i] + t * (cum[i + 1] - cum[i]), right))
    found, group, last = [], [], None
    for c in per:
        if c[0] > PASS_MAX:
            continue
        if last is not None and c[1] - last > PASS_GAP:
            found.append(min(group))
            group = []
        group.append(c)
        last = c[1]
    if group:
        found.append(min(group))
    return found, min(per)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    remix = json.loads(REMIX.read_text(encoding="utf-8"))
    stops = {s["id"]: s for s in remix["stops"]}
    in_service = {i for ids in remix["inServicePatternIdsByDayBatchId"].values() for i in ids}

    dirs = []
    for line in remix["lines"]:
        patterns = [p for p in line["patterns"] if p["id"] in in_service]
        if len(patterns) != 1:
            sys.exit(f"{line['gtfsShortName']}: expected one in-service pattern, found {len(patterns)}")
        for di, direction in enumerate(patterns[0]["directions"]):
            dirs.append((f"{line['gtfsShortName']}/{di}", direction))
    detail = fetch_detail([d["id"] for _, d in dirs])
    hexes = {d["id"]: d["geometry"] for d in detail["directions"]}

    out = []

    def say(s=""):
        print(s, flush=True)
        out.append(s)

    shapes = {}
    n_stops = n_multi = n_by_distance = n_stale_dirs = 0
    far, straights, ends, stale = [], [], [], []
    for key, direction in dirs:
        parts = twkb_lines(bytes.fromhex(hexes[direction["id"]]))
        line = []
        part_at = []                      # index in `line` where each part ends
        for part in parts:
            for p in part:
                q = [round(p[0], 6), round(p[1], 6)]
                if not line or line[-1] != q:
                    line.append(q)
            part_at.append(len(line) - 1)
        cum = [0.0]
        for a, b in zip(line, line[1:]):
            cum.append(cum[-1] + haversine(a, b))

        straight = []
        start = 0
        for part, end in zip(parts, part_at):
            if len(part) == 2 and cum[end] - cum[start] >= STRAIGHT_MIN:
                straight.append([round(cum[start], 1), round(cum[end], 1)])
            start = end
        if straight:
            straights.append(f"{key:>6}: " + ", ".join(f"{b - a:.0f} m at {a:.0f} m" for a, b in straight))

        ds = sorted(direction["directionStops"], key=lambda s: s["distanceFromStart"])
        names = [stops[s["placeId"]]["name"] for s in ds]
        cands = []
        for s in ds:
            found, nearest = passes(line, cum, stops[s["placeId"]]["geometry"]["coordinates"])
            cands.append(found or [nearest])
        # How far Remix's own distance runs ahead of the line, from the stops with one pass.
        lag = [s["distanceFromStart"] - c[0][1] if len(c) == 1 else None for s, c in zip(ds, cands)]

        def lag_near(j):
            known = [(abs(k - j), lag[k]) for k in range(len(ds)) if lag[k] is not None]
            return min(known)[1] if known else 0.0

        m, off = [], []
        for j, (s, c) in enumerate(zip(ds, cands)):
            if len(c) > 1:
                n_multi += 1
                want = s["distanceFromStart"] - lag_near(j)
                near = [x for x in c if x[0] <= min(c)[0] + NEAR]
                near = [x for x in near if x[2]] or near
                pick = min(near, key=lambda x: abs(x[1] - want))
                if len(near) > 1:
                    n_by_distance += 1
            else:
                pick = c[0]
            m.append(pick[1])
            off.append(pick[0])
            n_stops += 1
            if pick[0] > OFF_MAX:
                far.append(f"{key} {names[j]}: {pick[0]:.0f} m from the line")
        order = sorted(range(len(ds)), key=lambda j: (m[j], j))
        if order != list(range(len(ds))):
            moved = [names[j] for pos, j in enumerate(order) if pos != j]
            say(f"{key:>6}: travel order differs from Remix's distance order for {len(moved)} stops: "
                + "; ".join(moved))
        drift = [abs(s["distanceFromStart"] - x) for s, x in zip(ds, m)]
        if max(drift) > 60:
            n_stale_dirs += 1
            first = next(j for j in order if drift[j] > 60)
            stale.append(f"{key:>6}: {sum(1 for x in drift if x > 60)} of {len(ds)} stops, "
                         f"by up to {max(drift):.0f} m, from {names[first]}")
        before, after = m[order[0]], cum[-1] - m[order[-1]]
        if before > 60 or after > 60:
            ends.append(f"{key:>6}: {before:.0f} m of line before the first stop, {after:.0f} m after the last")

        shapes[key] = {
            "line": line,
            "order": order,
            "stopM": [round(m[j], 1) for j in order],
            "off": [round(off[j], 1) for j in order],
            "straight": straight,
        }

    say()
    say(f"{len(shapes)} directions, {n_stops} stops, "
        f"{sum(haversine(a, b) for s in shapes.values() for a, b in zip(s['line'], s['line'][1:])) / 1000:.0f} km of line")
    say(f"Stops the line passes more than once: {n_multi} "
        f"({n_by_distance} of them settled by Remix's distance, the rest by nearness and side)")
    say(f"Stops more than {OFF_MAX:.0f} m from their line: {len(far)}")
    for s in far:
        say("  " + s)
    say()
    say(f"Directions with line beyond their end stops (more than 60 m): {len(ends)}")
    for s in ends:
        say(s)
    say()
    say(f"Parts of {STRAIGHT_MIN:.0f} m or more that are one straight segment: "
        f"{sum(len(s['straight']) for s in shapes.values())} in {len(straights)} directions")
    for s in straights:
        say(s)
    say()
    say(f"Directions where Remix's distanceFromStart is more than 60 m from the line: {n_stale_dirs}")
    for s in stale:
        say(s)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "shapes.json").write_text(json.dumps(shapes, separators=(",", ":")), encoding="utf-8")
    (OUT_DIR / "shapes_report.txt").write_text("\n".join(out) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
