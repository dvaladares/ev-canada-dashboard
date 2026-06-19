#!/usr/bin/env python3
"""
fetch_data.py — Canada EV Sales by Brand dashboard data pipeline.

Pulls from credible public sources, normalizes to the dashboard JSON schema,
writes data/ev_sales.json, injects an embedded snapshot into site/index.html,
and records meta + a run log. Python standard library only (no pip installs).

Sources
-------
1. Statistics Canada WDS, Table 20-10-0025-01 (productId 20100025):
   "New motor vehicle registrations, quarterly, by geographic level."
   Authoritative ZEV / BEV / PHEV new-registration counts, by province, quarterly.
   -> powertrain mix, quarterly trend, totals, by-province. (No brand dimension.)

2. Transport Canada iZEV Program open dataset (open.canada.ca / CKAN):
   Transaction-level incentivized-vehicle records WITH Vehicle Make/Model.
   -> the by-brand layer. CAVEAT: incentivized + price-capped vehicles only,
   program ended 2025-03-31 (historical). Stated prominently on the page.

3. S&P Global Mobility brand shares (via OEM disclosures): the most current
   credible brand signal. Surfaced as an attributed reference note (not a feed).

Run:  python3 fetch_data.py [--force-izev] [--quiet]
"""

import csv
import datetime as dt
import io
import json
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path

# ----------------------------------------------------------------------------
# Config / paths
# ----------------------------------------------------------------------------
BASE = Path(__file__).resolve().parent
SITE = BASE / "site"
SITE_DATA = SITE / "data"          # public: served to the browser
DATA = BASE / "data"               # private: cache + meta (not web-served)
RAW = DATA / "raw"
LOGS = BASE / "logs"
for d in (SITE_DATA, DATA, RAW, LOGS):
    d.mkdir(parents=True, exist_ok=True)

OUT_JSON = SITE_DATA / "ev_sales.json"
META_JSON = DATA / "meta.json"
INDEX_HTML = SITE / "index.html"
LOG_FILE = LOGS / "update.log"
IZEV_CACHE = RAW / "izev_brand.json"
IZEV_CACHE_MAX_AGE_DAYS = 7

UA = "ev-canada-dashboard/1.0 (+personal dashboard; Statistics Canada Open Licence)"
TODAY = dt.date.today().isoformat()

# StatCan WDS
WDS = "https://www150.statcan.gc.ca/t1/wds/rest"
PID_REG = 20100025   # quarterly new motor vehicle REGISTRATIONS by geography (BEV/PHEV split)
PID_SALES = 20100085  # monthly new motor vehicle SALES (zero-emission bucket; most timely)
# 20100085 dimension order: Geography.VehicleType.Fuel.Origin.Sales.SeasonalAdj
# Canada=1, VehTotal=1, Fuel: All=1/ZEV=2/Other=3, OriginTotal=1, Units=1, Unadjusted=1
MONTHLY_ZEV_COORD = "1.1.2.1.1.1.0.0.0.0"
MONTHLY_ALL_COORD = "1.1.1.1.1.1.0.0.0.0"
MONTHLY_N = 24       # months of history to plot

# Dimension order for 20100025: Geography . FuelType . VehicleType . Statistics . (zeros)
FUEL = {"zev": 1, "bev": 2, "phev": 3, "all": 4, "gas": 5, "diesel": 6, "hybrid": 7, "other": 8}
# Geography member ids (Canada + provinces/territories)
GEO = {
    "Canada": 1, "Newfoundland and Labrador": 2, "Prince Edward Island": 381,
    "Nova Scotia": 497, "New Brunswick": 600, "Quebec": 882, "Ontario": 2199,
    "Manitoba": 2821, "Saskatchewan": 3058, "Alberta": 4020, "British Columbia": 4465,
    "Yukon": 5231, "Northwest Territories": 5270, "Nunavut": 5314,
}
PROVINCES = [k for k in GEO if k != "Canada"]

# iZEV open dataset (CKAN)
IZEV_PKG = "42986a95-be23-436e-af15-7c6bf292a2e1"
CKAN = "https://open.canada.ca/data/api/3/action/package_show?id=" + IZEV_PKG

TOP_BRANDS = 12  # show top N brands, fold the rest into "Other brands"

# ----------------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------------
QUIET = "--quiet" in sys.argv
FORCE_IZEV = "--force-izev" in sys.argv


def log(msg):
    line = f"[{dt.datetime.now().isoformat(timespec='seconds')}] {msg}"
    if not QUIET:
        print(line)
    try:
        with LOG_FILE.open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


# ----------------------------------------------------------------------------
# HTTP helpers
# ----------------------------------------------------------------------------
def http_get(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def wds_post(endpoint, payload, timeout=60):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{WDS}/{endpoint}", data=data,
        headers={"User-Agent": UA, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# ----------------------------------------------------------------------------
# StatCan layer
# ----------------------------------------------------------------------------
def coord(geo_id, fuel_id):
    """Build a 10-part coordinate: Geography.Fuel.VehicleType(Total=1).Stat(1).0..."""
    return f"{geo_id}.{fuel_id}.1.1.0.0.0.0.0.0"


def quarter_label(ref_per, compact=False):
    """'2025-10-01' -> 'Q4 2025' (or compact \"Q4'25\")."""
    y, m, _ = ref_per.split("-")
    q = {"01": 1, "04": 2, "07": 3, "10": 4}.get(m, (int(m) - 1) // 3 + 1)
    return f"Q{q}'{y[2:]}" if compact else f"Q{q} {y}"


_MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def month_label(ref_per, compact=False):
    """'2026-03-01' -> 'Mar 2026' (or compact \"Mar'26\")."""
    y, m, _ = ref_per.split("-")
    nm = _MONTHS[int(m)]
    return f"{nm}'{y[2:]}" if compact else f"{nm} {y}"


def fetch_coords(requests_, latest_n, pid=PID_REG):
    """POST a batch of coordinates; return {coordinate: [(refPer, value), ...]} sorted by refPer."""
    out = {}
    # chunk to keep each POST modest
    CHUNK = 20
    for i in range(0, len(requests_), CHUNK):
        chunk = requests_[i:i + CHUNK]
        payload = [{"productId": pid, "coordinate": c, "latestN": latest_n} for c in chunk]
        resp = wds_post("getDataFromCubePidCoordAndLatestNPeriods", payload)
        for item in resp:
            if item.get("status") != "SUCCESS":
                continue
            obj = item["object"]
            c = obj["coordinate"]
            pts = []
            for p in obj.get("vectorDataPoint", []):
                v = p.get("value")
                if v is None:
                    continue
                pts.append((p["refPer"], int(round(float(v)))))  # vehicle counts are integers
            pts.sort(key=lambda t: t[0])
            out[c] = pts
    return out


def build_statcan_layer():
    """Returns dict with totals, powertrain_mix, ev_trend_quarterly, by_province_latest, latest_period."""
    log("StatCan: fetching Canada fuel series (12 quarters) + provincial latest...")

    # Canada: all 8 fuel types, last 12 quarters
    canada_coords = [coord(GEO["Canada"], fid) for fid in FUEL.values()]
    canada = fetch_coords(canada_coords, latest_n=12)

    def cseries(fuel_key):
        return canada.get(coord(GEO["Canada"], FUEL[fuel_key]), [])

    zev, bev, phev, allf = cseries("zev"), cseries("bev"), cseries("phev"), cseries("all")
    if not zev or not allf:
        raise RuntimeError("StatCan returned no ZEV/all-fuel data")

    # align by period
    allf_map = dict(allf)
    bev_map, phev_map = dict(bev), dict(phev)
    periods = [rp for rp, _ in zev]
    trend = []
    for rp in periods:
        zev_v = dict(zev)[rp]
        all_v = allf_map.get(rp)
        share = (zev_v / all_v * 100.0) if all_v else None
        trend.append({
            "period": quarter_label(rp, compact=True),
            "ref_per": rp,
            "bev": bev_map.get(rp),
            "phev": phev_map.get(rp),
            "zev_total": zev_v,
            "zev_share_pct": round(share, 1) if share is not None else None,
        })

    latest_rp = periods[-1]
    latest_zev = dict(zev)[latest_rp]
    latest_all = allf_map.get(latest_rp)
    latest_share = (latest_zev / latest_all * 100.0) if latest_all else None

    # YoY: same quarter previous year (4 quarters back) if available
    yoy = None
    if len(periods) >= 5:
        prior = dict(zev).get(periods[-5])
        if prior:
            yoy = (latest_zev - prior) / prior * 100.0

    totals = {
        "ev_registrations_latest": latest_zev,
        "ev_share_pct_latest": round(latest_share, 1) if latest_share is not None else None,
        "bev_latest": bev_map.get(latest_rp),
        "phev_latest": phev_map.get(latest_rp),
        "yoy_growth_pct": round(yoy, 1) if yoy is not None else None,
        "period_label": quarter_label(latest_rp),
    }

    # Powertrain mix for latest quarter (BEV, PHEV, Hybrid, Gasoline, Diesel, Other)
    mix_defs = [
        ("Battery electric", "bev"), ("Plug-in hybrid", "phev"), ("Hybrid electric", "hybrid"),
        ("Gasoline", "gas"), ("Diesel", "diesel"), ("Other fuel types", "other"),
    ]
    powertrain_mix = []
    for label, key in mix_defs:
        series = canada.get(coord(GEO["Canada"], FUEL[key]), [])
        val = dict(series).get(latest_rp)
        if val and val > 0:
            share = (val / latest_all * 100.0) if latest_all else None
            powertrain_mix.append({
                "fuel_type": label, "count": val,
                "share_pct": round(share, 1) if share is not None else None,
            })
    powertrain_mix.sort(key=lambda r: -r["count"])

    # By province (latest quarter): ZEV + all-fuel for share
    log("StatCan: fetching provincial ZEV for latest quarter...")
    prov_coords = []
    for prov in PROVINCES:
        prov_coords.append(coord(GEO[prov], FUEL["zev"]))
        prov_coords.append(coord(GEO[prov], FUEL["all"]))
    prov_data = fetch_coords(prov_coords, latest_n=1)
    by_province = []
    for prov in PROVINCES:
        z = dict(prov_data.get(coord(GEO[prov], FUEL["zev"]), [])).get(latest_rp)
        a = dict(prov_data.get(coord(GEO[prov], FUEL["all"]), [])).get(latest_rp)
        if z and z > 0:
            by_province.append({
                "province": prov, "zev": z,
                "share_pct": round(z / a * 100.0, 1) if a else None,
            })
    by_province.sort(key=lambda r: -r["zev"])

    log(f"StatCan: latest {totals['period_label']} ZEV={int(latest_zev):,} "
        f"share={totals['ev_share_pct_latest']}% provinces={len(by_province)}")

    return {
        "latest_period": {"label": quarter_label(latest_rp), "type": "quarter"},
        "totals": totals,
        "powertrain_mix": powertrain_mix,
        "ev_trend_quarterly": trend,
        "by_province_latest": by_province,
        "_release_time": _latest_release_time(canada),
    }


def build_monthly_layer():
    """Monthly ZEV *sales* (Table 20-10-0085) — most timely series. Returns trend + latest month."""
    log("StatCan: fetching monthly ZEV sales (20100085)...")
    data = fetch_coords([MONTHLY_ZEV_COORD, MONTHLY_ALL_COORD], latest_n=MONTHLY_N, pid=PID_SALES)
    zev = data.get(MONTHLY_ZEV_COORD, [])
    allf = dict(data.get(MONTHLY_ALL_COORD, []))
    if not zev:
        raise RuntimeError("StatCan monthly returned no ZEV data")
    trend = []
    for rp, z in zev:
        a = allf.get(rp)
        share = (z / a * 100.0) if a else None
        trend.append({
            "period": month_label(rp, compact=True),
            "ref_per": rp, "zev": z, "all": a,
            "zev_share_pct": round(share, 1) if share is not None else None,
        })
    latest_rp, latest_z = zev[-1]
    latest_a = allf.get(latest_rp)
    latest_month = {
        "label": month_label(latest_rp), "zev": latest_z,
        "share_pct": round(latest_z / latest_a * 100.0, 1) if latest_a else None,
    }
    log(f"StatCan monthly: {latest_month['label']} ZEV sales={latest_z:,} "
        f"share={latest_month['share_pct']}% ({len(trend)} months)")
    return {"ev_trend_monthly": trend, "latest_month": latest_month}


def _latest_release_time(canada):
    # best-effort: not in vectorDataPoint subset here; return None (release tracked via meta)
    return None


# ----------------------------------------------------------------------------
# iZEV brand layer (cached; refreshed weekly)
# ----------------------------------------------------------------------------
def _ckan_latest_en_csv():
    """Find the most recent fiscal-year English CSV resource URL from CKAN."""
    pkg = json.loads(http_get(CKAN, timeout=40).decode("utf-8"))
    resources = pkg["result"]["resources"]
    cands = []
    for r in resources:
        if (r.get("format") or "").upper() != "CSV":
            continue
        lang = r.get("language") or []
        url = r.get("url") or ""
        if ("en" in lang or "_en_" in url.lower()) and "izev-webstats" in url.lower():
            cands.append(url)
    if not cands:
        raise RuntimeError("No iZEV English CSV found in CKAN package")

    # pick the file whose name encodes the latest fiscal year (e.g. fy-2024-25)
    def fy_key(u):
        m = re.findall(r"fy-(\d{4})-(\d{2})", u.lower())
        return max((int(a) for a, b in m), default=0)

    cands.sort(key=fy_key, reverse=True)
    return cands[0]


def _norm_make(raw):
    s = (raw or "").strip()
    return s


def aggregate_izev():
    """Download latest FY iZEV CSV, aggregate by Vehicle Make. Returns the brand-layer dict."""
    url = _ckan_latest_en_csv()
    m = re.search(r"fy-(\d{4})-(\d{2})", url.lower())
    fy_label = f"FY{m.group(1)}-{m.group(2)}" if m else "latest FY"
    log(f"iZEV: downloading {fy_label} CSV ...")
    raw = http_get(url, timeout=180)
    log(f"iZEV: parsing {len(raw)//1024} KB ...")

    text = io.StringIO(raw.decode("utf-8-sig"))
    reader = csv.DictReader(text)
    # tolerate column-name drift by locating columns case-insensitively
    fields = reader.fieldnames or []

    def find_col(*needles):
        for f in fields:
            fl = f.lower()
            if all(n in fl for n in needles):
                return f
        return None

    col_make = find_col("vehicle", "make") or "Vehicle Make"
    col_pt = find_col("bev", "phev") or find_col("battery", "plug")  # powertrain column
    col_my = find_col("month", "year")

    counts = {}       # canonical_lower -> {"display":..., "bev":n, "phev":n, "fcev":n, "total":n}
    months = set()
    total_rows = 0
    for row in reader:
        make_raw = _norm_make(row.get(col_make))
        if not make_raw:
            continue
        total_rows += 1
        key = make_raw.lower()
        rec = counts.setdefault(key, {"display": {}, "bev": 0, "phev": 0, "fcev": 0, "total": 0})
        rec["display"][make_raw] = rec["display"].get(make_raw, 0) + 1
        rec["total"] += 1
        pt = (row.get(col_pt) or "").strip().upper() if col_pt else ""
        if pt == "BEV":
            rec["bev"] += 1
        elif pt == "PHEV":
            rec["phev"] += 1
        elif pt == "FCEV":
            rec["fcev"] += 1
        if col_my and row.get(col_my):
            months.add(row[col_my].strip())

    if not counts:
        raise RuntimeError("iZEV: parsed 0 makes")

    brands = []
    for key, rec in counts.items():
        display = max(rec["display"].items(), key=lambda kv: kv[1])[0]
        brands.append({"brand": display, "units": rec["total"],
                       "bev": rec["bev"], "phev": rec["phev"], "fcev": rec["fcev"]})
    brands.sort(key=lambda b: -b["units"])
    grand_total = sum(b["units"] for b in brands)

    # top N + fold remainder
    top = brands[:TOP_BRANDS]
    rest = brands[TOP_BRANDS:]
    rows = []
    for b in top:
        rows.append({"brand": b["brand"], "units": b["units"],
                     "share_pct": round(b["units"] / grand_total * 100.0, 1) if grand_total else None,
                     "bev": b["bev"], "phev": b["phev"]})
    if rest:
        rsum = sum(b["units"] for b in rest)
        rows.append({"brand": f"Other ({len(rest)} brands)", "units": rsum,
                     "share_pct": round(rsum / grand_total * 100.0, 1) if grand_total else None})

    period = _fy_period_phrase(fy_label)
    layer = {
        "by_brand": rows,
        "by_brand_meta": {
            "source": "Transport Canada — iZEV Program (Open Canada)",
            "source_url": "https://open.canada.ca/data/en/dataset/" + IZEV_PKG,
            "period": period,
            "metric": "BEV + PHEV incentive claims",
            "credibility_note": (
                "iZEV-incentivized vehicles only. Price caps exclude premium EVs (such as the Tesla "
                "Model S and X), and the federal program ended March 2025, so this is a historical "
                "brand picture, not a complete or current sales count. For the most current brand "
                "shares, see the S&P Global Mobility figures in the Current brand shares panel."
            ),
        },
        "_izev_total": grand_total,
        "_izev_fy": fy_label,
        "_izev_months": sorted(months),
        "_fetched": dt.datetime.now().isoformat(timespec="seconds"),
        "_source_url": url,
        "_rows_parsed": total_rows,
    }
    log(f"iZEV: {fy_label} aggregated {grand_total:,} incentivized vehicles across "
        f"{len(brands)} brands (top: {rows[0]['brand']} {rows[0]['units']:,}).")
    return layer


def _fy_period_phrase(fy_label):
    m = re.search(r"(\d{4})-(\d{2})", fy_label)
    if not m:
        return fy_label
    start = m.group(1)
    end = "20" + m.group(2)
    return f"iZEV claims, {fy_label} (Apr {start} – Mar {end})"


def get_izev_layer(prev):
    """Return iZEV brand layer, using cache unless stale/forced/failed."""
    cache_ok = IZEV_CACHE.exists()
    fresh = False
    if cache_ok and not FORCE_IZEV:
        age_days = (dt.datetime.now() - dt.datetime.fromtimestamp(IZEV_CACHE.stat().st_mtime)).days
        fresh = age_days < IZEV_CACHE_MAX_AGE_DAYS
    if fresh:
        try:
            cached = json.loads(IZEV_CACHE.read_text())
            log(f"iZEV: using cached aggregate ({cached.get('_izev_fy')}, "
                f"{cached.get('_izev_total', 0):,} vehicles).")
            return cached
        except (OSError, ValueError):
            pass
    try:
        layer = aggregate_izev()
        IZEV_CACHE.write_text(json.dumps(layer, indent=2))
        return layer
    except (urllib.error.URLError, RuntimeError, ValueError, OSError) as e:
        log(f"iZEV: fetch FAILED ({e!r}).")
        if IZEV_CACHE.exists():
            log("iZEV: falling back to last cached aggregate.")
            return json.loads(IZEV_CACHE.read_text())
        if prev and prev.get("by_brand"):
            log("iZEV: falling back to previous published brand layer.")
            return {"by_brand": prev["by_brand"], "by_brand_meta": prev.get("by_brand_meta", {})}
        return {"by_brand": [], "by_brand_meta": {}}


# ----------------------------------------------------------------------------
# Assemble + write
# ----------------------------------------------------------------------------
def load_prev():
    try:
        return json.loads(OUT_JSON.read_text())
    except (OSError, ValueError):
        return None


# Current credible brand-share reference — S&P Global Mobility registration data, as
# reported publicly via OEM disclosures / trade press. This is the authoritative *current*
# brand signal, but S&P/DesRosiers data is licensed and CANNOT be auto-scraped or
# republished wholesale (confirmed: S&P blocks crawlers; Electric Autonomy, GoodCarBadCar,
# Drive Tesla all bar automated reuse). So these few headline figures are CURATED and
# refreshed BY HAND with attribution — citing reported facts, not mirroring a dataset.
# To refresh: update `as_of`, `rows`, and `reviewed` when a newer S&P-sourced figure is
# published (e.g. the next GM Canada quarterly EV release or S&P "Canadian EV Insights").
CURRENT_BRAND_SHARES = {
    "as_of": "FY2025 + Q1 2026",
    "reviewed": "2026-06-19",
    "metric": "Share of new EV registrations, Canada",
    "source": "S&P Global Mobility",
    "via": "GM Canada release; Motor Illustrated / Drive Tesla Canada",
    "source_url": "https://www.spglobal.com/mobility/en/info/0521/automotive-insights-canada-evs.html",
    # Q1 2026 brand ranking (S&P Global Mobility, as reported publicly). Brand-level shares
    # are comparable; "GM (all brands)" and "Cadillac (luxury)" use different denominators —
    # see each note. Do NOT attribute these to Electric Autonomy (they publish aggregate only).
    "rows": [
        {"period": "Q1 2026", "label": "Chevrolet", "value": "9.7%", "note": "of the EV market"},
        {"period": "Q1 2026", "label": "Kia", "value": "9.5%", "note": "of the EV market"},
        {"period": "Q1 2026", "label": "Toyota", "value": "9.3%", "note": "of the EV market"},
        {"period": "Q1 2026", "label": "Hyundai", "value": "8.7%", "note": "of the EV market"},
        {"period": "Q1 2026", "label": "Tesla", "value": "7.8%", "note": "fallen from ~47% three years ago"},
        {"period": "Q1 2026", "label": "GM (all brands)", "value": "~20%", "note": "#1 overall (Chevy, Cadillac, GMC); outsold Tesla; EV sales +13.1% YoY"},
        {"period": "Q1 2026", "label": "Cadillac", "value": "50.6%", "note": "of the luxury-EV segment"},
    ],
    "context": "Full-year 2025: GM #1 at 21.2% (~25,000 EVs), Chevrolet 13.3% (Equinox EV the #2-registered EV); Tesla ~19,829 units, down ~63% YoY.",
    "note": ("Most recent published brand figures, cited with attribution and refreshed by hand. "
             "Canada has no free, redistributable brand-level data feed: S&P Global Mobility and "
             "DesRosiers registration data is licensed and may not be auto-scraped or republished, "
             "so these headline figures are quoted (like a reported statistic), not mirrored from a dataset."),
}


def assemble(statcan, monthly, izev, prev):
    generated = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    totals = dict(statcan.get("totals", {}))
    if monthly.get("latest_month"):
        totals["latest_month"] = monthly["latest_month"]
    data = {
        "status": "ok",
        "generated_at": generated,
        "subtitle": ("Zero-emission vehicle registrations across Canada, refreshed automatically "
                     "from Statistics Canada, with brand detail from Transport Canada's iZEV dataset."),
        "latest_period": statcan.get("latest_period", {"label": "—"}),
        "totals": totals,
        "powertrain_mix": statcan.get("powertrain_mix", []),
        "ev_trend_quarterly": statcan.get("ev_trend_quarterly", []),
        "ev_trend_monthly": monthly.get("ev_trend_monthly", []),
        "by_province_latest": statcan.get("by_province_latest", []),
        "by_brand": izev.get("by_brand", []),
        "by_brand_meta": izev.get("by_brand_meta", {}),
        "current_brand_shares": CURRENT_BRAND_SHARES,
        "sources": [
            {
                "name": "Statistics Canada, Table 20-10-0025-01",
                "detail": "Quarterly ZEV, BEV and PHEV registrations by province. Powers the totals, "
                          "market share, powertrain mix, trend, and provincial breakdown.",
                "url": "https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=2010002501",
                "accessed": TODAY,
            },
            {
                "name": "Statistics Canada, Table 20-10-0085-01",
                "detail": "Monthly new-vehicle sales (zero-emission bucket). Powers the monthly trend "
                          "view, the most timely series, through the latest reported month.",
                "url": "https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=2010008501",
                "accessed": TODAY,
            },
            {
                "name": "Transport Canada, iZEV Program (Open Canada)",
                "detail": f"Incentivized BEV and PHEV claims by make ({izev.get('_izev_fy', '')}). "
                          f"Powers the by-brand chart. Incentivized and price-capped only; the program "
                          f"ended March 2025.",
                "url": "https://open.canada.ca/data/en/dataset/" + IZEV_PKG,
                "accessed": TODAY,
            },
            {
                "name": "S&P Global Mobility (via GM Canada and trade press)",
                "detail": "Current brand shares (the 'Current brand shares' panel), cited with "
                          "attribution and refreshed by hand. S&P data is licensed, so it is not "
                          "scraped or republished as a dataset.",
                "url": "https://www.spglobal.com/mobility/en/info/0521/automotive-insights-canada-evs.html",
                "accessed": TODAY,
            },
        ],
        "methodology": [
            "\"ZEV\" means battery-electric (BEV) plus plug-in hybrid (PHEV). Conventional hybrids "
            "are counted separately.",
            "Headline figures (registrations, market share, powertrain mix, the trend, and the "
            "provincial split) come from Statistics Canada new motor vehicle registrations, the "
            "standard proxy for new sales.",
            "The trend chart toggles between quarterly registrations (Table 20-10-0025) and monthly "
            "sales (Table 20-10-0085). These are two different Statistics Canada series, so the "
            "monthly and quarterly numbers will not match exactly.",
            "The by-brand chart uses Transport Canada's iZEV data, the only free Canadian source with "
            "a vehicle-make breakdown. It covers incentivized, price-capped vehicles only, and the "
            "program ended March 2025, so it understates premium brands and is a historical snapshot.",
            "Current brand shares come from S&P Global Mobility (reported via GM Canada and trade "
            "press), cited with attribution and refreshed by hand. Complete, current brand-level data "
            "in Canada sits behind paid S&P or DesRosiers licences that do not allow republishing.",
            "Every figure on this page is labelled with its source.",
        ],
        "notes": [],
        "build": {
            "statcan_ok": bool(statcan.get("totals")),
            "izev_fy": izev.get("_izev_fy"),
            "izev_total": izev.get("_izev_total"),
            "izev_fetched": izev.get("_fetched"),
        },
    }
    return data


def inject_html(data):
    if not INDEX_HTML.exists():
        log("WARN: index.html not found; skipping embed.")
        return
    html = INDEX_HTML.read_text()
    blob = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    blob = blob.replace("<", "\\u003c")  # guard against </script>
    pattern = re.compile(
        r'(<script id="ev-data" type="application/json">)(.*?)(</script>)', re.DOTALL)
    new_html, n = pattern.subn(lambda m: m.group(1) + "\n" + blob + "\n" + m.group(3), html)
    if n:
        INDEX_HTML.write_text(new_html)
        log("Embedded snapshot into index.html.")
    else:
        log("WARN: embed marker not found in index.html.")


def write_outputs(data):
    OUT_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    META_JSON.write_text(json.dumps({
        "generated_at": data["generated_at"],
        "latest_period": data["latest_period"].get("label"),
        "ev_registrations_latest": data["totals"].get("ev_registrations_latest"),
        "ev_share_pct_latest": data["totals"].get("ev_share_pct_latest"),
        "brands_tracked": len(data["by_brand"]),
        "build": data.get("build", {}),
    }, indent=2))
    log(f"Wrote {OUT_JSON.name} and {META_JSON.name}.")


def main():
    log("=== update run start ===")
    prev = load_prev()

    # StatCan (authoritative spine) — fall back to previous published values on failure
    try:
        statcan = build_statcan_layer()
    except (urllib.error.URLError, RuntimeError, ValueError, KeyError) as e:
        log(f"StatCan: FAILED ({e!r}).")
        if prev:
            log("StatCan: reusing previous published spine.")
            statcan = {k: prev.get(k) for k in
                       ("latest_period", "totals", "powertrain_mix", "ev_trend_quarterly", "by_province_latest")}
        else:
            log("StatCan: no previous data; aborting (page keeps placeholder).")
            return 1

    # Monthly sales series (independent failure mode — falls back to previous values)
    try:
        monthly = build_monthly_layer()
    except (urllib.error.URLError, RuntimeError, ValueError, KeyError) as e:
        log(f"StatCan monthly: FAILED ({e!r}); reusing previous monthly series.")
        monthly = {
            "ev_trend_monthly": (prev.get("ev_trend_monthly", []) if prev else []),
            "latest_month": (prev.get("totals", {}).get("latest_month") if prev else None),
        }

    izev = get_izev_layer(prev)
    data = assemble(statcan, monthly, izev, prev)
    write_outputs(data)
    inject_html(data)
    log(f"=== update run done: {data['latest_period'].get('label')} · "
        f"{len(data['by_brand'])} brands · {data['totals'].get('ev_share_pct_latest')}% EV share ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
