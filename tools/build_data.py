"""Build data/network.json, the only data file the web app loads.

Inputs (local only, not published):
  source/remix/maps_85f5b7bf.json      the public Remix map of the proposed network
  source/remix/projects_6a3a211f.json  the Remix project: how the city draws each line
  source/derived/shapes.json           optional; the map's own lines, from tools/remix_shapes.py

Without shapes.json every direction is drawn as straight lines between its stops.

Run:  python -I tools/build_data.py
"""
import json
import math
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMIX = os.path.join(ROOT, "source", "remix", "maps_85f5b7bf.json")
PROJECT = os.path.join(ROOT, "source", "remix", "projects_6a3a211f.json")
SHAPES = os.path.join(ROOT, "source", "derived", "shapes.json")
OUT = os.path.join(ROOT, "data", "network.json")

DAY_KEYS = {"1111100": "weekday", "0000010": "saturday", "0000001": "sunday"}


def haversine(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def route_class(short):
    n = int("".join(c for c in short if c.isdigit()))
    if n >= 80:
        return "frequent"
    if 50 <= n <= 59:
        return "university"
    return "base"


def sort_key(short):
    n = int("".join(c for c in short if c.isdigit()))
    return (n, short)


def main():
    remix = json.load(open(REMIX, encoding="utf-8"))
    shapes = json.load(open(SHAPES, encoding="utf-8")) if os.path.exists(SHAPES) else {}
    stops_by_id = {s["id"]: s for s in remix["stops"]}

    # The colour and dash the city gave each line on its Remix map.
    project = json.load(open(PROJECT, encoding="utf-8"))
    if len(project["scenarios"]) != 1:
        sys.exit(f"expected one scenario, found {len(project['scenarios'])}")
    drawn = {s["lineId"]: s for s in project["scenarios"][0]["lineSettings"]}

    in_service = set()
    for ids in remix["inServicePatternIdsByDayBatchId"].values():
        in_service.update(ids)

    routes = []
    n_shaped = 0
    for line in sorted(remix["lines"], key=lambda l: sort_key(l["gtfsShortName"])):
        short = line["gtfsShortName"]
        patterns = [p for p in line["patterns"] if p["id"] in in_service]
        if len(patterns) != 1:
            sys.exit(f"{short}: expected one in-service pattern, found {len(patterns)}")

        dirs = []
        for di, direction in enumerate(patterns[0]["directions"]):
            ds = sorted(direction["directionStops"], key=lambda s: s["distanceFromStart"])
            if len(ds) < 2:
                sys.exit(f"{short}/{di}: fewer than two stops")
            shape = shapes.get(f"{short}/{di}")
            if shape:
                # Travel order comes from the line, not from Remix's distanceFromStart,
                # which in many directions belongs to an earlier version of the line.
                if sorted(shape["order"]) != list(range(len(ds))):
                    sys.exit(f"{short}/{di}: shape order does not cover the stops")
                ds = [ds[i] for i in shape["order"]]
                coords = [stops_by_id[s["placeId"]]["geometry"]["coordinates"] for s in ds]
                line_coords = shape["line"]
                m = [round(x, 1) for x in shape["stopM"]]
                n_shaped += 1
            else:
                coords = [stops_by_id[s["placeId"]]["geometry"]["coordinates"] for s in ds]
                line_coords = [[round(c[0], 6), round(c[1], 6)] for c in coords]
                m = [0.0]
                for a, b in zip(coords, coords[1:]):
                    m.append(round(m[-1] + haversine(a, b), 1))
            if any(y < x for x, y in zip(m, m[1:])):
                sys.exit(f"{short}/{di}: stop distances are not non-decreasing")
            length = sum(haversine(a, b) for a, b in zip(line_coords, line_coords[1:]))

            dirs.append({
                "name": direction["name"].capitalize(),
                "from": stops_by_id[ds[0]["placeId"]]["name"],
                "to": stops_by_id[ds[-1]["placeId"]]["name"],
                "length": round(length, 1),   # metres of `line`; a bus runs all of it
                "line": line_coords,          # [lon, lat]
                "stops": [
                    {
                        "name": stops_by_id[s["placeId"]]["name"],
                        "lon": round(c[0], 6),
                        "lat": round(c[1], 6),
                        "m": mm,          # metres along `line`
                    }
                    for s, c, mm in zip(ds, coords, m)
                ],
            })

        look = drawn.get(line["id"])
        if not look or not re.fullmatch(r"#[0-9a-fA-F]{6}", look["color"] or ""):
            sys.exit(f"{short}: no line colour in the Remix project")
        if (look["lineStyle"] == "dashed") != (route_class(short) == "university"):
            sys.exit(f"{short}: line style {look['lineStyle']} does not match its class")

        day_of = {dt["id"]: DAY_KEYS[dt["days"]] for dt in line["dayTypes"]}
        service = {"weekday": [], "saturday": [], "sunday": []}
        for w in sorted(line["windows"], key=lambda w: w["start"]):
            if w["directionality"] != "roundtrip":
                sys.exit(f"{short}: unexpected directionality {w['directionality']}")
            service[day_of[w["dayTypeId"]]].append({
                "start": w["start"],                 # minutes after midnight
                "end": w["end"],                     # may run past 1440
                "headway": w["headwaySeconds"],      # seconds
                "speed": round(w["speed"], 2),       # km/h, average including stops
            })

        routes.append({
            "id": short,
            "name": line["gtfsLongName"],
            "class": route_class(short),
            "color": look["color"].lower(),      # as on the city's Remix map
            "dirs": dirs,
            "service": service,
        })

    layover = remix["layoverSettings"][0]["settings"][0]
    out = {
        "title": "Guelph Transit proposed network (Future Ready Action Plan Update, November 2026)",
        "source": "City of Guelph public Remix map, https://platform.remix.com/project/6a3a211f, fetched 2026-11-17",
        "note": "Stops and frequencies are the city's tentative proposal. Bus positions are simulated from headways and average speeds, not from a timetable.",
        "shapes": "the lines of the Remix map" if n_shaped else "straight lines between stops",
        "layover": {"seconds": layover["seconds"], "share": layover["percentage"]},
        "routes": routes,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)

    n_dirs = sum(len(r["dirs"]) for r in routes)
    counts = {}
    for r in routes:
        counts[r["class"]] = counts.get(r["class"], 0) + 1
    print(f"{len(routes)} routes {counts}, {n_dirs} directions, {n_shaped} with the map's own line")
    for day in ("weekday", "saturday", "sunday"):
        print(f"  {day}: {sum(1 for r in routes if r['service'][day])} routes in service")
    print(f"wrote {OUT} ({os.path.getsize(OUT) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
