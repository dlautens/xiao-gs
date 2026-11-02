/* BLE down envelope from the ground station (firmware/apps/gs/main/gs_envelope.hpp), plus the page's
 * link bookkeeping. The LoRa packet itself is decoded by proto/gen/htg4_msg.js (HTG4Msg.decodeWire);
 * nothing here knows the packet layout. Browser: globalThis.GsEnvelope; Node: module.exports. */
(function () {
  "use strict";
  const MAGIC = 0x47;
  const TYPE_RAW_LORA = 2;
  const HEADER = 4;
  const TRAILER = 12;
  const AGE_NONE = 0xffff;
  // A19 pad downlink period is 5 s; a packet older than two periods is shown as stale.
  const STALE_AFTER_S = 10;

  function parse(buf) {
    const dv = buf instanceof DataView ? buf : new DataView(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
    if (dv.byteLength < HEADER) return { err: "short envelope (" + dv.byteLength + " B)" };
    const magic = dv.getUint8(0);
    const type = dv.getUint8(1);
    const len = dv.getUint16(2, true);
    if (magic !== MAGIC) return { err: "bad envelope magic 0x" + magic.toString(16) };
    if (HEADER + len > dv.byteLength) return { err: "truncated envelope, len " + len };
    if (type !== TYPE_RAW_LORA) return { err: "envelope type " + type + " not handled", skip: true };
    if (len < TRAILER) return { err: "type 2 len " + len + " < " + TRAILER };
    const pktLen = len - TRAILER;
    const t = HEADER + pktLen;
    return {
      packet: new Uint8Array(dv.buffer, dv.byteOffset + HEADER, pktLen),
      rssiDbm: dv.getInt16(t, true),
      snrDb: dv.getInt16(t + 2, true) / 4,
      ageS: dv.getUint16(t + 4, true) === AGE_NONE ? null : dv.getUint16(t + 4, true) / 100,
      rxOk: dv.getUint16(t + 6, true),
      rxCrcErr: dv.getUint16(t + 8, true),
      rxRejected: dv.getUint16(t + 10, true),
    };
  }

  // Downlink loss from seq gaps (A19-4). Counts each new seq once; wraps at 16 bits.
  function LossCounter() {
    this.last = null;
    this.got = 0;
    this.missed = 0;
  }
  LossCounter.prototype.add = function (seq) {
    if (this.last === seq) return;
    if (this.last !== null) {
      const gap = (seq - this.last - 1 + 65536) % 65536;
      if (gap < 1000) this.missed += gap; // a larger jump is a tracker reboot, not loss
    }
    this.last = seq;
    this.got += 1;
  };
  LossCounter.prototype.percent = function () {
    const n = this.got + this.missed;
    return n === 0 ? 0 : (100 * this.missed) / n;
  };

  // New vs repeat: rx_ok counts accepted packets at the GS, so an unchanged rx_ok is a keepalive
  // repeat of the last packet (gs_envelope.hpp). Returns true for a new packet.
  function RepeatFilter() { this.lastRxOk = null; }
  RepeatFilter.prototype.isNew = function (env) {
    if (env.packet.length === 0) return false;
    const fresh = this.lastRxOk === null || env.rxOk !== this.lastRxOk;
    this.lastRxOk = env.rxOk;
    return fresh;
  };

  const GsEnvelope = { parse, LossCounter, RepeatFilter, STALE_AFTER_S, TYPE_RAW_LORA };
  if (typeof module !== "undefined" && module.exports) module.exports = GsEnvelope;
  if (typeof globalThis !== "undefined") globalThis.GsEnvelope = GsEnvelope;
})();
