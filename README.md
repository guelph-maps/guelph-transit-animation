# guelph-transit-animation

An animated map of the transit network Guelph Transit is proposing in its Future Ready
Action Plan Update (public consultation 9–27 November 2026).

The city published the proposed network as static PDF maps and an interactive Remix map.
Neither shows what the service would feel like: how often a bus comes, where the frequent
corridors are, how the network breathes over a day. This page puts simulated buses on the
34 proposed routes at the proposed frequencies, so a resident can see it rather than read
a legend.

Not an official City of Guelph product.

## What it does

- Buses move along all 34 proposed routes over a service day, 5 am to 2 am.
- Weekday / Saturday / Sunday toggle. The six university routes (50–55) and the 92A
  short turn run on weekdays only.
- Play / pause, three speeds, and a time slider.
- Route lines are coloured by class (high-frequency, base, university) and their
  thickness follows how often a bus comes at the time shown. Routes not running are faint.
- Hovering a line lists the routes there and their current frequency.

## Run it

It is a static site: `index.html`, `app.js`, `style.css` and `data/network.json`.
Serve the folder with anything, for example:

```
python -m http.server 8765
```

and open http://localhost:8765. MapLibre GL JS is loaded from unpkg and the basemap from
OpenFreeMap (no key).

## How the simulation works, and what it assumes

The city has published frequencies, not timetables, so every bus position is made up
from these inputs per route and day type: service windows (start, end, headway) and an
average speed.

- **Round trips.** Each window sends a bus from the start of direction 0 every headway.
  The bus runs direction 0, waits at the far end, runs direction 1 and disappears.
- **`end` is read as "no departures at or after this time"**, so buses already out finish
  their trip after it. The data does not say which meaning Remix intends.
- **Layover** at the far end is the larger of 180 s and 15% of the outbound running time,
  taken from the map's layover setting. Remix may apply it differently.
- **Speed is one average per window**, stops included. Buses do not dwell at stops or
  slow down downtown.
- **Routes are independent.** No interlining, no timed connections, no garage trips.
- **Statutory holidays** are not in the data and not shown.

## Data

`data/network.json` is the only data the page loads. `tools/build_data.py` builds it from
two local inputs that are not in this repository:

- `source/remix/maps_85f5b7bf.json` — the data behind the public Remix map
  (`https://platform.remix.com/api/maps/85f5b7bf`, fetched 2026-11-17, no login).
  It has the 34 lines, 824 stops, the ordered stops of each direction with their distance
  along the route, and the service windows. It has **no line geometry**.
- `source/derived/shapes.json` — route shapes made by `tools/route_shapes.py`
  (see below). Without it the build falls back to straight lines between stops.

`source/` also holds the city's PDFs (network maps, information sheet, Phase 1 engagement
summary), kept because the consultation closes on 27 November and the pages may change.

Source page: https://haveyoursay.guelph.ca/en/projects/transitupdate-2026 ·
Remix map: https://platform.remix.com/project/6a3a211f

Route classes come from the route number (80s and 90s high-frequency, 50s university,
the rest base), which gives the 10 / 17 / 6 split the city describes when 12A and 12B
count as one route.

## Route shapes

Remix does not publish line geometry, so `tools/route_shapes.py` routes each of the 68
directions through its stops on OpenStreetMap roads (the public OSRM server, kerb-side
approaches; Valhalla's bus profile for legs a car cannot drive, such as the Guelph Central
Station and University Centre platforms) and checks every leg against the distance Remix
gives between the two stops. Raw responses are cached under `source/`, so a rerun makes
no requests.

Result: 1,196 legs, of which 10 fell back to a straight segment and 28 keep a routed line
that is outside tolerance (the larger of 60 m and 25%). Every stop is within 40 m of its
line. The full list is in `source/derived/shapes_report.txt`.

Known weak spots:

- **Downtown around Wyndham Street and Guelph Central Station**: six of the ten straight
  segments are here; every router detours.
- **Woodlawn Smart Centres and Stone Road Mall**: Remix's first legs are about twice the
  routed length, so its shape probably loops through the plaza and ours does not.
- **Six directions are more than 8% off Remix's total length**: 13 eastbound (-19%),
  80 inbound (-19%), 12A northbound (-13%), 9 northbound (+11%), 92A southbound (-11%),
  3 southbound (-10%). In each, one or two Remix distances are far longer than any route
  between the stops, which the routed line cannot reproduce.
- **Stop order was repaired in 11 directions** (30 stops, most on routes 9 and 11). There
  Remix's distances for recently added stops are on a different scale from the older
  ones, so sorting by distance interleaves them wrongly. The builder keeps the longest
  consistent chain of stops, routes through those, and places the rest by position along
  the line. Route 9 northbound still doubles back once near Waterloo at Glasgow.

Buses are placed by Remix distance mapped onto the line through the stops, so a shape
that is a little long or short still has the bus at each stop at the right time.

## Checks

Run in the browser console (`window.sim` exposes the simulation):

- At 10:00 on a weekday every route has within one bus of
  `round-trip time ÷ headway` buses out.
- Weekday 34 routes run; Saturday and Sunday 27, the missing seven being 50–55 and 92A.
- Peak buses out: 85 weekday, 67 Saturday, 67 Sunday. Nothing is out at 4:50 am.
- The routed lines were drawn to an image and compared by eye with the city's
  high-frequency PDF map.

## Before publishing

- **`source/` is in the first two commits and must come out of history before the first
  push.** It is untracked and git-ignored now, but the raw PDFs and Remix JSON are still
  in the history. The public repository is meant to carry derived data only.
- The repository is meant to live in the `guelph-maps` GitHub organization. No remote
  exists yet; `/gh-init` creates one.

## Not done

- Proposed vs current network (needs Guelph Transit's existing GTFS).
- Overlapping routes are drawn on top of each other, not side by side.
- The 92 and 92A are simulated separately, so their buses are not evenly interleaved
  on the shared part of Gordon Street.
