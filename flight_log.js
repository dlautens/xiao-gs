/* Turns a saved flight log file into the flight object flight_review.js draws.
 * Records are read with the generated codec (proto/gen/htg4_msg.js, decodeLog); this file only
 * decides what each record means for the picture. It reads the bus-topic records the logger is
 * records (trk_nav, trk_baro, gps_pvt, reported_state, trk_event, trk_command, time_model) and the
 * log's own marks, header, name and text lines. */
(function (root) {
  "use strict";

  const GPS_EPOCH_MS = Date.UTC(1980, 0, 6), WEEK_S = 604800;
  const COMMAND_NAMES = { arm: "Arm", disarm: "Disarm", unlock: "Rocket found, unlock", ack_warning: "Ack warning",
    sim_on: "Sim on", sim_off: "Sim off", sim_boost: "Sim launch" };
  const FIND_NAMES = { 1: "Turn on rocket Bluetooth", 2: "Beep" };

  function median(a) {
    if (!a.length) return NaN;
    const s = a.slice().sort(function (x, y) { return x - y; });
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }
  const ascii = function (bytes) { return String.fromCharCode.apply(null, Array.from(bytes).filter(function (b) { return b >= 32 && b < 127; })); };

  function build(bytes, M) {
    M = M || root.HTG4Msg;
    const log = M.decodeLog(bytes), recs = log.records;
    if (!recs.length) throw new Error("This file holds no flight log records.");
    const T = M.TABLE;
    const bus = function (name) { return T.layouts.find(function (l) { return l.name === name && l.version === T.current[name]; }); };
    const logType = function (name) { return T.log.types.find(function (t) { return t.name === name; }); };
    const field = function (lay, name) { return lay.fields.find(function (f) { return f.name === name; }); };
    const en = function (lay, name, v) { return M.enumName(field(lay, name), v); };
    const bit = function (lay, name, v, b) { return ((v >> field(lay, name).bits[b]) & 1) === 1; };

    // Pass 1: a restart sets the board clock back to zero, so split the log into boots where the
    // record time steps backwards. GPS time at board time zero is one number per boot, which lines the
    // boots up on one clock. It comes from the recorded time model, or from the fixes' time of week.
    let boot = 0, prev = null;
    const bootOf = new Array(recs.length), itowMinusBoard = [[]], modelAtZero = [null], bootEnd = [0];
    const TM = bus("time_model"), GPS = bus("gps_pvt");
    recs.forEach(function (r, i) {
      const s = Number(r.t_us) / 1e6;
      if (prev !== null && s < prev - 1) { boot++; itowMinusBoard.push([]); modelAtZero.push(null); bootEnd.push(0); }
      prev = s; bootOf[i] = boot;
      bootEnd[boot] = Math.max(bootEnd[boot], s);
      if (!r.values) return;
      if (r.name === "gps_pvt" && en(GPS, "fix_type", r.values.fix_type) !== "none") itowMinusBoard[boot].push(r.values.itow_ms / 1000 - s);
      if (r.name === "time_model" && bit(TM, "flags", r.values.flags, "valid")) modelAtZero[boot] = Number(r.values.gps_offset_us) / 1e6;
    });
    const inWeek = modelAtZero.map(function (m, b) { return m !== null ? m % WEEK_S : median(itowMinusBoard[b]); });
    const shift = [0];
    for (let b = 1; b <= boot; b++) {
      let known = -1;
      for (let j = b - 1; j >= 0 && known < 0; j--) if (!isNaN(inWeek[j])) known = j;
      if (known >= 0 && !isNaN(inWeek[b])) {
        let d = inWeek[b] - inWeek[known];
        if (d < -WEEK_S / 2) d += WEEK_S;
        shift[b] = shift[known] + d;
      } else {
        shift[b] = shift[b - 1] + bootEnd[b - 1];          // no GPS to measure the gap: join end to start
      }
    }
    const at = function (i) { return Number(recs[i].t_us) / 1e6 + shift[bootOf[i]]; };

    // Pass 2: sort each record into the flight's series, on log time (seconds since the first boot).
    const nav = { t: [], alt: [], vs: [], poor: [] }, baro = { t: [], alt: [] };
    const gps = { t: [], lat: [], lon: [], h: [], sv: [], hdop: [] }, noFix = [];
    const states = [], events = [], marks = [], text = [], cmds = {}, cmdOrder = [], counts = {};
    let meta = { demo: false, sim: false, name: "", logId: null, board: "", firmware: "", launchUtcMs: null,
      bytes: bytes.length, skippedBytes: log.skipped, restarts: boot, navFromBaro: false, noLaunch: false };
    let week = null, leap = 18, oldMarks = [], oldStates = [], tFirst = null, tLast = null;
    const L = { nav: bus("trk_nav"), baro: bus("trk_baro"), gps: bus("gps_pvt"), st: bus("reported_state"), ev: bus("trk_event"),
      cmd: bus("trk_command"), out: bus("trk_command_outcome"), mark: logType("marker"), dec: bus("trk_decision") };
    const uplinkCmd = M.fieldOf("lora_uplink", "cmd"), cmdResult = M.fieldOf("lora_packet", "cmd_result");

    recs.forEach(function (r, i) {
      const key = r.name || "type 0x" + r.type.toString(16);
      counts[key] = counts[key] || { name: key, count: 0, bytes: 0 };
      counts[key].count++; counts[key].bytes += T.log.head.size + r.payload.length + 4;
      const t = at(i), v = r.values;
      if (i > 0 && bootOf[i] !== bootOf[i - 1]) marks.push({ t: t, kind: "reboot" });
      if (tFirst === null) tFirst = t;
      tLast = t;
      if (!v) return;
      switch (r.name) {
        case "flight_header":
          meta.logId = v.log_id; meta.sim = v.sim_bit === 1; meta.firmware = ascii(v.firmware_bytes);
          if (!marks.some(function (m) { return m.kind === "open"; })) marks.push({ t: t, kind: "open" });
          break;
        case "log_name": meta.name = ascii(v.name.slice(0, v.name_len)); break;
        case "gps_week": if (v.rx_valid) { week = v.week; leap = v.leap_s; } break;
        case "trk_nav":
          if (!bit(L.nav, "valid", v.valid, "alt")) break;
          nav.t.push(t); nav.alt.push(v.alt_agl_m);
          nav.vs.push(bit(L.nav, "valid", v.valid, "vel_d") ? -v.vel_n_mps[2] : NaN);
          nav.poor.push(en(L.nav, "quality", v.quality) !== "good");
          break;
        case "trk_baro": baro.t.push(t); baro.alt.push(v.alt_std_atm_m); break;
        case "gps_pvt": {
          const kind = en(L.gps, "fix_type", v.fix_type);
          if (kind === "none" || kind === "time_only" || bit(L.gps, "flags", v.flags, "invalid_llh")) { noFix.push(t); break; }
          gps.t.push(t); gps.lat.push(v.lat_e7 / 1e7); gps.lon.push(v.lon_e7 / 1e7); gps.h.push(v.h_msl_mm / 1000);
          gps.sv.push(v.num_sv); gps.hdop.push(v.pdop_x100 / 100);
          break;
        }
        case "reported_state": {
          const s = en(L.st, "state", v.state);
          if (s && (!states.length || states[states.length - 1].s !== s)) states.push({ t: t, s: s });
          break;
        }
        case "trk_decision": case "decision": oldStates.push({ t: t, s: en(L.dec, "to_state", v.to_state) }); break;
        case "trk_event": {
          const kind = en(L.ev, "event", v.event);
          if (!kind || kind === "none") break;
          const e = { t: Number(v.event_t_us) / 1e6 + shift[bootOf[i]], kind: kind };
          if (kind === "apogee") e.alt = v.peak_alt_m;
          if (!events.some(function (x) { return x.kind === kind; })) events.push(e);
          break;
        }
        case "marker": oldMarks.push({ t: t, kind: en(L.mark, "kind", v.kind) }); break;
        case "trk_command": {
          const c = M.enumName(uplinkCmd, v.cmd);
          if (c === "keepalive") break;
          cmds[v.ticket] = { t: t, name: c === "find" ? (FIND_NAMES[v.find] || "Find") : COMMAND_NAMES[c] || c || "command " + v.cmd, result: "no answer in the log" };
          cmdOrder.push(v.ticket);
          break;
        }
        case "trk_command_outcome": if (cmds[v.ticket]) cmds[v.ticket].result = (M.enumName(cmdResult, v.result) || "result " + v.result).replace(/_/g, " "); break;
        case "text_line": {
          const body = r.payload.subarray(6);
          text.push({ t: t, scope: ascii(body.subarray(0, v.scope_len)), text: ascii(body.subarray(v.scope_len, v.scope_len + v.text_len)) });
          break;
        }
        default: break;
      }
    });
    // A log may carry the flight's events and states as marks and decision records.
    oldMarks.forEach(function (m) {
      if (m.kind === "launch" || m.kind === "apogee" || m.kind === "landing") {
        if (!events.some(function (e) { return e.kind === m.kind; })) events.push({ t: m.t, kind: m.kind });
      } else if (m.kind === "reboot") {
        if (!marks.some(function (x) { return x.kind === "reboot" && Math.abs(x.t - m.t) < 5; })) marks.push(m);
      } else if (m.kind === "close" || m.kind === "unlock" || m.kind === "overflow") {
        marks.push({ t: m.t, kind: m.kind === "unlock" ? "close" : m.kind });
      }
    });
    if (!states.length) oldStates.forEach(function (s) { if (s.s && (!states.length || states[states.length - 1].s !== s.s)) states.push(s); });
    if (!states.length) states.push({ t: tFirst, s: "safe" });
    events.sort(function (a, b) { return a.t - b.t; });

    // Everything moves to seconds from Launch. A log with no launch keeps its own start as zero.
    const launch = events.find(function (e) { return e.kind === "launch"; });
    const t0 = launch ? launch.t : tFirst;
    meta.noLaunch = !launch;
    const rel = function (arr) { for (let k = 0; k < arr.length; k++) arr[k] -= t0; };
    [nav.t, baro.t, gps.t, noFix].forEach(rel);
    [states, events, marks, text].forEach(function (list) { list.forEach(function (x) { x.t -= t0; }); });
    const commands = cmdOrder.map(function (k) { cmds[k].t -= t0; return cmds[k]; });
    marks.sort(function (a, b) { return a.t - b.t; });

    // Heights become height above the pad: the reference is what each sensor read just before launch.
    const before = function (ts, vs) {
      const out = [];
      for (let k = 0; k < ts.length; k++) if (launch ? (ts[k] > -60 && ts[k] < -1) : k < 20) out.push(vs[k]);
      return out.length ? out : vs.slice(0, 1);
    };
    const baroRef = median(before(baro.t, baro.alt)), gpsRef = median(before(gps.t, gps.h));
    for (let k = 0; k < baro.alt.length; k++) baro.alt[k] -= baroRef;
    for (let k = 0; k < gps.h.length; k++) gps.h[k] -= gpsRef;
    const pad = { lat: median(before(gps.t, gps.lat)), lon: median(before(gps.t, gps.lon)), hMsl: gpsRef };

    if (!nav.t.length && baro.t.length) {            // no navigation records: stand the barometer in for them
      meta.navFromBaro = true;
      for (let k = 0; k < baro.t.length; k++) {
        let a = k, z = k;
        while (a > 0 && baro.t[k] - baro.t[a - 1] <= 0.5) a--;
        while (z < baro.t.length - 1 && baro.t[z + 1] - baro.t[k] <= 0.5) z++;
        let sum = 0;
        for (let j = a; j <= z; j++) sum += baro.alt[j];
        nav.t.push(baro.t[k]); nav.alt.push(sum / (z - a + 1));
        nav.vs.push(z > a ? (baro.alt[z] - baro.alt[a]) / (baro.t[z] - baro.t[a]) : 0); nav.poor.push(false);
      }
    }
    if (!nav.t.length) throw new Error("This log has no height records (navigation or barometer), so there is no flight to draw.");
    for (let k = 0; k < nav.vs.length; k++) if (isNaN(nav.vs[k])) nav.vs[k] = k ? nav.vs[k - 1] : 0;

    // GPS lost: fixes more than 1.5 s apart while the rocket was flying.
    const flying = function (t) {
      let s = states[0].s;
      states.forEach(function (x) { if (x.t <= t) s = x.s; });
      return s === "boost" || s === "descent";
    };
    const gpsLost = [];
    for (let k = 1; k < gps.t.length; k++) {
      if (gps.t[k] - gps.t[k - 1] > 1.5 && flying(gps.t[k - 1]) && flying(gps.t[k])) gpsLost.push({ t0: gps.t[k - 1], t1: gps.t[k] });
    }

    // Launch as a clock time: GPS time at a boot's board time zero, from the time model, or from the
    // GPS week and the fixes' time of week. Log time is that boot's board time plus its shift.
    for (let b = 0; b <= boot && meta.launchUtcMs === null; b++) {
      const zero = modelAtZero[b] !== null ? modelAtZero[b] : week !== null && !isNaN(inWeek[b]) ? week * WEEK_S + inWeek[b] : null;
      if (zero !== null) meta.launchUtcMs = GPS_EPOCH_MS + (zero - shift[b] + t0 - leap) * 1000;
    }
    if (!meta.name) meta.name = meta.logId === null ? "log" : "log " + meta.logId;

    return {
      meta: meta, pad: pad, tStart: tFirst - t0, tEnd: tLast - t0,
      nav: nav, baro: baro, gps: gps, states: states, events: events, marks: marks, commands: commands,
      gpsLost: gpsLost, text: text,
      records: Object.keys(counts).map(function (k) { return counts[k]; })
    };
  }

  root.FlightLog = { build: build };
  if (typeof module !== "undefined") module.exports = root.FlightLog;
})(typeof window !== "undefined" ? window : globalThis);
