# Extreme Weather Visualizations

Interactive maps and explorers for extreme weather, by
[Dan Chavas](https://web.ics.purdue.edu/~dchavas/) (Purdue University, EAPS).

**Live:** https://web.ics.purdue.edu/~dchavas/extremewx.html

## Contents

- `extremewx.html` — landing page linking to all tools
- `extremewx/tc/` — tropical cyclone tools: IBTrACS best-track viewer, trends,
  and idealized wind-field / track / ventilation / potential-intensity explorers
- `extremewx/scs/` — severe convective storm tools: idealized environmental
  sounding and U.S. hazard trends
- `extremewx/sounding/` — general skew-T log-p sounding plotter

Most tools run entirely client-side in the browser.

## Data

The raw IBTrACS CSV files are not tracked here — they exceed GitHub's 100 MB
per-file limit. The site serves the small pre-generated `data/*.json.gz` files;
the raw data can be regenerated with the build scripts in each folder
(e.g. `process_storms.py`, `update_data.sh`).

## Credits

Potential-intensity explorer co-developed with Jonathan Lin (MIT).
Data from NOAA IBTrACS and NOAA/NCEI Storm Events. Published models are cited
on each tool's page and in its `README.md`.
