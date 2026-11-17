# guelph-transit-animation

An animated visualisation of the transit network Guelph Transit is proposing in its
Future Ready Action Plan Update (public consultation 9–27 November 2026).

**Status: empty, nothing built yet.** Only this README and the fetched source data exist.

## Goal

The city published the proposed network as static PDF maps and an interactive Remix map.
Neither shows what the service would feel like: how often a bus comes, where the frequent
corridors are, how the network breathes over a day. The idea is to animate the proposed
system — buses moving along the 34 proposed routes at the proposed frequencies — so a
resident can see it rather than read a legend.

This is meant to live in the `guelph-maps` GitHub organization. No remote exists yet;
`/gh-init` from inside this folder creates one when it is time.

## What is in `source/`

Fetched 2026-11-17 from public, no-login endpoints. Kept here because the consultation
closes 27 November and the map may be taken down or changed afterwards.

- `source/remix/maps_85f5b7bf.json` — the data behind the public Remix map
  (`https://platform.remix.com/api/maps/85f5b7bf`). Checked contents:
  - 34 lines (`lines[]`), including 12A/12B and a `92A Gordon (short turn to GCS)`;
    each has patterns with two directions.
  - 824 stops (`stops[]`) with point coordinates, names and GTFS stop codes.
  - Per direction, an ordered `directionStops[]` with `placeId` and `distanceFromStart`
    in metres (1,329 entries in total).
  - Per line, `windows[]`: `start`/`end` in minutes after midnight, `headwaySeconds`,
    average `speed`, tied through `dayTypeId` to weekday / Saturday / Sunday
    (`dayTypes[].days` is a Mon–Sun bitmask such as `1111100`). Some lines have several
    windows per day, e.g. 92 runs every 10 minutes until 22:00, then every 15.
- `source/remix/projects_6a3a211f.json` — project metadata and the public description text.
- `source/pdfs/Proposed Network Maps.pdf` — four vector-looking maps: all routes,
  high-frequency, base, university. Lines and street names only; no stops or frequencies.
- `source/pdfs/Information Sheet - FRAP Proposed Updates.pdf` — current vs proposed
  service in prose: Sunday/Civic Holiday/Boxing Day 7:15 a.m.–10:15 p.m., statutory
  holidays hourly 9:15 a.m.–6:45 p.m., First-Last Mile on-demand, Mobility changes.
- `source/pdfs/Phase 1 Engagement Summary - Transit FRAP Update.pdf` — downloaded, not read.

Source page: https://haveyoursay.guelph.ca/en/projects/transitupdate-2026
(a JavaScript app; the PDFs are attached to phases and listed by
`/web_api/v1/phases/<phase id>/files`).
Remix map: https://platform.remix.com/project/6a3a211f

## Known gaps in the data

- **No route shapes.** The Remix JSON has no line geometry, only ordered stops. Shapes
  have to come from somewhere: routing between consecutive stops on OpenStreetMap roads,
  the vector paths in the PDF map, or Remix's map tiles. None of these was tried.
- **No timetables.** Only headways and average speeds, so bus positions are simulated,
  not scheduled. The city says stop locations and schedules are tentative.
- **No statutory-holiday service** in the feed; only the info sheet's "hourly" line.
- **No current network.** A before/after comparison needs Guelph Transit's existing GTFS.

## Open questions

Deliberately not decided yet:

- **Form of the artifact.** Interactive web map with a time slider, a rendered video, or
  both? Who is it for — residents answering the survey before 27 November, or a longer-
  lived explainer?
- **What it shows.** Individual buses moving, frequency as line weight, a day cycle,
  weekday vs Sunday, proposed vs current — which of these is the point?
- **How to get shapes** (see gaps above), and how accurate they must be.
- **Whether the city's files can be redistributed** in a public repo. The PDFs and the
  Remix JSON are public but carry no stated licence. Decide before pushing `source/`.
- **How to tell it worked.** For example: bus counts per route matching
  round-trip time ÷ headway, routes matching the PDF map by eye.

## Leads — unverified, evaluate before using

- `~/Code/guelph-bus-stops-layer` — sibling project found by name only; may already hold
  current Guelph stop data. Not opened.
- `~/Code/guelph-maps-github` — found by name only; probably about the organization
  itself. Not opened.
- Remix exposes a `tileServerEndpoint` in its page config; it may serve the route
  geometry the JSON lacks. Not explored.
