/* The flight review page: shows one flight from a saved log. It only reads; it sends nothing.
 *
 * The flight object (what a log decoder hands this file; flight_review_demo.js makes one):
 *   meta     {name, logId, board, firmware, sim, demo, launchUtcMs (null if unknown), bytes, skippedBytes,
 *             restarts, navFromBaro, noLaunch}
 *   pad      {lat, lon, hMsl}
 *   tStart, tEnd                       seconds from Launch, like every t below
 *   nav      {t[], alt[], vs[], poor[]}   navigation's height above the pad (m) and vertical speed (m/s)
 *   baro     {t[], alt[]}              barometer height above the pad (m)
 *   gps      {t[], lat[], lon[], h[], sv[], hdop[]}   h is height above the pad (m)
 *   states   [{t, s}]                  the one state list, lower case
 *   events   [{t, kind, alt?}]         launch, apogee, landing
 *   marks    [{t, kind}]               open, reboot, close, overflow
 *   commands [{t, name, result}]
 *   gpsLost  [{t0, t1}]
 *   text     [{t, scope, text}]
 *   records  [{name, count, bytes}]
 */
(function (root) {
  "use strict";

  const C = {
    ink: "#16181d", dim: "#4a4d55", grid: "#e4e1d9", card: "#ffffff", ground: "#ebe8e1",
    nav: "#2563d9", baro: "#c4530a", gps: "#008f72", flight: "#0b3d91", safe: "#0b5d1e", armed: "#a8001c"
  };
  const BAND = { armed: "rgba(168,0,28,.07)", boost: "rgba(11,61,145,.10)", descent: "rgba(11,61,145,.04)", retrieval: "rgba(11,93,30,.08)" };
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif';
  const M_PER_DEG = 111194.9;

  // ---- small helpers -------------------------------------------------------------------------
  const $ = function (id) { return document.getElementById(id); };
  const el = function (tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  function niceStep(span, target) {
    const raw = span / target, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
  }
  function lowerBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function valueAt(ts, vs, t) {
    if (!ts.length) return NaN;
    const i = lowerBound(ts, t);
    if (i <= 0) return vs[0];
    if (i >= ts.length) return vs[ts.length - 1];
    const f = (t - ts[i - 1]) / (ts[i] - ts[i - 1] || 1);
    return vs[i - 1] + f * (vs[i] - vs[i - 1]);
  }
  function fmtT(t) {
    const sign = t < 0 ? "−" : "+", a = Math.abs(t);
    if (a < 60) return "T" + sign + a.toFixed(1) + " s";
    const m = Math.floor(a / 60), s = Math.floor(a % 60);
    return "T" + sign + m + ":" + (s < 10 ? "0" : "") + s;
  }
  function fmtDur(s) {
    if (s < 60) return s.toFixed(1) + " s";
    const m = Math.floor(s / 60), r = Math.round(s % 60);
    return m + " min " + r + " s";
  }
  const signed = function (v, digits) { return (v < 0 ? "−" : "") + Math.abs(v).toFixed(digits); };
  const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

  // ---- the numbers the page shows, worked out from the flight object ---------------------------
  function derive(f) {
    const ev = function (kind) { return f.events.find(function (e) { return e.kind === kind; }); };
    const apogee = ev("apogee"), landing = ev("landing");
    const apogeeAlt = apogee && apogee.alt !== undefined ? apogee.alt : Math.max.apply(null, f.nav.alt);
    const iPeak = f.nav.alt.indexOf(Math.max.apply(null, f.nav.alt));
    const tPeak = f.nav.t[iPeak];
    // Touchdown: the detector calls Landing after a wait, so the height trace gives the moment itself.
    const endT = landing ? landing.t : f.tEnd, restAlt = valueAt(f.nav.t, f.nav.alt, endT);
    let tTouch = endT;
    for (let i = lowerBound(f.nav.t, endT) - 1; i > iPeak; i--) {
      if (Math.abs(f.nav.alt[i] - restAlt) > 3) { tTouch = f.nav.t[Math.min(i + 1, f.nav.t.length - 1)]; break; }
    }
    let maxVs = 0, sum = 0, n = 0;
    for (let i = 0; i < f.nav.t.length; i++) {
      const t = f.nav.t[i];
      if (t >= 0 && t <= tTouch) maxVs = Math.max(maxVs, f.nav.vs[i]);
      if (t > tPeak + 8 && t < tTouch - 3) { sum += f.nav.vs[i]; n++; }
    }
    const cosLat = Math.cos(f.pad.lat * Math.PI / 180);
    const east = f.gps.lon.map(function (lon) { return (lon - f.pad.lon) * M_PER_DEG * cosLat; });
    const north = f.gps.lat.map(function (lat) { return (lat - f.pad.lat) * M_PER_DEG; });
    const iLand = Math.max(0, Math.min(f.gps.t.length - 1, lowerBound(f.gps.t, endT)));
    const le = east.length ? east[iLand] : NaN, ln = north.length ? north[iLand] : NaN;
    const bearing = (Math.atan2(le, ln) * 180 / Math.PI + 360) % 360;
    return {
      apogeeAlt: apogeeAlt, tPeak: tPeak, tApogee: apogee ? apogee.t : tPeak, tTouch: tTouch, tLanding: endT,
      maxVs: maxVs, descentRate: n ? -sum / n : NaN,
      east: east, north: north, landE: le, landN: ln, landLat: f.gps.lat[iLand], landLon: f.gps.lon[iLand],
      drift: Math.hypot(le, ln), bearing: bearing, compass: COMPASS[Math.round(bearing / 22.5) % 16],
      landSv: f.gps.sv[iLand], landHdop: f.gps.hdop[iLand]
    };
  }

  // ---- drawing: one time chart ------------------------------------------------------------------
  // o: {x0, x1, series[{t, v, color, width, step}], bands[{t0, t1, label, fill}], marks[{t, label}],
  //     unit, cursor, hatch[{t0, t1}]}
  function drawChart(ctx, W, H, o) {
    const L = 46, R = 10, T = 46, B = 24, pw = W - L - R, ph = H - T - B;
    const X = function (t) { return L + (t - o.x0) / (o.x1 - o.x0) * pw; };
    let lo = 0, hi = 0;
    o.series.forEach(function (s) {
      for (let i = Math.max(0, lowerBound(s.t, o.x0) - 1); i < s.t.length && s.t[i] <= o.x1; i++) {
        if (s.v[i] < lo) lo = s.v[i];
        if (s.v[i] > hi) hi = s.v[i];
      }
    });
    if (hi - lo < 1e-6) hi = lo + 1;
    const step = niceStep(hi - lo, 4);
    lo = lo > -0.3 * step ? 0 : Math.floor(lo / step) * step; hi = Math.ceil(hi / step + 0.05) * step;
    const Y = function (v) { return T + ph - (v - lo) / (hi - lo) * ph; };

    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = "middle";
    (o.bands || []).forEach(function (b) {
      const a = Math.max(o.x0, b.t0), z = Math.min(o.x1, b.t1);
      if (z <= a) return;
      ctx.fillStyle = b.fill; ctx.fillRect(X(a), T, X(z) - X(a), ph);
      ctx.font = "700 10px " + FONT; ctx.fillStyle = C.dim; ctx.textAlign = "left";
      if (ctx.measureText(b.label).width + 8 < X(z) - X(a)) ctx.fillText(b.label, X(a) + 4, T + 9);
    });
    (o.hatch || []).forEach(function (g) {
      const a = Math.max(o.x0, g.t0), z = Math.min(o.x1, g.t1);
      if (z <= a) return;
      ctx.save(); ctx.beginPath(); ctx.rect(X(a), T, X(z) - X(a), ph); ctx.clip();
      ctx.strokeStyle = "rgba(22,24,29,.18)"; ctx.lineWidth = 1;
      for (let x = X(a) - ph; x < X(z); x += 6) { ctx.beginPath(); ctx.moveTo(x, T + ph); ctx.lineTo(x + ph, T); ctx.stroke(); }
      ctx.restore();
    });
    ctx.font = "12px " + FONT; ctx.lineWidth = 1;
    for (let v = lo; v <= hi + 1e-9; v += step) {
      ctx.strokeStyle = Math.abs(v) < 1e-9 ? "#b9b5ab" : C.grid;
      ctx.beginPath(); ctx.moveTo(L, Math.round(Y(v)) + 0.5); ctx.lineTo(W - R, Math.round(Y(v)) + 0.5); ctx.stroke();
      ctx.fillStyle = C.dim; ctx.textAlign = "right";
      ctx.fillText(signed(v, step < 1 ? 1 : 0), L - 6, Y(v));
    }
    const xStep = niceStep(o.x1 - o.x0, 5);
    ctx.textAlign = "center";
    for (let t = Math.ceil(o.x0 / xStep) * xStep; t <= o.x1; t += xStep) {
      ctx.fillStyle = C.dim; ctx.fillText((t === 0 ? "T+0" : signed(t, 0)) + " s", Math.min(Math.max(X(t), L + 14), W - R - 16), H - 10);
    }
    ctx.textAlign = "left"; ctx.fillStyle = C.dim; ctx.font = "700 11px " + FONT;
    ctx.fillText(o.unit, 4, 9);

    // Event marks: a dashed line with its label above the plot, on two rows so neighbours don't collide.
    const rowEnd = [-1e9, -1e9];
    (o.marks || []).forEach(function (m) {
      if (m.t < o.x0 || m.t > o.x1) return;
      const x = X(m.t);
      ctx.strokeStyle = C.ink; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x + 0.5, T); ctx.lineTo(x + 0.5, T + ph); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = "700 11px " + FONT;
      const w = ctx.measureText(m.label).width, left = Math.min(Math.max(x - w / 2, L), W - R - w);
      const row = left > rowEnd[0] + 6 ? 0 : left > rowEnd[1] + 6 ? 1 : -1;
      if (row < 0) return;
      rowEnd[row] = left + w; ctx.fillStyle = C.ink; ctx.textAlign = "left"; ctx.fillText(m.label, left, row ? 35 : 22);
    });

    ctx.save(); ctx.beginPath(); ctx.rect(L, T - 1, pw, ph + 2); ctx.clip();
    o.series.forEach(function (s) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 2; ctx.lineJoin = "round"; ctx.beginPath();
      let started = false, prevY = 0, prevT = 0;
      for (let i = Math.max(0, lowerBound(s.t, o.x0) - 1); i < s.t.length; i++) {
        const x = X(s.t[i]), y = Y(s.v[i]);
        const gap = started && s.gap && s.t[i] - prevT > s.gap;
        if (!started || gap) ctx.moveTo(x, y); else { if (s.step) ctx.lineTo(x, prevY); ctx.lineTo(x, y); }
        started = true; prevY = y; prevT = s.t[i];
        if (s.t[i] > o.x1) break;
      }
      ctx.stroke();
    });
    ctx.restore();

    if (o.cursor !== undefined && o.cursor >= o.x0 && o.cursor <= o.x1) {
      const x = X(o.cursor);
      ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph); ctx.stroke();
      o.series.forEach(function (s) {
        const v = valueAt(s.t, s.v, o.cursor);
        ctx.fillStyle = C.card; ctx.beginPath(); ctx.arc(x, Y(v), 6, 0, 7); ctx.fill();
        ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(x, Y(v), 4, 0, 7); ctx.fill();
      });
    }
    return { timeAt: function (px) { return o.x0 + Math.min(1, Math.max(0, (px - L) / pw)) * (o.x1 - o.x0); } };
  }

  // ---- drawing: the ground track ----------------------------------------------------------------
  const tiles = {};
  // The two map sources, each off until its button is tapped. USGS serves its tiles as z/y/x.
  const MAPS = {
    streets: { maxZoom: 19, credit: "© OpenStreetMap contributors", failed: false,
      url: function (z, x, y) { return "https://tile.openstreetmap.org/" + z + "/" + x + "/" + y + ".png"; } },
    aerial: { maxZoom: 16, credit: "USGS The National Map", failed: false,
      url: function (z, x, y) { return "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/" + z + "/" + y + "/" + x; } }
  };
  let onTile = null;
  function tile(source, z, x, y) {
    const key = source + "/" + z + "/" + x + "/" + y;
    if (!tiles[key]) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () { img.ready = true; if (onTile) onTile(); };
      img.onerror = function () { MAPS[source].failed = true; if (onTile) onTile(); };
      img.src = MAPS[source].url(z, x, y);
      tiles[key] = img;
    }
    return tiles[key];
  }

  function drawTrack(ctx, W, H, f, d, o) {
    const i0 = lowerBound(f.gps.t, -2), i1 = Math.min(f.gps.t.length - 1, lowerBound(f.gps.t, d.tLanding));
    let minE = 0, maxE = 0, minN = 0, maxN = 0;
    for (let i = i0; i <= i1; i++) {
      minE = Math.min(minE, d.east[i]); maxE = Math.max(maxE, d.east[i]);
      minN = Math.min(minN, d.north[i]); maxN = Math.max(maxN, d.north[i]);
    }
    const pad = 44, scale = Math.min((W - 2 * pad) / (maxE - minE || 1), (H - 2 * pad) / (maxN - minN || 1));
    const cx = W / 2 - (minE + maxE) / 2 * scale, cy = H / 2 + (minN + maxN) / 2 * scale;
    const PX = function (e) { return cx + e * scale; }, PY = function (n) { return cy - n * scale; };

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#f6f4ef"; ctx.fillRect(0, 0, W, H);
    const step = niceStep(Math.max(maxE - minE, maxN - minN), 4);
    let mapDrawn = false;
    const src = MAPS[o.map];
    if (src && !src.failed) {
      // Slippy-map tiles under the same metre grid: pick the zoom whose pixels are closest, then stretch.
      const cosLat = Math.cos(f.pad.lat * Math.PI / 180);
      const zf = Math.log2(scale * 40075016.686 * cosLat / 256), z = Math.max(1, Math.min(src.maxZoom, Math.floor(zf)));
      const k = Math.pow(2, zf - z), world = 256 * Math.pow(2, z);
      const X0 = (f.pad.lon + 180) / 360 * world;
      const lat = f.pad.lat * Math.PI / 180, Y0 = (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * world;
      const tx0 = Math.floor((X0 - cx / k) / 256), tx1 = Math.floor((X0 + (W - cx) / k) / 256);
      const ty0 = Math.floor((Y0 - cy / k) / 256), ty1 = Math.floor((Y0 + (H - cy) / k) / 256);
      for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
        const img = tile(o.map, z, tx, ty);
        if (img.ready) { ctx.drawImage(img, cx + (tx * 256 - X0) * k, cy + (ty * 256 - Y0) * k, 256 * k + 0.5, 256 * k + 0.5); mapDrawn = true; }
      }
      if (mapDrawn) { ctx.fillStyle = o.map === "aerial" ? "rgba(255,255,255,.12)" : "rgba(255,255,255,.3)"; ctx.fillRect(0, 0, W, H); }
    }
    if (!mapDrawn) {
      ctx.strokeStyle = "#dedad0"; ctx.lineWidth = 1;
      for (let e = Math.floor((0 - cx) / scale / step) * step; PX(e) < W; e += step) {
        ctx.beginPath(); ctx.moveTo(Math.round(PX(e)) + 0.5, 0); ctx.lineTo(Math.round(PX(e)) + 0.5, H); ctx.stroke();
      }
      for (let n = Math.floor((cy - H) / scale / step) * step; PY(n) > 0; n += step) {
        ctx.beginPath(); ctx.moveTo(0, Math.round(PY(n)) + 0.5); ctx.lineTo(W, Math.round(PY(n)) + 0.5); ctx.stroke();
      }
    }

    // The path. Where GPS was lost the two known ends are joined with a dashed line.
    const path = function (from, to, dashed) {
      ctx.setLineDash(dashed ? [5, 5] : []); ctx.beginPath();
      for (let i = from; i <= to; i++) { if (i === from) ctx.moveTo(PX(d.east[i]), PY(d.north[i])); else ctx.lineTo(PX(d.east[i]), PY(d.north[i])); }
      ctx.strokeStyle = C.card; ctx.lineWidth = dashed ? 0 : 6; if (!dashed) ctx.stroke();
      ctx.strokeStyle = C.nav; ctx.lineWidth = dashed ? 2 : 3; ctx.stroke(); ctx.setLineDash([]);
    };
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    let from = i0;
    for (let i = i0 + 1; i <= i1; i++) {
      const lost = f.gpsLost.some(function (g) { return f.gps.t[i - 1] <= g.t0 && f.gps.t[i] >= g.t1; });
      if (lost) { path(from, i - 1, false); path(i - 1, i, true); from = i; }
    }
    path(from, i1, false);

    const label = function (text, x, y, alignRight) {
      ctx.font = "700 13px " + FONT; ctx.textBaseline = "middle"; ctx.textAlign = alignRight ? "right" : "left";
      ctx.lineWidth = 4; ctx.strokeStyle = "rgba(255,255,255,.95)"; ctx.strokeText(text, x, y);
      ctx.fillStyle = C.ink; ctx.fillText(text, x, y);
    };
    const iPeak = Math.min(i1, lowerBound(f.gps.t, d.tPeak));
    const px = PX(0), py = PY(0), ax = PX(d.east[iPeak]), ay = PY(d.north[iPeak]), lx = PX(d.landE), ly = PY(d.landN);
    ctx.fillStyle = C.ink; ctx.strokeStyle = C.card; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, py - 9); ctx.lineTo(px + 8, py + 6); ctx.lineTo(px - 8, py + 6); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ax, ay - 8); ctx.lineTo(ax + 8, ay); ctx.lineTo(ax, ay + 8); ctx.lineTo(ax - 8, ay); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.safe; ctx.beginPath(); ctx.arc(lx, ly, 8, 0, 7); ctx.fill(); ctx.stroke();
    const centred = function (text, x, y) {
      ctx.font = "700 13px " + FONT;
      const half = ctx.measureText(text).width / 2;
      label(text, Math.min(Math.max(x - half, 4), W - 4 - 2 * half), y, false);
    };
    // Pad and apogee are often close together, so one label goes below its mark and the other above.
    const padBelow = py >= ay;
    centred("Pad", px, py + (padBelow ? 19 : -19));
    centred("Apogee", ax, ay + (padBelow ? -19 : 19));
    label("Landing", lx + (lx > W / 2 ? -13 : 13), ly, lx > W / 2);

    if (o.cursor !== undefined && o.cursor >= 0 && o.cursor <= d.tLanding) {
      const e = valueAt(f.gps.t, d.east, o.cursor), n = valueAt(f.gps.t, d.north, o.cursor);
      ctx.fillStyle = C.card; ctx.beginPath(); ctx.arc(PX(e), PY(n), 9, 0, 7); ctx.fill();
      ctx.fillStyle = C.armed; ctx.beginPath(); ctx.arc(PX(e), PY(n), 6, 0, 7); ctx.fill();
    }

    // Scale bar and north arrow.
    const bar = step * scale;
    ctx.strokeStyle = C.ink; ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(12, H - 20); ctx.lineTo(12, H - 14); ctx.lineTo(12 + bar, H - 14); ctx.lineTo(12 + bar, H - 20); ctx.stroke();
    label(step + " m", 12 + bar + 6, H - 16, false);
    ctx.fillStyle = C.ink; ctx.beginPath(); ctx.moveTo(W - 20, 10); ctx.lineTo(W - 13, 28); ctx.lineTo(W - 20, 24); ctx.lineTo(W - 27, 28); ctx.closePath(); ctx.fill();
    label("N", W - 25, 38, false);
    if (mapDrawn) {
      ctx.font = "10px " + FONT; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      const w = ctx.measureText(src.credit).width;
      ctx.fillStyle = "rgba(255,255,255,.8)"; ctx.fillRect(W - w - 10, H - 16, w + 10, 16);
      ctx.fillStyle = C.dim; ctx.fillText(src.credit, W - 5, H - 8);
    }
    return { mapDrawn: mapDrawn };
  }

  // ---- the page ---------------------------------------------------------------------------------
  // One flight is shown at a time. mount() can be called again with another flight; the controls are
  // wired once and always act on the current one.
  let f = null, d = null, ui = null, WHOLE = null, ASCENT = null, bands = [], marks = [], landText = "", wired = false;
  const charts = [];
  const RECORD_NAMES = { gps_pvt: "GPS fixes", trk_baro: "Barometer samples",
    trk_nav: "Navigation results", reported_state: "Flight state", decision: "Flight decisions", trk_event: "Flight events",
    trk_command: "Commands", trk_command_outcome: "Command answers", command_state: "Command counter", text_line: "Text lines",
    time_model: "Time model updates", marker: "Marks", trk_restart: "Restart records", trk_decision: "Flight decisions",
    logger_health: "Logger health", log_density: "Logging density", retrieval_profile: "Retrieval profile",
    flight_header: "Log header", log_name: "Log name", gps_week: "GPS week", gps_health: "GPS health", baro_health: "Barometer health",
    health_board: "Health facts", power_level: "Power level", link_stats: "Link statistics" };

  function fit(cv) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }
  const shortMarks = function () { return marks.map(function (m) { return { t: m.t, label: m.label.split(" ")[0] }; }); };
  const altSeries = function () {
    const s = [];
    if (ui.gps) s.push({ t: f.gps.t, v: f.gps.h, color: C.gps, width: 1.5, gap: 1.5 });
    if (ui.baro) s.push({ t: f.baro.t, v: f.baro.alt, color: C.baro, width: 1.5 });
    s.push({ t: f.nav.t, v: f.nav.alt, color: C.nav, width: 2.5 });
    return s;
  };
  const BUILDERS = {
    "fr-alt": function () { return { x0: ui.win[0], x1: ui.win[1], series: altSeries(), bands: bands, marks: marks, unit: "m", cursor: ui.cursor, hatch: ui.gps ? f.gpsLost : [] }; },
    "fr-vs": function () { return { x0: ui.win[0], x1: ui.win[1], series: [{ t: f.nav.t, v: f.nav.vs, color: C.nav, width: 2.5 }], bands: bands, marks: shortMarks(), unit: "m/s", cursor: ui.cursor }; },
    "fr-sv": function () {
      const t = f.gps.t.slice(), v = f.gps.sv.slice();
      f.gpsLost.forEach(function (g) { const i = lowerBound(t, g.t0 + 1e-6); t.splice(i, 0, g.t0 + 0.01, g.t1 - 0.01); v.splice(i, 0, 0, 0); });
      return { x0: WHOLE[0], x1: WHOLE[1], series: [{ t: t, v: v, color: C.gps, width: 2, step: true }], bands: bands, marks: shortMarks().slice(0, 2), unit: "satellites", cursor: ui.cursor, hatch: f.gpsLost };
    },
    "fr-diff": function () {
      const t = [], v = [];
      for (let i = 0; i < f.gps.t.length; i++) if (f.gps.t[i] >= WHOLE[0] && f.gps.t[i] <= WHOLE[1]) { t.push(f.gps.t[i]); v.push(valueAt(f.baro.t, f.baro.alt, f.gps.t[i]) - f.gps.h[i]); }
      return { x0: WHOLE[0], x1: WHOLE[1], series: [{ t: t, v: v, color: C.baro, width: 1.5, gap: 1.5 }], bands: bands, marks: shortMarks().slice(0, 2), unit: "m, barometer minus GPS", cursor: ui.cursor, hatch: f.gpsLost };
    }
  };

  function redraw() {
    charts.forEach(function (c) {
      if (!c.cv.offsetParent) return;
      const g = fit(c.cv); c.api = drawChart(g.ctx, g.w, g.h, BUILDERS[c.cv.id]());
    });
    const tv = $("fr-track");
    if (tv.offsetParent && f.gps.t.length) {
      const g = fit(tv), r = drawTrack(g.ctx, g.w, g.h, f, d, { cursor: ui.cursor, map: ui.map });
      $("fr-mapnote").textContent = !MAPS[ui.map] ? "" : MAPS[ui.map].failed ? "The map could not be loaded here. It needs an internet connection." : r.mapDrawn ? "" : "Loading the map…";
    }
    const t = ui.cursor === undefined ? d.tPeak : ui.cursor;
    let st = f.states[0].s;
    f.states.forEach(function (s) { if (s.t <= t) st = s.s; });
    $("fr-rt").textContent = fmtT(t) + " · " + st.toUpperCase();
    $("fr-rv").textContent = Math.round(valueAt(f.nav.t, f.nav.alt, t)) + " m · " + signed(valueAt(f.nav.t, f.nav.vs, t), 1) + " m/s";
    $("fr-prog").style.width = (100 * Math.min(1, Math.max(0, (t - WHOLE[0]) / (WHOLE[1] - WHOLE[0])))).toFixed(2) + "%";
    $("fr-play").textContent = ui.playing ? "Pause" : "Play";
    $("fr-speed").textContent = ui.speed + "×";
  }

  const press = function (btn, on) { btn.classList.toggle("on", on); btn.setAttribute("aria-pressed", on ? "true" : "false"); };

  function wire() {
    Object.keys(BUILDERS).forEach(function (id) {
      const cv = $(id), c = { cv: cv, api: null };
      const seek = function (ev) { if (c.api) { ui.playing = false; ui.cursor = c.api.timeAt(ev.clientX - cv.getBoundingClientRect().left); redraw(); } };
      cv.addEventListener("pointerdown", function (ev) { cv.setPointerCapture(ev.pointerId); seek(ev); });
      cv.addEventListener("pointermove", function (ev) { if (ev.buttons || ev.pointerType === "touch") seek(ev); });
      charts.push(c);
    });
    onTile = redraw;

    let last = 0;
    function frame(now) {
      if (!ui.playing) return;
      ui.cursor += Math.min(0.1, (now - last) / 1000) * ui.speed; last = now;
      if (ui.cursor >= WHOLE[1]) { ui.cursor = WHOLE[1]; ui.playing = false; }
      redraw();
      if (ui.playing) requestAnimationFrame(frame);
    }
    $("fr-play").addEventListener("click", function () {
      ui.playing = !ui.playing;
      if (ui.playing) {
        if (ui.cursor === undefined || ui.cursor >= WHOLE[1]) ui.cursor = WHOLE[0];
        last = performance.now(); requestAnimationFrame(frame);
      }
      redraw();
    });
    $("fr-speed").addEventListener("click", function () { ui.speed = ui.speed === 1 ? 4 : ui.speed === 4 ? 16 : 1; redraw(); });

    const pair = function (a, b, pick) {
      $(a).addEventListener("click", function () { pick(true); press($(a), true); press($(b), false); redraw(); });
      $(b).addEventListener("click", function () { pick(false); press($(a), false); press($(b), true); redraw(); });
    };
    pair("fr-w-whole", "fr-w-ascent", function (first) { ui.win = first ? WHOLE : ASCENT; });
    pair("fr-v-flight", "fr-v-diag", function (first) { $("fr-flight").hidden = !first; $("fr-diag").hidden = first; });
    const MAP_BUTTONS = { "fr-map-off": "off", "fr-map-streets": "streets", "fr-map-aerial": "aerial" };
    Object.keys(MAP_BUTTONS).forEach(function (id) {
      $(id).addEventListener("click", function () {
        ui.map = MAP_BUTTONS[id];
        if (MAPS[ui.map]) MAPS[ui.map].failed = false;       // a new tap tries again
        Object.keys(MAP_BUTTONS).forEach(function (other) { press($(other), other === id); });
        redraw();
      });
    });
    [["fr-k-baro", "baro"], ["fr-k-gps", "gps"]].forEach(function (p) {
      $(p[0]).addEventListener("click", function () { ui[p[1]] = !ui[p[1]]; press($(p[0]), ui[p[1]]); redraw(); });
    });

    // Share picture: the summary, the height chart and the track as one image.
    $("fr-share").addEventListener("click", function () {
      const K = 3, W = 360, H = 800, cv = document.createElement("canvas");
      cv.width = W * K; cv.height = H * K;
      const ctx = cv.getContext("2d"); ctx.scale(K, K);
      ctx.fillStyle = C.ground; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = C.flight; ctx.fillRect(0, 0, W, 132);
      ctx.fillStyle = "#fff"; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
      ctx.font = "700 12px " + FONT; ctx.fillText("HT-G4 FLIGHT" + (f.meta.demo ? " · DEMO DATA" : f.meta.sim ? " · SIM" : ""), 16, 28);
      ctx.font = "800 54px " + FONT; ctx.fillText($("fr-apogee").textContent, 16, 84);
      ctx.font = "600 15px " + FONT; ctx.fillText($("fr-when").textContent, 16, 112);
      const cells = [["Top speed", Math.round(d.maxVs) + " m/s"], ["To apogee", fmtDur(d.tPeak)], ["Descent", d.descentRate.toFixed(1) + " m/s"], ["Drift " + d.compass, Math.round(d.drift) + " m"]];
      cells.forEach(function (c, i) {
        const x = 12 + i * 85;
        ctx.fillStyle = C.card; ctx.beginPath(); ctx.roundRect(x, 144, 81, 56, 10); ctx.fill();
        ctx.fillStyle = C.dim; ctx.font = "600 11px " + FONT; ctx.fillText(c[0], x + 8, 164);
        ctx.fillStyle = C.ink; ctx.font = "800 15px " + FONT; ctx.fillText(c[1], x + 8, 186);
      });
      const block = function (y, h, draw) {
        ctx.fillStyle = C.card; ctx.beginPath(); ctx.roundRect(12, y, W - 24, h, 12); ctx.fill();
        ctx.save(); ctx.translate(12, y); ctx.beginPath(); ctx.roundRect(0, 0, W - 24, h, 12); ctx.clip(); draw(W - 24, h); ctx.restore();
      };
      block(212, 230, function (w, h) { drawChart(ctx, w, h, { x0: WHOLE[0], x1: WHOLE[1], series: [{ t: f.nav.t, v: f.nav.alt, color: C.nav, width: 2.5 }], bands: bands, marks: marks, unit: "m above the pad" }); });
      if (f.gps.t.length) block(454, 310, function (w, h) { drawTrack(ctx, w, h, f, d, { map: ui.map }); });
      ctx.fillStyle = C.dim; ctx.font = "12px " + FONT; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
      if (landText) ctx.fillText("Landing " + landText, 16, 786);
      const out = $("fr-shareout"), img = $("fr-shareimg");
      let url;
      try { url = cv.toDataURL("image/png"); } catch (e) { $("fr-sharenote").textContent = "The picture could not be made with the map on. Turn the map off and try again."; out.hidden = false; return; }
      img.src = url; out.hidden = false;
      $("fr-sharenote").textContent = "Press and hold the picture to save or send it.";
      cv.toBlob(function (blob) {
        const file = blob && typeof File === "function" ? new File([blob], f.meta.name + ".png", { type: "image/png" }) : null;
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) navigator.share({ files: [file], title: "HT-G4 flight" }).catch(function () {});
      });
      out.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    // Open a saved log file. A file that can't be read leaves the flight on screen as it was.
    $("fr-file").addEventListener("change", function () {
      const file = $("fr-file").files[0], note = $("fr-filenote");
      if (!file) return;
      if (!root.FlightLog || !root.HTG4Msg) { note.textContent = "This preview only shows the demo flight."; return; }
      file.arrayBuffer().then(function (buf) {
        mount(root.FlightLog.build(new Uint8Array(buf), root.HTG4Msg));
        note.textContent = "Showing " + file.name + ".";
      }).catch(function (e) { note.textContent = "Could not read " + file.name + ": " + e.message; });
    });

    window.addEventListener("resize", redraw);
  }

  function mount(flight) {
    f = flight; d = derive(f);
    const launched = !f.meta.noLaunch;
    WHOLE = launched ? [-5, d.tLanding + 10] : [f.tStart, f.tEnd];
    ASCENT = launched ? [-2, d.tApogee + 6] : WHOLE;
    ui = { win: WHOLE, baro: true, gps: true, cursor: undefined, playing: false, speed: 4, map: "off" };
    if (!wired) { wire(); wired = true; }
    press($("fr-w-whole"), true); press($("fr-w-ascent"), false);
    [["fr-k-baro", true], ["fr-k-gps", true], ["fr-map-off", true], ["fr-map-streets", false], ["fr-map-aerial", false]].forEach(function (p) { press($(p[0]), p[1]); });
    ["fr-tiles", "fr-timeline", "fr-gpsfacts", "fr-logfacts", "fr-records", "fr-text"].forEach(function (id) { $(id).textContent = ""; });
    $("fr-shareout").hidden = true;

    // Header
    $("fr-name").textContent = f.meta.name;
    $("fr-apogee").textContent = Math.round(d.apogeeAlt) + " m";
    let when = launched ? "above the pad" : "highest, no launch in this log";
    if (f.meta.launchUtcMs !== null && launched) {
      const at = new Date(f.meta.launchUtcMs);
      when += " · " + at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) + ", " + at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }
    $("fr-when").textContent = when;
    $("fr-demo").hidden = !f.meta.demo;
    $("fr-sim").hidden = !f.meta.sim;
    $("fr-navnote").hidden = !f.meta.navFromBaro;

    const dash = function (v, text) { return isFinite(v) ? text : "—"; };
    [["Top speed", dash(d.maxVs, Math.round(d.maxVs) + " m/s")], ["Time to apogee", dash(d.tPeak, fmtDur(Math.max(0, d.tPeak)))],
     ["Descent rate", dash(d.descentRate, d.descentRate.toFixed(1) + " m/s")], ["Flight time", dash(d.tTouch, fmtDur(Math.max(0, d.tTouch)))]].forEach(function (p) {
      const t = el("div", "tile"); t.appendChild(el("div", "tk", p[0])); t.appendChild(el("div", "tv", launched ? p[1] : "—")); $("fr-tiles").appendChild(t);
    });

    bands = [];
    f.states.forEach(function (s, i) {
      if (BAND[s.s]) bands.push({ t0: s.t, t1: i + 1 < f.states.length ? f.states[i + 1].t : f.tEnd, label: s.s.toUpperCase(), fill: BAND[s.s] });
    });
    marks = launched ? [{ t: 0, label: "Launch" }, { t: d.tApogee, label: "Apogee " + Math.round(d.apogeeAlt) + " m" }, { t: d.tTouch, label: "Touchdown" }] : [];

    // Track facts and map links
    const hasTrack = f.gps.t.length > 0;
    $("fr-trackcard").hidden = !hasTrack; $("fr-notrack").hidden = hasTrack;
    landText = "";
    if (hasTrack) {
      const lat = d.landLat.toFixed(6), lon = d.landLon.toFixed(6);
      landText = lat + ", " + lon;
      $("fr-drift").textContent = Math.round(d.drift) + " m toward " + d.compass + " (" + Math.round(d.bearing) + "°)";
      $("fr-landpos").textContent = landText;
      $("fr-landfix").textContent = dash(d.landSv, d.landSv + " satellites") + dash(d.landHdop, ", DOP " + (d.landHdop || 0).toFixed(1)).replace("—", "");
      $("fr-geo").href = "geo:" + lat + "," + lon + "?q=" + lat + "," + lon + "(Landing)";
      $("fr-gmaps").href = "https://www.google.com/maps/search/?api=1&query=" + lat + "," + lon;
    }

    // Timeline
    const rows = [];
    f.marks.forEach(function (m) { rows.push({ t: m.t, k: "log", text: { open: "Log opened", reboot: "Restart, log resumed", close: "Log closed", overflow: "Flight area full, logging moved to the landed area" }[m.kind] || m.kind }); });
    f.commands.forEach(function (c) { rows.push({ t: c.t - 0.001, k: "cmd", text: c.name, sub: c.result }); });
    if (launched) {
      rows.push({ t: 0, k: "ev", text: "Launch detected" });
      rows.push({ t: d.tApogee, k: "ev", text: "Apogee, " + Math.round(d.apogeeAlt) + " m" });
      rows.push({ t: d.tTouch, k: "ev", text: "Touchdown", sub: "from the height trace" });
      if (f.events.some(function (e) { return e.kind === "landing"; })) rows.push({ t: d.tLanding, k: "ev", text: "Landing confirmed, retrieval starts" });
    }
    f.gpsLost.forEach(function (g) { rows.push({ t: g.t0, k: "warn", text: "GPS fix lost for " + (g.t1 - g.t0).toFixed(1) + " s" }); });
    rows.sort(function (a, b) { return a.t - b.t; });
    rows.forEach(function (r) {
      const row = el("div", "trow k-" + r.k);
      row.appendChild(el("span", "tt", fmtT(r.t)));
      const what = el("span", "tw", r.text);
      if (r.sub) what.appendChild(el("span", "ts", r.sub));
      row.appendChild(what); $("fr-timeline").appendChild(row);
    });

    // Diagnostics
    const kv = function (box, k, v, cls) { const r = el("div", "row"); r.appendChild(el("span", "k", k)); r.appendChild(el("span", "v " + (cls || ""), v)); $(box).appendChild(r); };
    const flightDop = f.gps.hdop.filter(function (h, i) { return f.gps.t[i] >= 0 && f.gps.t[i] <= d.tTouch && isFinite(h); });
    const lostS = f.gpsLost.reduce(function (s, g) { return s + g.t1 - g.t0; }, 0);
    kv("fr-gpsfacts", "Fixes in flight", String(f.gps.t.filter(function (t) { return t >= 0 && t <= d.tTouch; }).length));
    kv("fr-gpsfacts", "Fix lost in flight", lostS ? lostS.toFixed(1) + " s" : "never", lostS ? "v-warn" : "");
    kv("fr-gpsfacts", "Worst DOP in flight", flightDop.length ? Math.max.apply(null, flightDop).toFixed(1) : "—");
    kv("fr-logfacts", "Log", (f.meta.logId === null ? "—" : "#" + f.meta.logId) + (f.meta.board ? ", " + f.meta.board : ""));
    kv("fr-logfacts", "Firmware", f.meta.firmware || "—");
    kv("fr-logfacts", "Size", (f.meta.bytes / 1024).toFixed(0) + " KiB");
    kv("fr-logfacts", "Length", fmtDur(f.tEnd - f.tStart));
    kv("fr-logfacts", "Damaged bytes skipped", String(f.meta.skippedBytes), f.meta.skippedBytes ? "v-warn" : "");
    kv("fr-logfacts", "Restarts", String(f.marks.filter(function (m) { return m.kind === "reboot"; }).length));
    kv("fr-logfacts", "Flight area overflow", f.marks.some(function (m) { return m.kind === "overflow"; }) ? "yes" : "no");
    const total = f.records.reduce(function (s, r) { return s + r.bytes; }, 0);
    f.records.slice().sort(function (a, b) { return b.bytes - a.bytes; }).forEach(function (r) {
      const row = el("div", "rec");
      row.appendChild(el("span", "rn", RECORD_NAMES[r.name] || r.name));
      row.appendChild(el("span", "rc", r.count.toLocaleString() + " · " + (r.bytes / 1024).toFixed(1) + " KiB"));
      const bar = el("span", "rb"); bar.style.width = (100 * r.bytes / total).toFixed(1) + "%"; row.appendChild(bar);
      $("fr-records").appendChild(row);
    });
    f.text.forEach(function (l) {
      const row = el("div", "tx"); row.appendChild(el("span", "tt", fmtT(l.t))); row.appendChild(el("span", "", l.scope + ": " + l.text)); $("fr-text").appendChild(row);
    });

    redraw();
  }

  // The control page's View flight button opens this page with the log's blob: address after the #.
  function openFromAddress() {
    const from = (root.location && root.location.hash || "").slice(1);
    if (from.indexOf("blob:") !== 0) return;
    fetch(from).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
      mount(root.FlightLog.build(new Uint8Array(buf), root.HTG4Msg));
      $("fr-filenote").textContent = "Showing the log from the control page.";
    }).catch(function (e) {
      $("fr-filenote").textContent = "Could not show the log from the control page (" + e.message + "). Save it there and open the file here.";
    });
  }

  root.FlightReview = { mount: mount, derive: derive, openFromAddress: openFromAddress };
  if (typeof module !== "undefined") module.exports = root.FlightReview;
})(typeof window !== "undefined" ? window : globalThis);
