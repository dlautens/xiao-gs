/* Phone side of the 0.x LoRa commands (issue #325).
 * Pure: HMAC and the display strings. The page supplies HTG4Msg.encodeWire
 * and writes the up characteristic. No unlock command is built here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.FlightCmd = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const KEY = [0xA1, 0x19, 0x00, 0x58, 0x47, 0x34, 0x0A, 0x19, 0xC0, 0xDE, 0x4B, 0x1E, 0x9A, 0x11, 0x58, 0x41];
  const STORE = "htg4.a19.replay";
  const CMD = {
    arm: 1, disarm: 2, sim_set: 3, sim_clear: 4, sim_boost: 5, ble_wake: 6, hold: 8, ack: 9,
  };
  const PHASE = { safe: 1, armed_pad: 2, boost: 3, descent_drogue: 5, landed: 7 };
  const FLAG = {
    guide_stale: 1 << 0,
    sim: 1 << 6,
    ble_on: 1 << 7,
    accepted: 1 << 8,
    bad_mac: 1 << 9,
    replay: 1 << 10,
    phase: 1 << 11,
    nogo: 1 << 12,
    need_ack: 1 << 13,
    pyro: 1 << 14,
    unlock_refused: 1 << 15,
  };
  const WAKE_BLE = 1;
  let memoryCounter = 0;

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function sha256(msg) {
    const bytes = msg instanceof Uint8Array ? msg : Uint8Array.from(msg);
    const k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const bitLen = bytes.length * 8;
    const total = bytes.length + 1 + 8;
    const padded = Math.ceil(total / 64) * 64;
    const block = new Uint8Array(padded);
    block.set(bytes);
    block[bytes.length] = 0x80;
    const view = new DataView(block.buffer);
    view.setUint32(padded - 4, bitLen >>> 0, false);
    view.setUint32(padded - 8, Math.floor(bitLen / 0x100000000), false);
    const w = new Uint32Array(64);
    for (let off = 0; off < padded; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + k[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach(function (word, i) { ov.setUint32(i * 4, word, false); });
    return out;
  }

  function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function macOf(msg) {
    const block = 64;
    const key = Uint8Array.from(KEY);
    const ipad = new Uint8Array(block);
    const opad = new Uint8Array(block);
    for (let i = 0; i < block; i++) {
      const b = i < key.length ? key[i] : 0;
      ipad[i] = b ^ 0x36;
      opad[i] = b ^ 0x5c;
    }
    const inner = sha256(concat(ipad, msg instanceof Uint8Array ? msg : Uint8Array.from(msg)));
    return sha256(concat(opad, inner)).slice(0, 8);
  }

  function storage() {
    try {
      if (typeof localStorage !== "undefined" && localStorage) return localStorage;
    } catch (e) { /* private mode */ }
    return null;
  }

  function loadCounter() {
    const box = storage();
    if (!box) return memoryCounter;
    const raw = box.getItem(STORE);
    const n = raw == null ? 0 : Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  function saveCounter(n) {
    memoryCounter = n;
    const box = storage();
    if (box) box.setItem(STORE, String(n));
  }

  /* guide_age_ds still carries the last accepted replay counter when the Guide is
   * stale. cmd_echo is the last processed command, including one the XIAO refused
   * without consuming the counter, so it must not move the next-counter floor. */
  function noteEcho(low16, stale) {
    let n = loadCounter();
    if (stale && n <= 0xffff && low16 > n) {
      n = low16 >>> 0;
      saveCounter(n);
    }
    return n;
  }

  function uplinkCounter(bytes) {
    if (!bytes || bytes.length < 8) return null;
    const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    return new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(4, true);
  }

  function echoMatches(echo, counter) {
    if (echo == null || counter == null) return false;
    return ((echo >>> 0) & 0xffff) === ((counter >>> 0) & 0xffff);
  }

  function takeCounter() {
    const n = (loadCounter() + 1) >>> 0;
    saveCounter(n);
    return n;
  }

  function encodeCommand(name, counter, wake, codec) {
    const cmd = CMD[name];
    if (cmd == null) throw new Error("unknown command " + name);
    const mac = macOf((function () {
      const head = new Uint8Array(12);
      const dv = new DataView(head.buffer);
      head[0] = 0x58; head[1] = 1; head[2] = 2; head[3] = cmd;
      dv.setUint32(4, counter >>> 0, true);
      head[8] = wake || 0;
      return head;
    })());
    return codec.encodeWire("lora_uplink", {
      type: 2,
      cmd: cmd,
      seq: counter >>> 0,
      wake_opts: wake || 0,
      pad0: [0, 0, 0],
      mac: Array.from(mac),
    });
  }

  /* One result bit at a time on the wire. The first match is the line the page shows. */
  function commandStatus(flags) {
    if ((flags & FLAG.bad_mac) !== 0) return "refused: bad MAC";
    if ((flags & FLAG.replay) !== 0) return "replay";
    if ((flags & FLAG.phase) !== 0) return "refused: wrong phase";
    if ((flags & FLAG.nogo) !== 0) return "refused: NO-GO";
    if ((flags & FLAG.need_ack) !== 0) return "refused: ack warnings first";
    if ((flags & FLAG.pyro) !== 0) return "refused: pyro";
    if ((flags & FLAG.unlock_refused) !== 0) return "refused: unlock";
    if ((flags & FLAG.accepted) !== 0) return "accepted";
    return "";
  }

  /* Settle only when cmd_echo matches this command's counter. A fresh safe report
   * does not clear a pending arm. A disarm is dropped when the phase is already
   * pad safe, the same exception the Heltec relay uses before it transmits. */
  function afterDownlink(pendingName, phase, flags, fresh, echo, counter) {
    let name = pendingName || null;
    const match = echoMatches(echo, counter);
    if (fresh && name === "disarm" && phase === PHASE.safe) name = null;
    else if (fresh && name && match && commandSettled(name, phase, flags)) name = null;
    return {
      pending: name,
      label: flightLabel({ pending: name, fresh: fresh === true, phase: fresh ? phase : null }),
    };
  }

  function hardRefuse(flags) {
    const hard = FLAG.bad_mac | FLAG.phase | FLAG.nogo | FLAG.need_ack | FLAG.pyro | FLAG.unlock_refused;
    return (flags & hard) !== 0 && (flags & FLAG.replay) === 0;
  }

  function commandSettled(name, phase, flags) {
    const refused = hardRefuse(flags);
    if (name === "arm") {
      return phase === PHASE.armed_pad || phase === PHASE.boost || phase === PHASE.descent_drogue ||
        phase === PHASE.landed || refused;
    }
    if (name === "disarm") return phase === PHASE.safe || (flags & FLAG.accepted) !== 0 || refused;
    if (name === "sim_set") return (flags & FLAG.sim) !== 0 || refused;
    if (name === "sim_clear") return (phase === PHASE.safe && (flags & FLAG.sim) === 0) || refused;
    if (name === "sim_boost") {
      return phase === PHASE.boost || phase === PHASE.descent_drogue || phase === PHASE.landed || refused;
    }
    if (name === "ble_wake") return (flags & FLAG.ble_on) !== 0 || refused;
    if (name === "hold" || name === "ack") return (flags & FLAG.accepted) !== 0 || refused;
    return refused;
  }

  /* pending "arm" stays "armed (unconfirmed)" until a fresh armed/flight report.
   * A missing or stale packet is "armed". "safe" only from a fresh safe report. */
  function flightLabel(view) {
    const fresh = view.fresh === true && view.phase != null;
    const moved = fresh && (view.phase === PHASE.armed_pad || view.phase === PHASE.boost ||
      view.phase === PHASE.descent_drogue || view.phase === PHASE.landed);
    if (view.pending === "arm" && !moved) return "armed (unconfirmed)";
    if (!fresh) return "armed";
    if (view.phase === PHASE.armed_pad) return "armed (confirmed)";
    if (view.phase === PHASE.safe) return "safe";
    if (view.phase === PHASE.boost) return "flight";
    if (view.phase === PHASE.descent_drogue) return "descent";
    if (view.phase === PHASE.landed) return "recovery";
    return "armed";
  }

  return {
    KEY: KEY, CMD: CMD, PHASE: PHASE, FLAG: FLAG, WAKE_BLE: WAKE_BLE,
    sha256: sha256, macOf: macOf, loadCounter: loadCounter, saveCounter: saveCounter,
    noteEcho: noteEcho, uplinkCounter: uplinkCounter, echoMatches: echoMatches,
    takeCounter: takeCounter, encodeCommand: encodeCommand,
    commandSettled: commandSettled, commandStatus: commandStatus, afterDownlink: afterDownlink,
    flightLabel: flightLabel,
  };
});
