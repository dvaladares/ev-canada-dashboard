/* Canada EV Sales Dashboard: dependency-free renderer
 * Reads the embedded JSON snapshot (#ev-data). When served over HTTP it also
 * polls data/ev_sales.json so an open tab refreshes itself as new data lands.
 */
(function () {
  "use strict";

  var POLL_MINUTES = 24 * 60;  // once a day; the data itself changes once a month
  var nf = new Intl.NumberFormat("en-CA");
  var COLORS = { bev: "#0f8a5f", phev: "#1f6feb", hybrid: "#f0a500", other: "#94a3a0" };

  function fmt(n) { return (n == null || isNaN(n)) ? "n/a" : nf.format(Math.round(n)); }
  function pct(n, d) { d = d == null ? 1 : d; return (n == null || isNaN(n)) ? "n/a" : Number(n).toFixed(d) + "%"; }
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  // ISO date -> friendly "June 19, 2026" (leaves non-ISO strings untouched)
  var MONTHS_LONG = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  function friendlyDate(s) {
    if (!s) return "";
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
    if (!m) return String(s);
    return MONTHS_LONG[+m[2] - 1] + " " + (+m[3]) + ", " + m[1];
  }

  function readEmbedded() {
    try { return JSON.parse(document.getElementById("ev-data").textContent); }
    catch (e) { return null; }
  }

  // ---- powertrain color mapping ----
  function ptColor(name) {
    var n = (name || "").toLowerCase();
    if (n.indexOf("battery") >= 0 || n === "bev" || (n.indexOf("electric") >= 0 && n.indexOf("hybrid") < 0)) return COLORS.bev;
    if (n.indexOf("plug") >= 0 || n === "phev") return COLORS.phev;
    if (n.indexOf("hybrid") >= 0) return COLORS.hybrid;
    return COLORS.other;
  }

  // ===== renderers =====
  function renderHeader(d) {
    var lp = (d.latest_period && d.latest_period.label) || (d.totals && d.totals.period_label) || "n/a";
    document.getElementById("period-badge").textContent = "Latest quarter: " + lp;
    var mb = document.getElementById("month-badge");
    var lm = d.totals && d.totals.latest_month;
    if (mb) {
      if (lm && lm.label) { mb.hidden = false; mb.textContent = "Latest month: " + lm.label + " | " + fmt(lm.zev); }
      else { mb.hidden = true; }
    }
    var when = d.generated_at ? new Date(d.generated_at) : null;
    document.getElementById("updated-badge").textContent = when
      ? "Updated " + when.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" })
      : "Updated n/a";
    document.getElementById("gen-time").textContent = when ? when.toLocaleString("en-CA") : "n/a";
    document.getElementById("poll-mins").textContent = POLL_MINUTES >= 1440 ? "day" : POLL_MINUTES + " min";
    if (d.subtitle) document.getElementById("subtitle").textContent = d.subtitle;
  }

  function kpiCard(label, value, sub, cls) {
    return '<div class="kpi"><div class="label">' + esc(label) + '</div>' +
      '<div class="value">' + value + '</div>' +
      '<div class="sub ' + (cls || "") + '">' + (sub || "") + '</div></div>';
  }

  function renderKpis(d) {
    var t = d.totals || {};
    var host = document.getElementById("kpis");
    var cards = "";
    cards += kpiCard("EV registrations", fmt(t.ev_registrations_latest), esc(t.period_label || "") + " | BEV + PHEV");
    cards += kpiCard("EV market share", pct(t.ev_share_pct_latest), "of all new vehicles");
    var bev = t.bev_latest, phev = t.phev_latest;
    var split = (bev != null && phev != null) ? fmt(bev) + " / " + fmt(phev) : "n/a";
    cards += kpiCard("BEV / PHEV", split, "battery vs plug-in hybrid");
    if (t.yoy_growth_pct != null && !isNaN(t.yoy_growth_pct)) {
      var up = t.yoy_growth_pct >= 0;
      cards += kpiCard("Year-over-year", (up ? "+" : "") + pct(t.yoy_growth_pct), up ? "Up vs same period last year" : "Down vs same period last year", up ? "up" : "down");
    } else {
      var n = (d.by_brand || []).length;
      cards += kpiCard("Brands tracked", n ? fmt(n) : "-", "with EV registrations");
    }
    host.innerHTML = cards;
  }

  function renderBars(hostId, rows, opts) {
    opts = opts || {};
    var host = document.getElementById(hostId);
    host.innerHTML = "";
    if (!rows || !rows.length) {
      host.appendChild(el("p", { class: "muted" }, "No data available for this section yet."));
      return;
    }
    var max = opts.max || Math.max.apply(null, rows.map(function (r) { return r.value || 0; })) || 1;
    rows.forEach(function (r) {
      var row = el("div", { class: "bar-row" });
      row.appendChild(el("div", { class: "name", title: r.name }, esc(r.name)));
      var track = el("div", { class: "bar-track" });
      var fill = el("div", { class: "bar-fill" + (opts.alt ? " alt" : "") });
      fill.style.width = "0%";
      track.appendChild(fill);
      row.appendChild(track);
      var valHtml = fmt(r.value) + (r.share != null ? ' <small>' + pct(r.share) + "</small>" : "");
      row.appendChild(el("div", { class: "val" }, valHtml));
      host.appendChild(row);
      // animate after paint
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { fill.style.width = Math.max(1.5, (r.value / max) * 100) + "%"; });
      });
    });
  }

  var brandView = "tiles";   // "tiles" (treemap) or "list" (A to Z bars)

  // squarified treemap: items [{name, value, ...}] into box {x,y,w,h}
  function squarify(items, box) {
    var out = [];
    var total = items.reduce(function (s, i) { return s + i.value; }, 0) || 1;
    var scale = (box.w * box.h) / total;
    var rest = items.slice().sort(function (a, b) { return b.value - a.value; })
      .map(function (i) { return { item: i, area: i.value * scale }; });
    var x = box.x, y = box.y, w = box.w, h = box.h;
    function worst(row, side) {
      var s = row.reduce(function (t, r) { return t + r.area; }, 0);
      var mx = Math.max.apply(null, row.map(function (r) { return r.area; }));
      var mn = Math.min.apply(null, row.map(function (r) { return r.area; }));
      return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
    }
    function layout(row, side, vertical) {
      var s = row.reduce(function (t, r) { return t + r.area; }, 0);
      var thick = s / side;
      var off = 0;
      row.forEach(function (r) {
        var len = r.area / thick;
        out.push(vertical
          ? { item: r.item, x: x, y: y + off, w: thick, h: len }
          : { item: r.item, x: x + off, y: y, w: len, h: thick });
        off += len;
      });
      if (vertical) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    }
    var row = [];
    while (rest.length) {
      var vertical = w >= h;
      var side = vertical ? h : w;
      var next = rest[0];
      if (!row.length || worst(row.concat([next]), side) <= worst(row, side)) { row.push(rest.shift()); }
      else { layout(row, side, vertical); row = []; }
    }
    if (row.length) layout(row, w >= h ? h : w, w >= h);
    return out;
  }

  function bevShade(bevFrac) {
    // all-BEV = charge green, all-PHEV = grid blue, mixed in between
    var g = [14, 159, 110], b = [37, 99, 235];
    var t = isNaN(bevFrac) ? 0.5 : bevFrac;
    var c = g.map(function (v, i) { return Math.round(b[i] + (v - b[i]) * t); });
    return "rgb(" + c.join(",") + ")";
  }

  function renderTreemap(hostId, items) {
    var host = document.getElementById(hostId);
    host.innerHTML = "";
    var W = 1000, H = 420;
    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("class", "treemap");
    var tiles = squarify(items.filter(function (i) { return i.value > 0; }), { x: 0, y: 0, w: W, h: H });
    var total = items.reduce(function (s, i) { return s + i.value; }, 0) || 1;
    tiles.forEach(function (t) {
      var g = document.createElementNS(svgNS, "g");
      var r = document.createElementNS(svgNS, "rect");
      var pad = 1.5;
      r.setAttribute("x", t.x + pad); r.setAttribute("y", t.y + pad);
      r.setAttribute("width", Math.max(0, t.w - pad * 2)); r.setAttribute("height", Math.max(0, t.h - pad * 2));
      r.setAttribute("rx", 6);
      r.setAttribute("fill", bevShade(t.item.bevFrac));
      var tt = document.createElementNS(svgNS, "title");
      tt.textContent = t.item.name + ": " + fmt(t.item.value) + " claims (" + pct((t.item.value / total) * 100) + ")" +
        (t.item.bev != null ? " | BEV " + fmt(t.item.bev) + ", PHEV " + fmt(t.item.phev) : "");
      g.appendChild(r); g.appendChild(tt);
      var big = t.w > 92 && t.h > 40;
      var mid = t.w > 56 && t.h > 26;
      if (big || mid) {
        var tx = document.createElementNS(svgNS, "text");
        tx.setAttribute("x", t.x + 9); tx.setAttribute("y", t.y + (big ? 22 : 18));
        tx.setAttribute("class", "tlabel");
        tx.setAttribute("style", "font-size:" + (big ? 14 : 11) + "px");
        tx.textContent = t.item.name;
        g.appendChild(tx);
        if (big) {
          var tv = document.createElementNS(svgNS, "text");
          tv.setAttribute("x", t.x + 9); tv.setAttribute("y", t.y + 40);
          tv.setAttribute("class", "tval");
          tv.textContent = fmt(t.item.value) + " | " + pct((t.item.value / total) * 100);
          g.appendChild(tv);
        }
      }
      svg.appendChild(g);
    });
    host.appendChild(svg);
    var key = el("div", { class: "map-key" });
    key.innerHTML = '<span><i style="background:' + bevShade(1) + '"></i>all battery electric</span>' +
      '<span><i style="background:' + bevShade(0.5) + '"></i>mixed</span>' +
      '<span><i style="background:' + bevShade(0) + '"></i>all plug-in hybrid</span>' +
      '<span class="muted">Tile area = incentive claims. Hover for numbers.</span>';
    host.appendChild(key);
  }

  function renderBrands(d) {
    var sub = document.getElementById("brand-sub");
    var m = d.by_brand_meta || {};
    var all = (d.by_brand || []).map(function (b) {
      var bev = b.bev, phev = b.phev;
      return { name: b.brand, value: b.units, share: b.share_pct, bev: bev, phev: phev,
               bevFrac: (bev != null && phev != null && (bev + phev) > 0) ? bev / (bev + phev) : NaN };
    });
    var bits = [];
    if (m.metric) bits.push(esc(m.metric));
    if (m.period) bits.push(esc(m.period));
    if (all.length) bits.push(fmt(all.length) + " brands");
    if (m.source) bits.push("Source: " + esc(m.source));
    sub.innerHTML = bits.join(" | ") || "n/a";

    var tiles = document.getElementById("brand-tiles");
    var list = document.getElementById("brand-bars");
    if (brandView === "tiles") {
      tiles.hidden = false; list.hidden = true;
      renderTreemap("brand-tiles", all);
    } else {
      tiles.hidden = true; list.hidden = false;
      var rows = all.slice().sort(function (a, b) { return a.name.localeCompare(b.name, "en"); });
      var max = Math.max.apply(null, all.map(function (r) { return r.value || 0; })) || 1;
      renderBars("brand-bars", rows, { max: max });
    }
    [].forEach.call(document.querySelectorAll("#brand-toggle button"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-view") === brandView);
    });

    var caveat = document.getElementById("brand-caveat");
    if (m.credibility_note) { caveat.hidden = false; caveat.innerHTML = "Note: " + esc(m.credibility_note); }
    else caveat.hidden = true;
  }

  function renderVehicleTypes(d) {
    var sub = document.getElementById("vt-sub");
    if (!sub) return;
    sub.textContent = (d.totals && d.totals.period_label ? d.totals.period_label + " | " : "") +
      "ZEV registrations by vehicle type, Statistics Canada. Percent = ZEV share of that type's new registrations.";
    var host = document.getElementById("vt-chart");
    if (!host) return;
    var rows = (d.by_vehicle_type_latest || []).filter(function (r) { return (r.zev || 0) > 0; });
    var total = rows.reduce(function (s, r) { return s + (r.zev || 0); }, 0) || 1;
    var cols = ["#0f8a5f", "#1f6feb", "#f0a500", "#94a3a0"];
    drawDonut(host, rows.map(function (r, i) {
      return { label: r.vehicle_type, count: r.zev, color: cols[i % cols.length],
               note: pct(r.share_pct) + " of that type is electric" };
    }), fmt(total), "ZEVs", 170);
  }

  // ---- data status pillboxes ----
  function statusPill(cls, chip, name, desc, period, updated) {
    return '<div class="spill ' + cls + '"><span class="chip"><i></i>' + esc(chip) + '</span>' +
      '<div class="sname">' + esc(name) + '</div><div class="sdesc">' + esc(desc) + '</div>' +
      '<div class="speriod">' + esc(period || "n/a") + '</div>' +
      '<div class="supd">Updated <b>' + esc(updated ? friendlyDate(updated) : "n/a") + '</b></div></div>';
  }
  function renderStatus(d) {
    var host = document.getElementById("status");
    if (!host) return;
    var src = d.sources || [];
    function acc(i) { return src[i] && src[i].accessed; }
    var t = d.totals || {};
    var b = d.build || {};
    var izevFetched = b.izev_fetched ? String(b.izev_fetched).slice(0, 10) : acc(2);
    var xc = null;
    src.forEach(function (s) { if (/electric autonomy/i.test(s.name || "")) xc = s; });
    host.innerHTML =
      statusPill("live", "Live, automated", "Statistics Canada", "Quarterly registrations, table 20-10-0025",
        (d.latest_period && d.latest_period.label) || t.period_label, acc(0)) +
      statusPill("live", "Live, automated", "Statistics Canada", "Monthly sales, table 20-10-0085",
        t.latest_month && t.latest_month.label, acc(1)) +
      statusPill("hist", "Historical", "Transport Canada", "iZEV incentive claims by brand (program ended Mar 2025)",
        b.izev_fy || "n/a", izevFetched) +
      statusPill("xcheck", "Cross-check", "Electric Autonomy", "Independent report on the same StatCan release; cited, not scraped",
        xc ? "Figures match" : "n/a", xc && xc.accessed);
  }

  function renderProvinces(d) {
    document.getElementById("prov-sub").textContent =
      (d.totals && d.totals.period_label ? d.totals.period_label + " | " : "") + "ZEV registrations, Statistics Canada. Percent = ZEV share of that province's new registrations.";
    renderBars("prov-bars", (d.by_province_latest || []).map(function (p) {
      return { name: p.province, value: p.zev, share: p.share_pct };
    }), { alt: true });
    renderMap(d);
  }

  var PROV_CODE = { "Quebec": "QC", "Ontario": "ON", "British Columbia": "BC", "Manitoba": "MB",
    "Nova Scotia": "NS", "New Brunswick": "NB", "Saskatchewan": "SK", "Prince Edward Island": "PE",
    "Yukon": "YT", "Northwest Territories": "NT", "Alberta": "AB", "Nunavut": "NU",
    "Newfoundland and Labrador": "NL" };
  var PROV_NAME = {};
  Object.keys(PROV_CODE).forEach(function (k) { PROV_NAME[PROV_CODE[k]] = k; });

  function shadeFor(share, max) {
    // light to deep blue by ZEV share
    var t = Math.max(0.08, Math.min(1, share / (max || 1)));
    var a = 0.12 + 0.78 * t;
    return "rgba(37, 99, 235, " + a.toFixed(2) + ")";
  }

  function renderMap(d) {
    var host = document.getElementById("prov-map");
    if (!host || typeof CANADA_MAP === "undefined") return;
    var by = {};
    (d.by_province_latest || []).forEach(function (p) { var c = PROV_CODE[p.province]; if (c) by[c] = p; });
    var max = 0;
    Object.keys(by).forEach(function (c) { max = Math.max(max, by[c].share_pct || 0); });
    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", CANADA_MAP.viewBox);
    svg.setAttribute("class", "map-svg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Map of Canada shaded by ZEV share of new registrations");
    CANADA_MAP.paths.forEach(function (pth) {
      var el2 = document.createElementNS(svgNS, "path");
      el2.setAttribute("d", pth.d);
      el2.setAttribute("data-prov", pth.p);
      var rec = by[pth.p];
      el2.setAttribute("class", "prov" + (rec ? "" : " nodata"));
      if (rec) el2.setAttribute("fill", shadeFor(rec.share_pct, max));
      var t = document.createElementNS(svgNS, "title");
      t.textContent = rec
        ? PROV_NAME[pth.p] + ": " + fmt(rec.zev) + " ZEVs, " + pct(rec.share_pct) + " of new registrations"
        : PROV_NAME[pth.p] + ": not reported in this table";
      el2.appendChild(t);
      svg.appendChild(el2);
    });
    host.innerHTML = "";
    host.appendChild(svg);
    var key = el("div", { class: "map-key" });
    key.innerHTML = '<span><i style="background:' + shadeFor(0.1, 1) + '"></i>low share</span>' +
      '<span><i style="background:' + shadeFor(1, 1) + '"></i>high share</span>' +
      '<span><i class="hatch"></i>not in the StatCan table</span>';
    host.appendChild(key);
    // hover sync: highlight list row
    svg.addEventListener("mousemove", function (e) {
      var p = e.target.closest && e.target.closest("path[data-prov]");
      [].forEach.call(document.querySelectorAll("#prov-bars .bar-row"), function (r) {
        r.classList.toggle("hi", !!p && r.getAttribute("data-prov") === p.getAttribute("data-prov"));
      });
    });
    svg.addEventListener("mouseleave", function () {
      [].forEach.call(document.querySelectorAll("#prov-bars .bar-row.hi"), function (r) { r.classList.remove("hi"); });
    });
    [].forEach.call(document.querySelectorAll("#prov-bars .bar-row"), function (r) {
      var name = r.querySelector(".name"); if (name) r.setAttribute("data-prov", PROV_CODE[name.textContent] || "");
    });
  }

  // ---- SVG donut for powertrain mix ----
  function arcPath(cx, cy, ro, ri, a0, a1) {
    var p = function (r, a) { return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; };
    var o0 = p(ro, a0), o1 = p(ro, a1), i1 = p(ri, a1), i0 = p(ri, a0);
    var large = (a1 - a0) > Math.PI ? 1 : 0;
    return "M" + o0[0] + "," + o0[1] + " A" + ro + "," + ro + " 0 " + large + " 1 " + o1[0] + "," + o1[1] +
      " L" + i1[0] + "," + i1[1] + " A" + ri + "," + ri + " 0 " + large + " 0 " + i0[0] + "," + i0[1] + " Z";
  }

  function drawDonut(host, rows, centerBig, centerSmall, size) {
    host.innerHTML = "";
    if (!rows.length) { host.appendChild(el("p", { class: "muted" }, "No data available.")); return; }
    var total = rows.reduce(function (s, r) { return s + (r.count || 0); }, 0) || 1;
    var cx = 110, cy = 110, ro = 100, ri = 64, a = 0;
    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 220 220");
    svg.setAttribute("class", "chart-svg donut");
    svg.style.flex = "0 0 auto";
    svg.style.width = size + "px"; svg.style.height = size + "px";
    rows.forEach(function (r) {
      var frac = (r.count || 0) / total;
      var a1 = a + frac * Math.PI * 2;
      var path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", arcPath(cx, cy, ro, ri, a, Math.max(a, a1 - 0.012)));
      path.setAttribute("fill", r.color);
      var t = document.createElementNS(svgNS, "title");
      t.textContent = r.label + ": " + fmt(r.count) + " (" + pct(frac * 100) + ")";
      path.appendChild(t);
      svg.appendChild(path);
      a = a1;
    });
    var c1 = document.createElementNS(svgNS, "text");
    c1.setAttribute("x", cx); c1.setAttribute("y", cy - 4); c1.setAttribute("text-anchor", "middle");
    c1.setAttribute("style", "font-size:" + (String(centerBig).length > 5 ? 24 : 30) + "px;font-weight:750;fill:var(--ink)");
    c1.textContent = centerBig;
    var c2 = document.createElementNS(svgNS, "text");
    c2.setAttribute("x", cx); c2.setAttribute("y", cy + 16); c2.setAttribute("text-anchor", "middle");
    c2.setAttribute("style", "font-size:11px");
    c2.textContent = centerSmall;
    svg.appendChild(c1); svg.appendChild(c2);
    host.appendChild(svg);
    var leg = el("div", { class: "legend", style: "flex-direction:column;align-items:flex-start;gap:7px;margin-top:0;flex:1 1 170px;min-width:170px;" });
    rows.forEach(function (r) {
      var sp = el("span");
      sp.innerHTML = '<i style="background:' + r.color + '"></i>' +
        esc(r.label) + ': <strong style="color:var(--ink)">' + fmt(r.count) + "</strong> | " + pct((r.count / total) * 100) +
        (r.note ? '<small class="lnote">' + esc(r.note) + '</small>' : "");
      leg.appendChild(sp);
    });
    host.appendChild(leg);
  }

  function renderMix(d) {
    var host = document.getElementById("mix-chart");
    var rows = (d.powertrain_mix || []).filter(function (r) { return (r.count || 0) > 0; });
    var evShare = (d.totals && d.totals.ev_share_pct_latest);
    drawDonut(host, rows.map(function (r) {
      return { label: r.fuel_type, count: r.count, color: ptColor(r.fuel_type) };
    }), evShare != null ? pct(evShare, 1) : "", evShare != null ? "EV share" : "", 180);
  }

  // ---- SVG line/area chart (generic): pts = [{label, value, tip}] ----
  function niceCeil(v) {
    if (v <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var step = mag / 2;
    return Math.ceil(v / step) * step;
  }
  function kfmt(v) { return v >= 1000 ? (Math.round(v / 100) / 10) + "k" : String(Math.round(v)); }

  function drawLineChart(hostId, pts, opts) {
    opts = opts || {};
    var host = document.getElementById(hostId);
    host.innerHTML = "";
    pts = (pts || []).filter(function (p) { return p.value != null && !isNaN(p.value); });
    if (pts.length < 2) { host.appendChild(el("p", { class: "muted" }, "Not enough history to plot a trend yet.")); return; }
    var color = opts.color || COLORS.bev;
    var fillRGBA = opts.fill || "rgba(15,138,95,.12)";
    var W = 600, H = 300, padL = 48, padR = 14, padT = 16, padB = 34;
    var iw = W - padL - padR, ih = H - padT - padB;
    var maxV = Math.max.apply(null, pts.map(function (p) { return p.value; }));
    var niceMax = niceCeil(maxV);
    var n = pts.length;
    var x = function (i) { return padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw); };
    var y = function (v) { return padT + ih - (v / niceMax) * ih; };
    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("class", "chart-svg");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    // gridlines + y labels
    var steps = 4;
    for (var g = 0; g <= steps; g++) {
      var gv = (niceMax / steps) * g, gy = y(gv);
      var ln = document.createElementNS(svgNS, "line");
      ln.setAttribute("x1", padL); ln.setAttribute("x2", W - padR);
      ln.setAttribute("y1", gy); ln.setAttribute("y2", gy);
      ln.setAttribute("class", "gridline");
      svg.appendChild(ln);
      var lab = document.createElementNS(svgNS, "text");
      lab.setAttribute("x", padL - 8); lab.setAttribute("y", gy + 3); lab.setAttribute("text-anchor", "end");
      lab.textContent = kfmt(gv);
      svg.appendChild(lab);
    }
    // area + line
    var dLine = "";
    pts.forEach(function (p, i) { dLine += (i === 0 ? "M" : "L") + x(i).toFixed(1) + "," + y(p.value).toFixed(1) + " "; });
    var dArea = dLine + "L" + x(n - 1).toFixed(1) + "," + (padT + ih) + " L" + x(0).toFixed(1) + "," + (padT + ih) + " Z";
    var area = document.createElementNS(svgNS, "path");
    area.setAttribute("d", dArea); area.setAttribute("fill", fillRGBA); area.setAttribute("stroke", "none");
    svg.appendChild(area);
    var line = document.createElementNS(svgNS, "path");
    line.setAttribute("d", dLine); line.setAttribute("fill", "none");
    line.setAttribute("stroke", color); line.setAttribute("stroke-width", "2.5");
    line.setAttribute("stroke-linejoin", "round"); line.setAttribute("stroke-linecap", "round");
    svg.appendChild(line);
    // points + x labels (thin out labels if many)
    var labelEvery = Math.ceil(n / 8);
    pts.forEach(function (p, i) {
      var px = x(i), py = y(p.value);
      var dot = document.createElementNS(svgNS, "circle");
      dot.setAttribute("cx", px); dot.setAttribute("cy", py); dot.setAttribute("r", 3);
      dot.setAttribute("fill", color);
      var tt = document.createElementNS(svgNS, "title");
      tt.textContent = p.tip || (p.label + ": " + fmt(p.value));
      dot.appendChild(tt);
      svg.appendChild(dot);
      if (i % labelEvery === 0 || i === n - 1) {
        var xl = document.createElementNS(svgNS, "text");
        xl.setAttribute("x", px); xl.setAttribute("y", H - 12); xl.setAttribute("text-anchor", "middle");
        xl.textContent = p.label;
        svg.appendChild(xl);
      }
    });
    host.appendChild(svg);
  }

  // ---- trend card: toggles between quarterly registrations and monthly sales ----
  var trendMode = "quarter";
  function renderTrendCard(d) {
    var titleEl = document.getElementById("trend-title");
    var subEl = document.getElementById("trend-sub");
    var footEl = document.getElementById("trend-foot");
    var monthly = d.ev_trend_monthly || [];
    var hasMonthly = monthly.length >= 2;
    var monthBtn = document.querySelector('#trend-toggle button[data-mode="month"]');
    if (monthBtn) monthBtn.disabled = !hasMonthly;
    if (trendMode === "month" && !hasMonthly) trendMode = "quarter";

    if (trendMode === "month") {
      titleEl.textContent = "EV trend: monthly";
      subEl.textContent = "Zero-emission new-vehicle sales | Statistics Canada 20-10-0085";
      drawLineChart("trend-chart", monthly.map(function (r) {
        return { label: r.period, value: r.zev,
          tip: r.period + ": " + fmt(r.zev) + " ZEV sales" +
               (r.zev_share_pct != null ? " (" + pct(r.zev_share_pct) + " share)" : "") };
      }), { color: COLORS.bev });
      var lm = d.totals && d.totals.latest_month;
      footEl.textContent = lm ? ("Latest month, " + lm.label + ": " + fmt(lm.zev) + " ZEV sales" +
        (lm.share_pct != null ? " (" + pct(lm.share_pct) + " of new sales)" : "")) : "";
    } else {
      titleEl.textContent = "EV trend: quarterly";
      subEl.textContent = "ZEV registrations (BEV + PHEV) | Statistics Canada 20-10-0025";
      drawLineChart("trend-chart", (d.ev_trend_quarterly || []).map(function (r) {
        return { label: r.period, value: r.zev_total,
          tip: r.period + ": " + fmt(r.zev_total) + " ZEV" +
               (r.bev != null ? "  |  BEV " + fmt(r.bev) + " / PHEV " + fmt(r.phev) : "") +
               (r.zev_share_pct != null ? "  |  " + pct(r.zev_share_pct) + " share" : "") };
      }), { color: COLORS.bev });
      var t = d.totals || {};
      footEl.textContent = t.period_label ? ("Latest quarter, " + t.period_label + ": " +
        fmt(t.ev_registrations_latest) + " ZEV registrations" +
        (t.ev_share_pct_latest != null ? " (" + pct(t.ev_share_pct_latest) + " share)" : "")) : "";
    }
    [].forEach.call(document.querySelectorAll("#trend-toggle button"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-mode") === trendMode);
    });
  }

  function sourceKind(s) {
    var n = (s.name || "").toLowerCase();
    if (n.indexOf("electric autonomy") >= 0) return { cls: "xcheck", label: "Cross-check" };
    if (n.indexOf("izev") >= 0) return { cls: "hist", label: "Historical" };
    return { cls: "live", label: "Live" };
  }

  function renderSources(d) {
    var host = document.getElementById("sources-list");
    host.innerHTML = (d.sources || []).map(function (s) {
      var k = sourceKind(s);
      var title = s.url
        ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.name) + "</a>"
        : esc(s.name);
      return '<div class="src-card ' + k.cls + '">' +
        '<div class="src-top"><span class="chip"><i></i>' + k.label + '</span>' +
        (s.accessed ? '<span class="src-acc">Pulled ' + esc(friendlyDate(s.accessed)) + '</span>' : '') + '</div>' +
        '<div class="src-name">' + title + '</div>' +
        (s.detail ? '<div class="src-detail">' + esc(s.detail) + '</div>' : '') +
        '</div>';
    }).join("");

    var meth = document.getElementById("methodology");
    var m = d.methodology;
    if (Array.isArray(m)) {
      meth.innerHTML = '<ol class="method-list">' +
        m.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ol>";
    } else {
      meth.innerHTML = m ? esc(m).replace(/\n/g, "<br />") : "";
    }
  }

  // Other public projects, linked from the About rail. Static on purpose.
  var PROJECTS = [
    { name: "token-sipping-mode", url: "https://github.com/dvaladares/token-sipping-mode",
      desc: "A Claude Code skill: delegate the legwork, own the verdict. Budget discipline for long agent sessions." },
    { name: "mac-disk-clean", url: "https://github.com/dvaladares/mac-disk-clean",
      desc: "An LLM-guided Mac disk cleaner. Reclaim 50+ GB safely, no subscription." }
  ];

  function renderAbout(d) {
    var host = document.getElementById("about-rail");
    if (!host) return;
    var t = d.totals || {};
    var lm = t.latest_month || {};
    var when = d.generated_at ? friendlyDate(String(d.generated_at).slice(0, 10)) : "n/a";
    function fact(label, value, sub) {
      return '<div class="fact"><div class="flabel">' + esc(label) + '</div>' +
        '<div class="fvalue">' + value + '</div>' +
        (sub ? '<div class="fsub">' + esc(sub) + '</div>' : '') + '</div>';
    }
    host.innerHTML =
      '<p class="eyebrow">At a glance</p>' +
      fact("Latest quarter", esc(t.period_label || "n/a"), fmt(t.ev_registrations_latest) + " ZEVs, " + pct(t.ev_share_pct_latest) + " share") +
      fact("Latest month", esc(lm.label || "n/a"), lm.zev != null ? fmt(lm.zev) + " ZEVs, " + pct(lm.share_pct) + " share" : "") +
      fact("Refresh", "Monthly", "15th of each month, automated. Last run " + when + ".") +
      fact("Sources", fmt((d.sources || []).length), "public, linked, dated") +
      fact("Stack", "Python + JS", "standard library, no framework, no build step") +
      fact("Licence", "MIT", "use it, fork it, break it") +
      '<a class="btn" href="https://github.com/dvaladares/ev-canada-dashboard" target="_blank" rel="noopener">View the code on GitHub</a>' +
      '<div class="projects"><p class="eyebrow">Other projects</p>' +
      PROJECTS.map(function (p) {
        return '<a class="proj" href="' + esc(p.url) + '" target="_blank" rel="noopener">' +
          '<span class="pname">' + esc(p.name) + '</span><span class="pdesc">' + esc(p.desc) + '</span></a>';
      }).join("") +
      '<a class="proj more" href="https://github.com/dvaladares" target="_blank" rel="noopener"><span class="pname">All public code</span><span class="pdesc">github.com/dvaladares</span></a>' +
      '</div>';
  }

  function render(d) {
    if (!d) return;
    renderHeader(d);
    renderKpis(d);
    renderStatus(d);
    renderBrands(d);
    renderMix(d);
    renderTrendCard(d);
    renderProvinces(d);
    renderVehicleTypes(d);
    renderSources(d);
    renderAbout(d);
  }

  // ===== tabs =====
  function showTab(name) {
    [].forEach.call(document.querySelectorAll(".tab"), function (t) { t.classList.toggle("on", t.getAttribute("data-tab") === name); });
    [].forEach.call(document.querySelectorAll(".pane"), function (p) { p.classList.toggle("on", p.getAttribute("data-pane") === name); });
    if (name === "about") { if (location.hash !== "#about") history.replaceState(null, "", "#about"); }
    else if (location.hash === "#about") { history.replaceState(null, "", location.pathname); }
    window.scrollTo({ top: 0 });
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-tab]");
    if (b) { e.preventDefault(); showTab(b.getAttribute("data-tab")); }
  });
  if (location.hash === "#about") showTab("about");

  // ===== load + poll =====
  if (location.hash.replace("#", "") === "monthly") trendMode = "month";
  var current = readEmbedded();
  render(current);

  // wire the quarterly/monthly toggle once (and support #monthly / #quarterly deep links)
  var toggleEl = document.getElementById("trend-toggle");
  if (toggleEl) {
    toggleEl.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-mode]");
      if (!btn || btn.disabled) return;
      trendMode = btn.getAttribute("data-mode");
      if (current) renderTrendCard(current);
    });
  }
  var brandToggle = document.getElementById("brand-toggle");
  if (brandToggle) {
    brandToggle.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-view]");
      if (!btn) return;
      brandView = btn.getAttribute("data-view");
      if (current) renderBrands(current);
    });
  }
  window.addEventListener("hashchange", function () {
    var h = location.hash.replace("#", "");
    if (h === "monthly" || h === "quarter") { trendMode = h === "monthly" ? "month" : "quarter"; if (current) renderTrendCard(current); }
  });

  function flashLive() {
    var dot = document.getElementById("live-dot");
    if (dot) { dot.style.background = "#1bb377"; setTimeout(function () { dot.style.background = ""; }, 1200); }
  }

  function tryFetch() {
    if (location.protocol !== "http:" && location.protocol !== "https:") return; // file:// -> use embedded only
    fetch("data/ev_sales.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (fresh) {
        if (fresh && fresh.status === "ok" && (!current || fresh.generated_at !== (current && current.generated_at))) {
          current = fresh; render(fresh); flashLive();
        }
      })
      .catch(function () { /* offline / file mode: embedded snapshot stands */ });
  }

  tryFetch();
  setInterval(tryFetch, POLL_MINUTES * 60 * 1000);
})();
