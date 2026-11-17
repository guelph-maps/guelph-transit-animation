# guelph-transit-animation

An animated map of the transit network Guelph Transit is proposing in its Future Ready
Action Plan Update (public consultation 9–27 November 2026).

The city published the proposed network as static PDF maps and an interactive Remix map.
Neither shows what the service would feel like: how often a bus comes, where the frequent
corridors are, how the network breathes over a day. This page puts simulated buses on the
34 proposed routes at the proposed frequencies, so a resident can see it rather than read
a legend.

Not an official City of Guelph product.

Live: https://guelph-maps.github.io/guelph-transit-animation/

Bicycle parking comes from a sibling project, the
**[Guelph Bike Parking Map](https://guelph.bike/)**
([guelph-maps/guelph-bike-parking](https://github.com/guelph-maps/guelph-bike-parking)):
every rack in the city, by type and number of spaces.

## What it does

- Buses move along all 34 proposed routes over a service day, 5 am to 2 am.
- Weekday / Saturday / Sunday toggle. The six university routes (50–55) and the 92A
  short turn run on weekdays only.
- Play / pause, three speeds (1, 2 or 5 minutes a second; 2 to begin with), and a time
  slider.
- Each route line has the colour the city gives it on its own maps; university routes
  are dashed, as there. Thickness follows how often a bus comes at the time shown.
  Routes not running are faint.
- The legend names each family of routes by its number, shaped as a route badge: 8X
  and 9X for the high-frequency 80s and 90s, 5X for the university 50s. Each badge is
  the average of its routes' colours, mixed in linear light.
- Hovering a line lists the routes there and their current frequency.
- A rider stands on the map. Drag the figure to a start, click anywhere, and they travel
  there by bus from the time shown: walking to a stop, waiting, riding the simulated bus,
  changing buses as often as it takes. A floating panel shows the trip: when they leave and
  arrive, which buses they take, and each step with its times: every walk, every wait
  of half a minute or more, and every ride is a step of its own.
- **The rider's bus is marked** from the click until they get off it: a larger dot,
  cased in ink as their ride's line is, with its route number at every zoom. One bus
  at a time: after a change the mark moves to the next. While they are on their way to
  it the stop they board at is ringed, and the status counts down ("Waiting for
  the 8 · 4 min"). A bus that has not left its terminus yet waits there as a white ring; one
  still on its outbound run or layover is marked where it is. The other buses are
  left as they are.
- Under each door-to-door speed is the speed **now**: 4.8 km/h walking, nothing while
  waiting, the bus's average for that hour while riding (stops included, so it does
  not drop at a stop), 15 km/h on the bicycle.
- The panel is headed by the two totals, the rider's and the bicycle's, in the largest
  type there: how long each took is what is being compared. Under each is its
  door-to-door speed (see below). The totals are repeated in bold where each timeline
  ends: on the Arrive row, and at the foot of the bicycle's line.
- A shadow bicycle sets out with the rider, from the same place to the same place at the
  same moment. In the trip panel its line runs down beside the rider's steps, on their
  clock: the steps are rows, not a scale, so each row's time is a mark and the bicycle
  ends between the two rows it arrives between.
- Whichever of the two is there first gets the fastest commuter's medal as it arrives,
  in the panel and on the map. If the two are there within a minute of each other
  nobody gets it: once both are there they shake hands (🤝), and friendship won. The
  handshake is on neither of them but between the two: on the map they step apart
  with it in the middle, in the panel it sits under both timelines, and on a phone
  between the two lanes where they end.
- **Park the bicycle at a rack** (a switch, on to begin with) makes the bicycle's trip
  an honest one: its rider walks to the rack nearest the start, rides to the rack
  nearest where they are going, and walks from there. The racks show on the map as
  green dots, the two in use ringed, and the shadow is a walking figure while it walks.
  The switch sits in one card with the logo and name of the
  [Guelph Bike Parking Map](https://guelph.bike/), where the racks come from; the logo
  and name are the link.

## Run it

It is a static site: `index.html`, `app.js`, `style.css`, `data/network.json`,
`data/streets.json` and `data/parking.json`.
Serve the folder with anything, for example:

```
python -m http.server 8765
```

and open http://localhost:8765. MapLibre GL JS is loaded from unpkg and the basemap from
OpenFreeMap (no key).

Visits to the live site are counted with [GoatCounter](https://www.goatcounter.com/)
(no cookies), in the counter the Guelph Bike Parking Map uses, under the path
`/guelph-transit-animation/`. Nothing is counted on localhost or inside a frame.

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

## The rider

The rider takes the same made-up timetable the bus dots follow, so during a ride the
figure is on an actual simulated bus. The plan is the earliest arrival for leaving at the
time shown (a RAPTOR search, up to five boardings), under these assumptions:

- **Walking follows the streets** of `data/streets.json` at 4.8 km/h: the shortest way
  along streets, paths and steps, plus the straight bit from the door to the nearest
  street. Separately mapped sidewalks and crossings are left out, so the rider walks the
  street itself and crosses wherever they like. All distances below are metres walked.
  Until the streets have loaded (about 310 KB compressed, fetched after the first
  frame) walks are straight lines multiplied by 1.3.
- **The rider walks to the nearest stop** (or one within 130 m of it, the stop across
  the street). They start at one up to 500 m farther, the other route round the corner,
  only if that gets them there at least a minute sooner: not to board the bus they
  would have changed to anyway. From the bus to where they are going they walk from the
  nearest stop or one up to 500 m farther. Between buses they walk up to 500 m.
  Everything else is done by bus, with as many changes as it takes.
- **A change needs 60 s** at the stop, and a boarding has to save 3 minutes to be worth
  making.
- **Walking the whole way** happens when no bus gets there at that hour, when it takes
  15 minutes or less and is no slower, or when the buses would take over one and a
  half times as long.
- **The terminus splits a ride in two.** A bus's outbound and return runs are separate
  trips to the planner; a rider who stays with the bus through its layover is shown as
  staying on the same bus.
- The plan is made once, for the day type and time of the click. Changing the day or
  dragging the figure drops it; a trip still under way when the clock wraps at 2 am ends
  at its destination.

## The shadow bicycle

For comparison only. It leaves when the rider does and takes the shortest way along the
same street network at a flat 15 km/h, lights and stops included. "The same route" is
read as the same start, end and leaving time, not the bus's path. It rides anything the
rider can walk, steps and footpaths included, and knows nothing of hills, one-way
streets or bike lanes.

**Door-to-door speed**, shown under each total, is the shortest way along the streets
from start to end divided by the whole time taken, waits, walks and detours included.
Both are measured over those same metres, not over the way each actually went, so the
higher speed always belongs to whoever is there first: a bus that goes the long way
round is not credited for the extra distance. A bicycle ridden door to door shows its
15 km/h; one parked at racks shows less.

With **Park the bicycle at a rack** switched on, the bicycle is only ridden between two
racks:

- The shadow walks, at the rider's 4.8 km/h, to the rack nearest the start by the
  streets, rides to the rack nearest the end, and walks from there. "Nearest" is taken
  at its word: the nearest rack may be the wrong way, and no pair of racks is searched
  for a quicker trip.
- If both ends have the same nearest rack, or walking, riding and walking would be no
  quicker than walking the whole way, the shadow walks the whole way.
- Locking and unlocking take no time, and a rack is never full.
- Throwing the switch during a trip plans the shadow again from the same start, end and
  leaving time; the rider's trip is left alone.
- Until the streets have loaded, the walks and the ride are straight lines.

## Bicycle parking

`data/parking.json` holds one position for each of 512 racks. `tools/build_parking.py`
copies them from `../guelph-bike-parking/data/bike-parking.geojson`, the data behind the
[Guelph Bike Parking Map](https://guelph.bike/) (OpenStreetMap as of 2026-11-16), which
must be cloned beside this project to run it. Private parking (`access=private`, 2 racks)
is left out, as it is on that map. A rack farther than 150 m from any street of
`data/streets.json` would be dropped when the page loads; none is (the farthest is
127 m).

## Data

`data/network.json` holds the routes. `tools/build_data.py` builds it from
four local inputs that are not in this repository (the raw city files stay local;
only derived data is published):

- `source/remix/maps_85f5b7bf.json` — the data behind the public Remix map
  (`https://platform.remix.com/api/maps/85f5b7bf`, fetched 2026-11-17, no login).
  It has the 34 lines, 824 stops, the ordered stops of each direction with their distance
  along the route, and the service windows. It has no line geometry.
- `source/remix/directions_detail_85f5b7bf.json` — the line of each of the 68 directions,
  which the map loads with a second request (`POST .../api/maps/85f5b7bf/directions/detail`,
  fetched 2026-11-17, no login).
- `source/remix/projects_6a3a211f.json` — the Remix project behind the same map. Its line settings hold the colour
  and dash of each of the 34 lines, which is where the colours here come from. They
  match the legend of the city's "Proposed Network: All Routes" PDF. Pairs that are one
  service share a colour: 80/81, 82/83, 51/52, 12A/12B.
- `source/derived/shapes.json` — those lines decoded, with the stops placed on them, by
  `tools/remix_shapes.py` (see below). Without it the build falls back to straight lines
  between stops.

`source/` also holds the city's PDFs (network maps, information sheet, Phase 1 engagement
summary), kept because the consultation closes on 27 November and the pages may change.

Source page: https://haveyoursay.guelph.ca/en/projects/transitupdate-2026 ·
Remix map: https://platform.remix.com/project/6a3a211f

Route classes come from the route number (80s and 90s high-frequency, 50s university,
the rest base), which gives the 10 / 17 / 6 split the city describes when 12A and 12B
count as one route.

## Streets

`data/streets.json` is the network the rider walks and the bicycle rides.
`tools/build_streets.py` builds it from every OpenStreetMap `highway` way within 1.5 km
of the stops (Overpass API, fetched 2026-11-17, kept in `source/osm/`):

- Kept: streets, service roads, paths, footways, cycleways, steps, tracks, and Wyndham
  and Quebec streets, which are being rebuilt as this is written.
- Dropped: the Hanlon Expressway and its ramps, anything marked private or closed to
  people on foot, driveways, parking aisles and drive-throughs.
- **Sidewalks and crossings mapped as their own lines are dropped** (7,416 ways); the
  street they run along stands in. A path that ended at a sidewalk is joined to the
  nearest street within 30 m instead (3,166 joins), or it would lead nowhere.
- Bends are straightened to within 4 m and the 593 pieces not connected to the main
  network are removed.

Result: 32,439 nodes, 37,703 segments, 1,557 km, 763 KB. Every stop is within 30 m of
it. Between stops 150–400 m apart in a straight line, the walk is 1.23 times the
straight line at the median and 1.62 at the 90th percentile; the worst are 3 to
4.5 times, which were not looked at one by one.

## Route shapes

Every line is the one the city drew on its Remix map. `tools/remix_shapes.py` asks Remix
for the 68 directions the way the map itself does and decodes them (TWKB, a compact
binary form of a line); the answer is kept under `source/`, so a rerun makes no request.
Until 17 November the lines here were routed between the stops on OpenStreetMap roads
instead, and about 16 km of them, in 40 of the 68 directions, ran more than 40 m from
the city's line. The built lines are now the same as the map's to the metre.

- **Stops are placed by where they sit on the line**, not by the distance Remix gives
  them. In 17 directions that distance belongs to an earlier version of the line and is
  off from some stop onward, by up to 3.5 km (the list is in
  `source/derived/shapes_report.txt`). Travel order follows the line too, which changes
  it in 8 directions.
- **Where a line passes a stop twice** (a street driven out and back, a loop; 40 stops),
  the pass nearest the stop is taken, then the one with the stop on its right. Two stops
  were left to Remix's distance. On 16 inbound this puts "Southgate at Clair
  southbound" on the way out and "950 Southgate northbound" on the way back, which is the
  other way round from Remix's distances.
- **A bus runs the whole line**, including what lies before the first stop and after the
  last: 524 m past Kortright at Rickson on 53 outbound, 756 m past Woodlawn at Woolwich
  on 93 northbound, 393 m before Macdonell at Wilson on 10 westbound.
- **18 stretches of 100 m or more are one straight segment** (the longest 1.5 km, on
  82 inbound). Measured against `data/streets.json`, 16 of them lie on a street to
  within 4 m: Guelph's long streets are straight. Two leave the streets, and are drawn
  as the city has them: 460 m near the end of 91 southbound (up to 127 m from any
  street) and 434 m on 82 inbound (up to 35 m).
- One stop is more than 40 m from its line: Edinburgh at Ironwood southbound on 52
  inbound, 48 m.
- Where a bus turns around, the two directions of every route meet (within 60 m), so
  no bus jumps. Before, four routes had gaps of 270–490 m there.

The streets and the bicycle parking are derived from OpenStreetMap, © OpenStreetMap
contributors, ODbL.

## Checks

Run in the browser console (`window.sim` exposes the simulation):

- At 10:00 on a weekday every route has within one bus of
  `round-trip time ÷ headway` buses out.
- Weekday 34 routes run; Saturday and Sunday 27, the missing seven being 50–55 and 92A.
- Peak buses out: 84 weekday, 68 Saturday, 67 Sunday. Nothing is out at 4:50 am.
- Every built line was measured against the line Remix sends: nowhere more than 5 m
  apart. Route 82 through the Arboretum was looked at beside the Remix map.
- After the lines changed, 300 random trips over the three day types: in every ride leg
  the figure is within a millimetre of a simulated bus of that route and direction, and
  the rider is at every stop before their bus. The figures below are from the 600 trips
  on the routed lines and were not rerun.
- 600 random trips over the three day types, walking on the streets: in every ride leg
  the figure is within a millimetre of a simulated bus of that route and direction, the
  rider is at every stop before their bus, every walk's line is as long as its time
  says, and no weekday-only route is used on a weekend. At 3 am the plan is a walk.
- In 42 of those 600 the buses are slower than walking the whole way would be (by 3
  minutes at the median, 14 at most). That is the rule above: a walk of over 15 minutes
  is only chosen when the buses would take one and a half times as long.
- The bicycle is there first in 583 of the 600.
- The same 600 trips on the version before the streets (straight lines times 1.3)
  gave 33 such trips, so the streets did not bring them in.
- The page loads without console errors and all layers draw; a trip was watched with
  its walks on the streets and the bicycle beside it, on a desktop and a phone-sized
  window.
- The medal and the bicycle's line were looked at on one trip the bus wins (the bicycle
  ends just below the Arrive row) and one the bicycle wins (it ends between the rows
  stamped 10:00 and 10:13, at 10:10). The medal goes when the clock is dragged back
  before the arrival and when the day changes. A walk of 300 m was looked at too. A
  bicycle far behind the bus was not.

- Parking, on 300 random trips over the three day types: with the switch off every
  bicycle is one ride at 15 km/h, as before. With it on, 292 walk, ride and walk, and 8
  walk the whole way; the legs join end to start and to the two doors, every leg's line
  is as long as its time says, and the shadow never jumps. Parking adds 10 minutes to
  the bicycle's trip at the median (1 at the least, 34 at the most), and the bicycle
  is there first in 210 of the 300, against 288 with the switch off.
- Looked at with the switch on: a trip across the city on a desktop and a phone-sized
  window, the switch thrown off and on again during it, a trip of 140 m with one rack
  nearest both ends (the shadow walks), and one of 430 m where the nearest rack is the
  wrong way.

- The trip panel's head and the rack card were looked at on a desktop and a phone-sized
  window: a one-bus trip with parking off and on (23 min at 7.4 km/h against 12 min at
  15 km/h, then 13 min at 13 km/h), and a 120 m trip both walk (4.8 km/h each, the
  shadow on foot). The switch while still disabled and a trip the bus wins were not.

- The phone's sheet (one sheet under the map, the race as two lanes on it) was looked at
  in windows of 360×640, 375×667, 812×375 and 768×1024, and the desktop at 1024×768 for being
  unchanged: no trip, a trip the bicycle wins with parking on and off, one the bus wins
  (26 min against 27), the steps open, and the legend and notes open during a trip. The
  map keeps 63% of the height during a race at 375×667. All of it with the clock set by
  hand and a mouse: a race playing by itself, a finger's tap and a finger dragging the
  figure were not tried, and neither was a real phone or tablet.

- The marked bus, on 300 random trips over the three day types (535 rides, 12 moments
  each from half an hour before setting out until the rider gets off): whenever it is
  out it is within a millimetre of a simulated bus of its route (3,500 moments on the
  rider's direction, 816 on the outbound run before it, 343 laying over), and 1,761
  times it was still waiting at its terminus.
- Looked at, the clock set by hand: a weekday trip with a change (the 8, then the 6),
  with the white ring at the terminus before the 8 leaves, the marked 6 laying over
  while the rider walks to it, the mark gone after the last ride, and the speeds going
  4.8, 0, 22, 4.8 km/h, on a desktop and at 360×640; a rider staying on the 14 through
  its terminus ("On the 14" throughout, no stop ringed); and the longest status
  ("Waiting for the 12B · 12 min") fitting at 360 px. With the two speeds the map keeps
  59% of the height during a race at 375×667, not the 63% above. A race playing by
  itself and the marked bus at the lowest zooms were not looked at.

- The tie: of 300 random weekday trips between stops, parking on, 38 end within a
  minute of each other. One (63 min against 62, 15 s apart) was looked at on a desktop
  and at 375×667: no handshake between the two arrivals, the handshake once both are
  there, gone again when the clock is dragged back, and no medal anywhere. The one
  handshake was seen between the two figures on the map (the shadow on foot), under
  both timelines, and between the lanes; not with the shadow on its bicycle.

## Not done

- A sensible choice of rack: the shadow takes the nearest one at each end, however far
  out of its way.

- Proposed vs current network (needs Guelph Transit's existing GTFS).
- Overlapping routes are drawn on top of each other, not side by side.
- The 92 and 92A are simulated separately, so their buses are not evenly interleaved
  on the shared part of Gordon Street.
