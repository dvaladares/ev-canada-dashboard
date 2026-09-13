# EV Canada Dashboard

<img src="./docs/flag-canada.svg" width="28" alt="Flag of Canada" /> Made in Canada. Public data only. Not advice.

An independent, self-updating dashboard of zero-emission vehicle (ZEV) registrations in
Canada: headline totals, market share, powertrain mix, a quarterly and monthly trend, the
provincial split, a vehicle-type split, and a by-brand view. Every figure names its
source. Everything comes from public data.

Live site: https://ev-canada-dashboard.vercel.app (the About tab is at /#about)

![dashboard](docs/preview.png)

## What it shows

| Panel | What it answers | Source |
|---|---|---|
| Headline cards | How many ZEVs were registered last quarter, their share of all new vehicles, the BEV vs PHEV split, and year-over-year change | Statistics Canada 20-10-0025-01 |
| Trend (quarterly or monthly) | Where the market is going | Statistics Canada 20-10-0025-01 (quarterly registrations) and 20-10-0085-01 (monthly sales) |
| Powertrain mix | Gasoline, hybrid, BEV, PHEV, diesel shares of new registrations | Statistics Canada 20-10-0025-01 |
| By province | Which provinces lead, in units and in share | Statistics Canada 20-10-0025-01 |
| By vehicle type | Passenger cars, pickup trucks, multi-purpose vehicles (SUVs and crossovers), vans | Statistics Canada 20-10-0025-01 |
| By brand | Incentivized EV claims by make, A to Z by default, every brand shown (historical) | Transport Canada iZEV program, Open Government Licence |

"ZEV" means battery-electric (BEV) plus plug-in hybrid (PHEV). Conventional hybrids are
counted separately.

## Scope and limits, stated plainly

- Light vehicles only. The Statistics Canada registration table covers passenger cars,
  pickup trucks, multi-purpose vehicles and vans. Medium and heavy trucks and buses are not
  in it, so they are not on this page.
- No free brand feed exists in Canada. The by-brand chart uses Transport Canada iZEV claims:
  incentivized, price-capped vehicles only, and the program ended March 31, 2025. It
  understates premium brands and is a historical picture. Current brand-level data (S&P
  Global Mobility, DesRosiers) is licensed and is not shown here.
- Two Statistics Canada series feed the trend. Quarterly registrations and monthly sales are
  different series and will not tie out exactly.
- Statistics Canada revises data and releases on an irregular cadence. The page shows what
  is published on the day it refreshes.

## Independence and disclaimer

This is a personal project. It is not affiliated with, sponsored by, or endorsed by any
employer, past or present, or by any data provider. It uses public data only. It is for
general information and is not financial, investment, or purchasing advice. Figures are
reproduced as published; read the note on each panel before you quote a number. Found an
error? Open an issue.

## How it updates itself

A GitHub Actions workflow (`.github/workflows/refresh.yml`) runs `fetch_data.py` on the 15th of
each month at 13:30 UTC (09:30 Eastern). Statistics Canada publishes monthly sales around
mid-month and quarterly registrations about ten weeks after quarter end, so one monthly run
catches both. You can also trigger it by hand from the Actions tab. If the
figures changed, it commits `site/data/ev_sales.json` and the snapshot embedded in
`site/index.html` and pushes to `main`. Vercel deploys on push. If only the timestamp
changed, nothing is committed.

```
Statistics Canada WDS API  --+
Transport Canada iZEV CSV  --+--> fetch_data.py --> site/data/ev_sales.json
                                                --> snapshot embedded in site/index.html
                                                      |
GitHub Actions (monthly) --> commit if changed --> push --> Vercel deploy
```

An open browser tab re-checks `data/ev_sales.json` every 60 minutes and re-renders if the
data changed.

## Run it locally

Python 3.9 or newer, standard library only. No pip installs.

```sh
git clone https://github.com/dvaladares/ev-canada-dashboard.git
cd ev-canada-dashboard
python3 fetch_data.py            # pulls the data, writes site/data/ev_sales.json
cd site && python3 -m http.server 8787
```

Open http://127.0.0.1:8787/. Add `--force-izev` to re-download the iZEV brand file (it is
cached for a week in `data/raw/`).

Optional macOS local mode: `scripts/install.sh` sets up two user-level launchd agents
(daily refresh at 09:00 and a loopback web server on port 8787). `scripts/uninstall.sh`
removes them. `scripts/run_update.sh` refreshes by hand.

## Project layout

```
fetch_data.py                  the pipeline (Python stdlib only)
site/index.html                the page (embeds a data snapshot, regenerated each run)
site/app.js                    dependency-free renderer, SVG charts, 60-minute polling
site/styles.css                light and dark, responsive
site/data/ev_sales.json        generated: the live data the page reads
scripts/data_changed.py        exit 0 when the figures changed vs HEAD (used by CI)
scripts/run_update.sh          local refresh, optional manual publish
scripts/install.sh, uninstall.sh, serve.sh   optional macOS launchd mode
.github/workflows/refresh.yml  the monthly self-update
data/, logs/                   runtime cache and logs (gitignored)
```

## Data schema (`site/data/ev_sales.json`)

`status`, `generated_at`, `subtitle`, `latest_period`, `totals` (ev_registrations_latest,
ev_share_pct_latest, bev_latest, phev_latest, yoy_growth_pct, period_label, latest_month),
`powertrain_mix[]`, `ev_trend_quarterly[]`, `ev_trend_monthly[]`, `by_province_latest[]`,
`by_vehicle_type_latest[]`, `by_brand[]`, `by_brand_meta`,
`sources[]`, `methodology[]`. The front end reads only this schema, so adding or swapping
a source touches `fetch_data.py` alone.

## Contributing

Issues and pull requests are welcome. Keep these rules: public, redistributable data only;
every figure labelled with its source; no external dependencies in the pipeline or the
page; ASCII-only source files.

## Licence

Code: MIT (see LICENSE). Data: Statistics Canada Open Licence and Transport Canada Open
Government Licence, as noted on each panel.
