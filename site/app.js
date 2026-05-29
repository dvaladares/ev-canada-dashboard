/* Canada EV Sales Dashboard — dependency-free renderer
 * Reads the embedded JSON snapshot (#ev-data). When served over HTTP it also
 * polls data/ev_sales.json so an open tab refreshes itself as new data lands.
 */
(function () {
  "use strict";

  var POLL_MINUTES = 60;
  var nf = new Intl.NumberFormat("en-CA");
  var COLORS = { bev: "#0f8a5f", phev: "#1f6feb", hybrid: "#f0a500", other: "#94a3a0" };

  function fmt(n) { return (n == null || isNaN(n)) ? "—" : nf.format(Math.round(n)); }
  function pct(n, d) { d = d == null ? 1 : d; return (n == null || isNaN(n)) ? "—" : Number(n).toFixed(d) + "%"; }
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

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
    var lp = (d.latest_period && d.latest_period.label) || (d.totals && d.totals.period_label) || "—";
    document.getElementById("period-badge").textContent = "Latest quarter: " + lp;
    var mb = document.getElementById("month-badge");
    var lm = d.totals && d.totals.latest_month;
    if (mb) {
      if (lm && lm.label) { mb.hidden = false; mb.textContent = "Latest month: " + lm.label + " · " + fmt(lm.zev); }
      else { mb.hidden = true; }
    }
    var when = d.generated_at ? new Date(d.generated_at) : null;
    document.getElementById("updated-badge").textContent = when
      ? "Updated " + when.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" })
      : "Updated —";
    document.getElementById("gen-time").textContent = when ? when.toLocaleString("en-CA") : "—";
    document.getElementById("poll-mins").textContent = POLL_MINUTES;
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
    cards += kpiCard("EV registrations", fmt(t.ev_registrations_latest), esc(t.period_label || "") + " · BEV + PHEV");
    cards += kpiCard("EV market share", pct(t.ev_share_pct_latest), "of all new vehicles");
    var bev = t.bev_latest, phev = t.phev_latest;
    var split = (bev != null && phev != null) ? fmt(bev) + " / " + fmt(phev) : "—";
    cards += kpiCard("BEV / PHEV", split, "battery vs plug-in hybrid");
    if (t.yoy_growth_pct != null && !isNaN(t.yoy_growth_pct)) {
      var up = t.yoy_growth_pct >= 0;
      cards += kpiCard("Year-over-year", (up ? "+" : "") + pct(t.yoy_growth_pct), up ? "▲ vs same period last year" : "▼ vs same period last year", up ? "up" : "down");
    } else {
      var n = (d.by_brand || []).length;
      cards += kpiCard("Brands tracked", n ? fmt(n) : "—", "with EV registrations");
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
    var max = Math.max.apply(null, rows.map(function (r) { return r.value || 0; })) || 1;
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

  function renderBrands(d) {
    var sub = document.getElementById("brand-sub");
    var m = d.by_brand_meta || {};
    var bits = [];
    if (m.metric) bits.push(esc(m.metric));
    if (m.period) bits.push(esc(m.period));
    if (m.source) bits.push("Source: " + esc(m.source));
    sub.innerHTML = bits.join(" · ") || "—";
    renderBars("brand-bars", (d.by_brand || []).map(function (b) {
      return { name: b.brand, value: b.units, share: b.share_pct };
    }));
    var caveat = document.getElementById("brand-caveat");
    if (m.credibility_note) { caveat.hidden = false; caveat.innerHTML = "ⓘ " + esc(m.credibility_note); }
    else caveat.hidden = true;
  }

  function renderProvinces(d) {
    document.getElementById("prov-sub").textContent =
      (d.totals && d.totals.period_label ? d.totals.period_label + " · " : "") + "ZEV registrations, Statistics Canada";
    renderBars("prov-bars", (d.by_province_latest || []).map(function (p) {
      return { name: p.province, value: p.zev, share: p.share_pct };
    }), { alt: true });
  }

  // ---- SVG donut for powertrain mix ----
  function arcPath(cx, cy, ro, ri, a0, a1) {
    var p = function (r, a) { return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; };
    var o0 = p(ro, a0), o1 = p(ro, a1), i1 = p(ri, a1), i0 = p(ri, a0);
    var large = (a1 - a0) > Math.PI ? 1 : 0;
    return "M" + o0[0] + "," + o0[1] + " A" + ro + "," + ro + " 0 " + large + " 1 " + o1[0] + "," + o1[1] +
      " L" + i1[0] + "," + i1[1] + " A" + ri + "," + ri + " 0 " + large + " 0 " + i0[0] + "," + i0[1] + " Z";
  }

  function renderMix(d) {
    var host = document.getElementById("mix-chart");
    host.innerHTML = "";
    var rows = (d.powertrain_mix || []).filter(function (r) { return (r.count || 0) > 0; });
    if (!rows.length) { host.appendChild(el("p", { class: "muted" }, "No powertrain breakdown available.")); return; }
    var total = rows.reduce(function (s, r) { return s + (r.count || 0); }, 0) || 1;
    var cx = 110, cy = 110, ro = 100, ri = 62, a = 0;
    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 220 220");
    svg.setAttribute("width", "220"); svg.setAttribute("height", "220");
    svg.setAttribute("class", "chart-svg");
    svg.style.flex = "0 0 auto";
    rows.forEach(function (r) {
      var frac = (r.count || 0) / total;
      var a1 = a + frac * Math.PI * 2;
      var path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", arcPath(cx, cy, ro, ri, a, a1 - 0.012));
      path.setAttribute("fill", ptColor(r.fuel_type));
      var t = document.createElementNS(svgNS, "title");
      t.textContent = r.fuel_type + ": " + fmt(r.count) + " (" + pct(r.share_pct != null ? r.share_pct : frac * 100) + ")";
      path.appendChild(t);
      svg.appendChild(path);
      a = a1;
    });
    // center label = EV (BEV+PHEV) share if present
    var evShare = (d.totals && d.totals.ev_share_pct_latest);
    var c1 = document.createElementNS(svgNS, "text");
    c1.setAttribute("x", cx); c1.setAttribute("y", cy - 4); c1.setAttribute("text-anchor", "middle");
    c1.setAttribute("style", "font-size:26px;font-weight:750;fill:var(--ink)");
    c1.textContent = evShare != null ? pct(evShare, 1) : "";
    var c2 = document.createElementNS(svgNS, "text");
    c2.setAttribute("x", cx); c2.setAttribute("y", cy + 16); c2.setAttribute("text-anchor", "middle");
    c2.setAttribute("style", "font-size:11px");
    c2.textContent = evShare != null ? "EV share" : "";
    svg.appendChild(c1); svg.appendChild(c2);
    host.appendChild(svg);
    // legend
    var leg = el("div", { class: "legend", style: "flex-direction:column;align-items:flex-start;gap:9px;" });
    rows.forEach(function (r) {
      var s = el("span");
      s.innerHTML = '<i style="background:' + ptColor(r.fuel_type) + '"></i>' +
        esc(r.fuel_type) + ' — <strong style="color:var(--ink)">' + fmt(r.count) + "</strong> · " +
        pct(r.share_pct != null ? r.share_pct : (r.count / total) * 100);
      leg.appendChild(s);
    });
    host.appendChild(leg);
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
    var W = 600, H = 260, padL = 48, padR = 14, padT = 16, padB = 34;
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
      titleEl.textContent = "EV trend — monthly";
      subEl.textContent = "Zero-emission new-vehicle sales · Statistics Canada 20-10-0085";
      drawLineChart("trend-chart", monthly.map(function (r) {
        return { label: r.period, value: r.zev,
          tip: r.period + ": " + fmt(r.zev) + " ZEV sales" +
               (r.zev_share_pct != null ? " (" + pct(r.zev_share_pct) + " share)" : "") };
      }), { color: COLORS.bev });
      var lm = d.totals && d.totals.latest_month;
      footEl.textContent = lm ? ("Latest month — " + lm.label + ": " + fmt(lm.zev) + " ZEV sales" +
        (lm.share_pct != null ? " (" + pct(lm.share_pct) + " of new sales)" : "")) : "";
    } else {
      titleEl.textContent = "EV trend — quarterly";
      subEl.textContent = "ZEV registrations (BEV + PHEV) · Statistics Canada 20-10-0025";
      drawLineChart("trend-chart", (d.ev_trend_quarterly || []).map(function (r) {
        return { label: r.period, value: r.zev_total,
          tip: r.period + ": " + fmt(r.zev_total) + " ZEV" +
               (r.bev != null ? "  ·  BEV " + fmt(r.bev) + " / PHEV " + fmt(r.phev) : "") +
               (r.zev_share_pct != null ? "  ·  " + pct(r.zev_share_pct) + " share" : "") };
      }), { color: COLORS.bev });
      var t = d.totals || {};
      footEl.textContent = t.period_label ? ("Latest quarter — " + t.period_label + ": " +
        fmt(t.ev_registrations_latest) + " ZEV registrations" +
        (t.ev_share_pct_latest != null ? " (" + pct(t.ev_share_pct_latest) + " share)" : "")) : "";
    }
    [].forEach.call(document.querySelectorAll("#trend-toggle button"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-mode") === trendMode);
    });
  }

  function renderSources(d) {
    var host = document.getElementById("sources-list");
    host.innerHTML = "";
    (d.sources || []).forEach(function (s) {
      var item = el("div", { class: "source-item" });
      var link = s.url ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.name) + "</a>" : "<strong>" + esc(s.name) + "</strong>";
      var detail = s.detail ? " — " + esc(s.detail) : "";
      var acc = s.accessed ? ' <span class="pill">accessed ' + esc(s.accessed) + "</span>" : "";
      item.innerHTML = link + detail + acc;
      host.appendChild(item);
    });
    var meth = document.getElementById("methodology");
    meth.innerHTML = d.methodology ? esc(d.methodology).replace(/\n/g, "<br />") : "";
  }

  function renderCurrentShares(d) {
    var s = d.current_brand_shares;
    var card = document.getElementById("shares-card");
    if (!card) return;
    if (!s || !s.rows || !s.rows.length) { card.hidden = true; return; }
    card.hidden = false;
    document.getElementById("shares-sub").textContent =
      (s.metric || "Brand shares") + " · Source: " + (s.source || "") + (s.via ? " (via " + s.via + ")" : "");
    document.getElementById("shares-asof").textContent = s.as_of || "";
    var host = document.getElementById("shares-list");
    host.innerHTML = "";
    s.rows.forEach(function (r) {
      var tile = el("div", { class: "share-tile" });
      tile.innerHTML =
        '<div class="stier">' + esc(r.period || "") + "</div>" +
        '<div class="sval">' + esc(r.value || "") + "</div>" +
        '<div class="slabel">' + esc(r.label || "") + "</div>" +
        (r.note ? '<div class="snote">' + esc(r.note) + "</div>" : "");
      host.appendChild(tile);
    });
    var ctx = document.getElementById("shares-context");
    ctx.textContent = s.context || "";
    ctx.hidden = !s.context;
    var note = document.getElementById("shares-note");
    var link = s.source_url ? ' <a href="' + esc(s.source_url) +
      '" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600;">S&amp;P Global Mobility ↗</a>' : "";
    note.innerHTML = "ⓘ " + esc(s.note || "") + (s.reviewed ? " (reviewed " + esc(s.reviewed) + ")" : "") + link;
  }

  function render(d) {
    if (!d) return;
    renderHeader(d);
    renderKpis(d);
    renderBrands(d);
    renderCurrentShares(d);
    renderMix(d);
    renderTrendCard(d);
    renderProvinces(d);
    renderSources(d);
  }

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
      .catch(function () { /* offline / file mode — embedded snapshot stands */ });
  }

  tryFetch();
  setInterval(tryFetch, POLL_MINUTES * 60 * 1000);
})();
