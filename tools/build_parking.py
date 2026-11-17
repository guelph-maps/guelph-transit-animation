"""Build data/parking.json, where a bicycle can be parked in Guelph.

Input (a sibling project, read as it is on disk, never written):
  ../guelph-bike-parking/data/bike-parking.geojson
      the data behind https://guelph.bike/, made from OpenStreetMap by that project

Output: one position per rack. Private parking (access=private) is left out, as it is
on that map.

  {"source": "https://guelph.bike/", "osm_base": "2026-11-16T18:23:43Z",
   "lonlat": [lon0, lat0, lon1, lat1, ...]}

Run:  python -I tools/build_parking.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(os.path.dirname(ROOT), "guelph-bike-parking", "data", "bike-parking.geojson")
OUT = os.path.join(ROOT, "data", "parking.json")


def main():
    if not os.path.exists(SRC):
        sys.exit("missing " + SRC + ": clone https://github.com/guelph-maps/guelph-bike-parking beside this project")
    with open(SRC, encoding="utf-8") as f:
        data = json.load(f)
    lonlat, private = [], 0
    for feature in data["features"]:
        if feature["properties"].get("access") == "private":
            private += 1
            continue
        lon, lat = feature["geometry"]["coordinates"]
        lonlat += [round(lon, 6), round(lat, 6)]
    out = {"source": "https://guelph.bike/", "osm_base": data["metadata"]["osm_base"], "lonlat": lonlat}
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")
    print("%d racks (%d private left out), OpenStreetMap as of %s, %d bytes"
          % (len(lonlat) // 2, private, out["osm_base"], os.path.getsize(OUT)))


if __name__ == "__main__":
    main()
