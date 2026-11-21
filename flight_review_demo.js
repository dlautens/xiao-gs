/* A made-up flight for the flight review page, until a real log exists.
 * It returns the same flight object the log decoder will hand the page (see flight_review.js,
 * "The flight object"). Nothing here is measured: a point-mass rocket on a parachute in wind,
 * sampled the way the Tracker's sensors would report it on the 0.x board (GPS and barometer,
 * no accelerometer). Same seed, same flight. */
(function (root) {
  "use strict";

  function rng(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function demoFlight() {
    const rand = rng(20261121);
    const gauss = function () {
      const u = Math.max(rand(), 1e-9), v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    // The truth: 0.52 kg rocket, about 110 N s of motor, parachute out 1.2 s after the top.
    const DT = 0.01, MASS = 0.52, G = 9.80665, DRAG = 0.0004, CHUTE_SPEED = 6.6;
    const chuteDrag = MASS * G / (CHUTE_SPEED * CHUTE_SPEED);
    const thrust = function (t) {
      if (t < 0.05) return 95 * t / 0.05;
      if (t < 1.4) return 95 - 35 * (t - 0.05) / 1.35;
      if (t < 1.5) return 60 * (1.5 - t) / 0.1;
      return 0;
    };
    const wind = function (alt) {                     // blows toward east-north-east, veering with height
      const speed = 3.2 + 0.0022 * alt, dir = (68 - 0.02 * alt) * Math.PI / 180;
      return { e: speed * Math.sin(dir), n: speed * Math.cos(dir) };
    };
    const Z = [], VZ = [], E = [], N = [];
    let z = 0, vz = 0, e = 0, n = 0, ve = 0, vn = 0, tDeploy = Infinity, tApogeeTrue = 0, t = 0;
    for (;;) {
      Z.push(z); VZ.push(vz); E.push(e); N.push(n);
      const chute = t >= tDeploy;
      const k = chute ? chuteDrag * Math.min(1, (t - tDeploy) / 0.6 + 0.05) : DRAG;
      const a = thrust(t) / MASS - G - (k / MASS) * vz * Math.abs(vz);
      vz += a * DT; z += vz * DT;
      if (z < 0 && t < 1) { z = 0; vz = Math.max(vz, 0); }
      const w = wind(z);
      if (chute) {                                    // under the parachute it drifts with the wind
        const sway = 0.5 * Math.sin(t * 1.3);
        ve += ((w.e + sway) - ve) * DT / 2; vn += ((w.n - sway * 0.6) - vn) * DT / 2;
      } else if (z > 0) {                             // going up it leans a little into the wind
        ve = -0.05 * vz * w.e / 4; vn = -0.05 * vz * w.n / 4;
      }
      e += ve * DT; n += vn * DT;
      t += DT;
      if (tDeploy === Infinity && vz < 0 && t > 2) { tApogeeTrue = t; tDeploy = t + 1.2; }
      if (z <= 0 && t > 5) break;
    }
    const iLaunch = Z.findIndex(function (h) { return h > 20; });   // the detector's 20 m rule
    const T_OFF = iLaunch * DT;
    const at = function (arr, tt) {
      const i = Math.round((tt + T_OFF) / DT);
      return i < 0 ? arr[0] : i >= arr.length ? arr[arr.length - 1] : arr[i];
    };
    const tTouch = (Z.length - 1) * DT - T_OFF;

    // The log's own story, in seconds from Launch.
    const T_OPEN = -420, T_REBOOT = -300, T_ARM = -95, T_LAND = tTouch + 30;
    const T_FIND = tTouch + 780, T_UNLOCK = tTouch + 1500, T_END = T_UNLOCK;
    const PAD = { lat: 38.789, lon: -97.652, hMsl: 372 };
    const stateAt = function (tt) {
      if (tt < T_ARM) return "safe";
      if (tt < 0) return "armed";
      if (tt < tApogeeTrue - T_OFF + 0.9) return "boost";
      if (tt < T_LAND) return "descent";
      return "retrieval";
    };
    const rebooting = function (tt) { return tt >= T_REBOOT && tt < T_REBOOT + 3; };
    const sample = function (periodFor, each) {
      for (let tt = T_OPEN + 2; tt < T_END; ) {
        const p = periodFor(tt, stateAt(tt));
        if (!rebooting(tt)) each(tt);
        tt += p;
      }
    };
    const retrievalPeriod = function (tt) {           // 5 s for a minute, then waking less and less often
      const since = tt - T_LAND;
      if (since < 60) return 5;
      return Math.min(900, 60 * Math.pow(2, Math.floor(Math.log2(1 + (since - 60) / 60))));
    };
    const GPS_LOST_FROM = 0.25, GPS_LOST_TO = 5.8;

    const nav = { t: [], alt: [], vs: [], poor: [] };
    let navNoise = 0;
    sample(function (tt, s) { return { safe: 1, armed: 0.5, boost: 0.05, descent: 0.1, retrieval: retrievalPeriod(tt) }[s]; },
      function (tt) {
        navNoise = 0.9 * navNoise + 0.1 * gauss();
        nav.t.push(tt); nav.alt.push(at(Z, tt) + 0.8 * navNoise);
        nav.vs.push(at(VZ, tt) + 0.25 * gauss()); nav.poor.push(tt > GPS_LOST_FROM && tt < GPS_LOST_TO);
      });

    const baro = { t: [], alt: [] };
    const tEject = tDeploy - T_OFF;
    sample(function (tt, s) { return { safe: 1, armed: 0.2, boost: 0.04, descent: 0.1, retrieval: retrievalPeriod(tt) }[s]; },
      function (tt) {
        const puff = tt > tEject && tt < tEject + 0.14 ? -9 : 0;   // the ejection charge pressurises the tube
        baro.t.push(tt); baro.alt.push(at(Z, tt) + 0.55 * gauss() + 0.4 * Math.sin(tt / 40) + puff);
      });

    const gps = { t: [], lat: [], lon: [], h: [], sv: [], hdop: [] };
    const M_PER_DEG = 111194.9;
    sample(function (tt, s) { return { safe: 10, armed: 1, boost: 0.1, descent: 0.2, retrieval: retrievalPeriod(tt) }[s]; },
      function (tt) {
        if (tt > GPS_LOST_FROM && tt < GPS_LOST_TO) return;
        const lag = 0.15, back = tt - GPS_LOST_TO;
        const sv = back > 0 && back < 16 ? Math.round(8 + back / 2) : 16 + Math.round(rand() * 2);
        gps.t.push(tt);
        gps.lat.push(PAD.lat + (at(N, tt - lag) + 0.6 * gauss()) / M_PER_DEG);
        gps.lon.push(PAD.lon + (at(E, tt - lag) + 0.6 * gauss()) / (M_PER_DEG * Math.cos(PAD.lat * Math.PI / 180)));
        gps.h.push(at(Z, tt - lag) + 1.4 + 2.2 * gauss());
        gps.sv.push(sv); gps.hdop.push(Math.round((0.55 + 5 / sv + 0.05 * rand()) * 100) / 100);
      });

    const apogeeAlt = Math.max.apply(null, nav.alt);
    const tApogee = nav.t[nav.alt.indexOf(apogeeAlt)] + 1.0;      // called after 1 s of falling
    const count = function (s) { return s.t.length; };
    const records = [
      { name: "gps_pvt", count: count(gps), each: 56 },
      { name: "trk_baro", count: count(baro), each: 28 },
      { name: "trk_nav", count: count(nav), each: 44 },
      { name: "reported_state", count: 9, each: 36 },
      { name: "trk_command", count: 3, each: 30 },
      { name: "health_board", count: 212, each: 32 },
      { name: "time_model", count: 96, each: 36 },
      { name: "text_line", count: 9, each: 72 },
      { name: "marker", count: 3, each: 20 }
    ];
    records.forEach(function (r) { r.bytes = r.count * r.each; delete r.each; });

    return {
      meta: {
        demo: true, sim: false, name: "20261114-201437Z-xiao", logId: 7, board: "XIAO 0.x",
        firmware: "0.9.0-demo", launchUtcMs: Date.UTC(2026, 10, 14, 20, 14, 37),
        bytes: records.reduce(function (s, r) { return s + r.bytes; }, 0),
        skippedBytes: 0, restarts: 1, navFromBaro: false, noLaunch: false
      },
      pad: PAD,
      tStart: T_OPEN, tEnd: T_END,
      nav: nav, baro: baro, gps: gps,
      states: [
        { t: T_OPEN, s: "boot" }, { t: T_OPEN + 2, s: "safe" }, { t: T_REBOOT, s: "boot" }, { t: T_REBOOT + 3, s: "safe" },
        { t: T_ARM, s: "armed" }, { t: 0, s: "boost" }, { t: tApogee, s: "descent" }, { t: T_LAND, s: "retrieval" },
        { t: T_UNLOCK, s: "safe" }
      ],
      events: [
        { t: 0, kind: "launch" }, { t: tApogee, kind: "apogee", alt: apogeeAlt }, { t: T_LAND, kind: "landing" }
      ],
      marks: [
        { t: T_OPEN, kind: "open" }, { t: T_REBOOT, kind: "reboot" }, { t: T_UNLOCK, kind: "close" }
      ],
      commands: [
        { t: T_ARM, name: "Arm", result: "worked" },
        { t: T_FIND, name: "Turn on rocket Bluetooth", result: "worked" },
        { t: T_UNLOCK, name: "Rocket found, unlock", result: "accepted, log closed" }
      ],
      gpsLost: [{ t0: GPS_LOST_FROM, t1: GPS_LOST_TO }],
      text: [
        { t: T_OPEN + 1, scope: "boot", text: "self-test PASS" },
        { t: T_OPEN + 34, scope: "gps", text: "first fix, 3D, 14 satellites" },
        { t: T_REBOOT + 1, scope: "boot", text: "restart on the pad, log resumed" },
        { t: T_ARM, scope: "flight", text: "armed by command 12" },
        { t: 0, scope: "flight", text: "launch: 20 m above the pad" },
        { t: GPS_LOST_FROM + 0.3, scope: "gps", text: "fix lost" },
        { t: GPS_LOST_TO, scope: "gps", text: "fix regained, 8 satellites" },
        { t: tApogee, scope: "flight", text: "apogee: falling for 1 s" },
        { t: T_LAND, scope: "flight", text: "landing: slower than 1 m/s for 30 s" }
      ],
      records: records
    };
  }

  root.FlightReviewDemo = { demoFlight: demoFlight };
  if (typeof module !== "undefined") module.exports = root.FlightReviewDemo;
})(typeof window !== "undefined" ? window : globalThis);
