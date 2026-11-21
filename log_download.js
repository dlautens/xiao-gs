/* XIAO flight-log download (#265). Separate from the Heltec XIAO-GS link in gs_envelope.js.
 * Wire layout is logdl.hpp. Browser: globalThis.LogDownload. Node: module.exports.
 * The page saves the file in the browser. It does not upload it anywhere. */
(function () {
  "use strict";
  const DEVICE_NAME = "XIAO-LOG";
  const SERVICE = "8aa1c001-c0de-4b1e-9a11-58414f2d4753";
  const STATUS = "8aa1c002-c0de-4b1e-9a11-58414f2d4753";
  const CONTROL = "8aa1c003-c0de-4b1e-9a11-58414f2d4753";
  const DATA = "8aa1c004-c0de-4b1e-9a11-58414f2d4753";
  const UNLOCK = "8aa1c005-c0de-4b1e-9a11-58414f2d4753";
  const UNLOCK_BYTES = 18;
  const PAYLOAD = 200;
  const MTU = 247;
  const VERSION = 1;
  const HEADER = 14;
  const STATUS_BYTES = 16;
  const CONTROL_BYTES = 12;
  const OPCODE_RESUME = 1;
  const OPCODE_ABORT = 2;
  const OPCODE_CONFIRM = 3;
  const OPCODE_DISCARD = 4;
  const FLAG_LAST = 1;
  const FLAG_CORRUPT = 2;
  const FLAG_TRUNCATED = 4;
  const DENY_ARMED = 1;
  const DENY_GROUND = 2;
  const CRC_POLY = 0xedb88320;

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit++) {
        const mask = -(crc & 1);
        crc = (crc >>> 1) ^ (CRC_POLY & mask);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function viewOf(buf) {
    if (buf instanceof DataView) return buf;
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function parseStatus(buf) {
    const dv = viewOf(buf);
    if (dv.byteLength < STATUS_BYTES) return { err: "short status" };
    return {
      version: dv.getUint8(0),
      deny: dv.getUint8(1),
      flags: dv.getUint8(2),
      radio: dv.getUint8(3),
      logId: dv.getUint32(4, true),
      sizeBytes: dv.getUint32(8, true),
      chunkPayload: dv.getUint16(12, true),
      attMtu: dv.getUint16(14, true),
    };
  }

  function parseChunk(buf) {
    const dv = viewOf(buf);
    if (dv.byteLength < HEADER) return { err: "short chunk" };
    const length = dv.getUint16(4, true);
    if (HEADER + length > dv.byteLength) return { err: "truncated chunk" };
    const payload = new Uint8Array(dv.buffer, dv.byteOffset + HEADER, length);
    return {
      offset: dv.getUint32(0, true),
      length: length,
      seq: dv.getUint16(6, true),
      flags: dv.getUint8(8),
      crc: dv.getUint32(10, true),
      payload: payload,
    };
  }

  function encodeControl(opcode, logId, offset) {
    const out = new Uint8Array(CONTROL_BYTES);
    const dv = new DataView(out.buffer);
    dv.setUint8(0, opcode);
    dv.setUint32(4, logId, true);
    dv.setUint32(8, offset >>> 0, true);
    return out;
  }

  function encodeChunk(offset, seq, flags, payload) {
    const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const out = new Uint8Array(HEADER + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, offset >>> 0, true);
    dv.setUint16(4, body.length, true);
    dv.setUint16(6, seq, true);
    dv.setUint8(8, flags);
    dv.setUint32(10, crc32(body), true);
    out.set(body, HEADER);
    return out;
  }

  // Write the relay's signed 18-byte uplink and read the rocket's one-byte cmd_result.
  // The characteristic decides nothing; the board's unlock core does.
  function exchangeUnlock(ch, bytes) {
    const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (body.length !== UNLOCK_BYTES) return Promise.reject(new Error("signed unlock is 18 bytes"));
    const write = ch.writeValueWithResponse ? ch.writeValueWithResponse(body) : ch.writeValue(body);
    return Promise.resolve(write).then(function () { return ch.readValue(); }).then(function (got) {
      const dv = viewOf(got);
      if (dv.byteLength < 1) throw new Error("rocket returned no unlock result");
      return dv.getUint8(0);
    });
  }

  let rocket = null;
  function sendToRocket(bytes) {
    if (typeof navigator === "undefined" || !navigator.bluetooth) {
      return Promise.reject(new Error("no Web Bluetooth"));
    }
    const ready = rocket && rocket.gatt ? Promise.resolve(rocket) : navigator.bluetooth.requestDevice({
      filters: [{ name: DEVICE_NAME }],
      optionalServices: [SERVICE],
    }).then(function (dev) { rocket = dev; return dev; });
    return ready.then(function (dev) {
      const link = dev.gatt.connected ? Promise.resolve(dev.gatt) : dev.gatt.connect();
      return link.then(function (server) { return server.getPrimaryService(SERVICE); })
        .then(function (svc) { return svc.getCharacteristic(UNLOCK); })
        .then(function (ch) { return exchangeUnlock(ch, bytes); });
    });
  }

  function denyText(deny) {
    if (deny === DENY_ARMED) return "download refused: armed";
    if (deny === DENY_GROUND) return "download refused: not on the ground";
    if (deny !== 0) return "download refused: code " + deny;
    return "";
  }

  /* Clear the tracker's stored log. Confirm is sent only for a log this page holds in full,
   * after the user saved it. Discard drops a log with no copy. Both name the log id, and the
   * tracker checks it against the log on flash and clears nothing on a mismatch. */
  function confirmText(logId, bytes) {
    return "Saved " + bytes + " bytes of log " + (logId >>> 0) + ". Let the tracker reuse its flash?";
  }

  function discardText(logId) {
    return "Discard log " + (logId >>> 0) + " WITHOUT a copy? This cannot be undone.";
  }

  function Receiver(sizeBytes) {
    this.sizeBytes = sizeBytes;
    this.offset = 0;
    this.parts = [];
    this.done = sizeBytes === 0;
    this.corrupt = false;
    this.truncated = false;
  }

  Receiver.prototype.accept = function (chunk) {
    if (chunk.err) return { ok: false, reason: chunk.err };
    if (crc32(chunk.payload) !== chunk.crc) return { ok: false, reason: "crc" };
    if (chunk.offset + chunk.payload.length === this.offset) return { ok: true, duplicate: true };
    if (chunk.offset !== this.offset) return { ok: false, reason: "offset" };
    this.parts.push(new Uint8Array(chunk.payload));
    this.offset += chunk.payload.length;
    if (chunk.flags & FLAG_CORRUPT) this.corrupt = true;
    if (chunk.flags & FLAG_TRUNCATED) this.truncated = true;
    if (chunk.flags & FLAG_LAST || (this.sizeBytes !== 0 && this.offset >= this.sizeBytes)) this.done = true;
    return { ok: true };
  };

  Receiver.prototype.bytes = function () {
    const out = new Uint8Array(this.offset);
    let at = 0;
    this.parts.forEach(function (part) {
      out.set(part, at);
      at += part.length;
    });
    return out;
  };

  const LOG_SYNC = 0x4cc3;
  const LOG_NAME_TYPE = 0x000b;
  const LOG_HEADER = 16; // proto/log_record.yaml version 2
  const LOG_CRC = 4;
  const LOG_PAYLOAD_MAX = 1024;
  const LOG_NAME_MAX = 46;

  function nameChar(c) {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;
  }

  function nameInLog(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let found = "";
    let off = 0;
    while (off + LOG_HEADER + LOG_CRC <= data.length) {
      const sync = data[off] | (data[off + 1] << 8);
      if (sync !== LOG_SYNC) {
        off += 1;
        continue;
      }
      const type = data[off + 2] | (data[off + 3] << 8);
      const len = data[off + 6] | (data[off + 7] << 8);
      const frame = LOG_HEADER + len + LOG_CRC;
      if (len > LOG_PAYLOAD_MAX || off + frame > data.length) {
        off += 1;
        continue;
      }
      const body = data.subarray(off, off + LOG_HEADER + len);
      const crcAt = off + LOG_HEADER + len;
      const crc = (data[crcAt] | (data[crcAt + 1] << 8) | (data[crcAt + 2] << 16) | (data[crcAt + 3] << 24)) >>> 0;
      if (crc32(body) !== crc) {
        off += 1;
        continue;
      }
      if (type === LOG_NAME_TYPE && len >= 2) {
        const nameLen = data[off + LOG_HEADER + 1];
        if (nameLen > 0 && nameLen <= LOG_NAME_MAX && 2 + nameLen <= len) {
          let text = "";
          let ok = true;
          for (let i = 0; i < nameLen; i++) {
            const c = data[off + LOG_HEADER + 2 + i];
            if (!nameChar(c)) {
              ok = false;
              break;
            }
            text += String.fromCharCode(c);
          }
          if (ok) found = text;
        }
      }
      off += frame;
    }
    return found;
  }

  function fileName(logId, bytes) {
    const named = bytes ? nameInLog(bytes) : "";
    if (named) return named + ".bin";
    let hex = (logId >>> 0).toString(16);
    while (hex.length < 8) hex = "0" + hex;
    return "htg4-log-" + hex + ".bin";
  }

  // The flight review page's address for a log held in this page's memory (a blob: address).
  function reviewAddress(blobUrl) {
    return "flight_review.html#" + blobUrl;
  }

  function saveFile(name, bytes) {
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  function bind(ids) {
    const $ = function (id) { return document.getElementById(id); };
    const button = $(ids.button);
    const save = $(ids.save);
    const confirmBtn = $(ids.confirm);
    const discardBtn = $(ids.discard);
    const status = $(ids.status);
    const error = $(ids.error);
    let receiver = null;
    let logId = 0;
    let device = null;
    let saved = false;

    function setStatus(text, ok) {
      status.textContent = text;
      status.className = ok === true ? "ok" : ok === false ? "bad" : "";
    }

    function progress() {
      if (!receiver) return "idle";
      const span = receiver.corrupt || receiver.truncated ? " (log contains a damaged record)" : "";
      if (receiver.done) return receiver.offset + " bytes" + span;
      return receiver.offset + " / " + receiver.sizeBytes + span;
    }

    async function onChunk(event) {
      const parsed = parseChunk(event.target.value);
      const result = receiver.accept(parsed);
      if (!result.ok) {
        error.textContent = "chunk " + result.reason + " at " + receiver.offset + "; resume to retry";
        if (device && device.gatt && device.gatt.connected && parsed.offset !== undefined) {
          try {
            const control = await device.gatt.getPrimaryService(SERVICE).then(function (svc) {
              return svc.getCharacteristic(CONTROL);
            });
            await control.writeValue(encodeControl(OPCODE_RESUME, logId, receiver.offset));
          } catch (e) {
            error.textContent = "chunk " + result.reason + "; resume write failed: " + e;
          }
        }
        return;
      }
      error.textContent = "";
      setStatus(progress(), true);
      if (receiver.done) setStatus("complete, " + progress(), true);
    }

    async function connect() {
      if (!navigator.bluetooth) {
        setStatus("no Web Bluetooth (need Chrome, HTTPS)", false);
        return;
      }
      setStatus("picker...");
      try {
        device = await navigator.bluetooth.requestDevice({
          filters: [{ name: DEVICE_NAME }],
          optionalServices: [SERVICE],
        });
        const server = await device.gatt.connect();
        const svc = await server.getPrimaryService(SERVICE);
        const statusChr = await svc.getCharacteristic(STATUS);
        const control = await svc.getCharacteristic(CONTROL);
        const data = await svc.getCharacteristic(DATA);
        const snap = parseStatus(await statusChr.readValue());
        if (snap.err) {
          setStatus(snap.err, false);
          return;
        }
        if (snap.version !== VERSION) {
          setStatus("status version " + snap.version, false);
          return;
        }
        const refused = denyText(snap.deny);
        if (refused) {
          setStatus(refused, false);
          return;
        }
        if (snap.chunkPayload !== PAYLOAD) {
          setStatus("chunk " + snap.chunkPayload + " bytes, page expects " + PAYLOAD, false);
          return;
        }
        if (!receiver || receiver.logId !== snap.logId) {
          receiver = new Receiver(snap.sizeBytes);
          receiver.logId = snap.logId;
          logId = snap.logId;
        }
        data.removeEventListener("characteristicvaluechanged", onChunk);
        data.addEventListener("characteristicvaluechanged", onChunk);
        await data.startNotifications();
        await control.writeValue(encodeControl(OPCODE_RESUME, logId, receiver.offset));
        device.addEventListener("gattserverdisconnected", function () {
          setStatus("disconnected, " + progress(), false);
          button.textContent = "Resume XIAO-LOG";
        });
        button.textContent = "Resume XIAO-LOG";
        setStatus(receiver.done ? "complete, " + progress() : "downloading, " + progress(), true);
      } catch (e) {
        setStatus(String(e), false);
      }
    }

    async function control(opcode, id, offset) {
      if (!device || !device.gatt || !device.gatt.connected) {
        error.textContent = "not connected to XIAO-LOG";
        return false;
      }
      try {
        const svc = await device.gatt.getPrimaryService(SERVICE);
        const chr = await svc.getCharacteristic(CONTROL);
        await chr.writeValue(encodeControl(opcode, id, offset));
        return true;
      } catch (e) {
        error.textContent = "write failed: " + e;
        return false;
      }
    }

    button.addEventListener("click", connect);
    confirmBtn.addEventListener("click", async function () {
      if (!receiver || !receiver.done) {
        error.textContent = "download the whole log first";
        return;
      }
      if (!saved) {
        error.textContent = "save the file first";
        return;
      }
      if (!confirm(confirmText(logId, receiver.offset))) return;
      if (await control(OPCODE_CONFIRM, logId, receiver.offset)) {
        setStatus("confirmed; the tracker clears it when it is on the ground and disarmed", true);
        receiver = null;
        saved = false;
      }
    });
    discardBtn.addEventListener("click", async function () {
      if (!logId) {
        error.textContent = "connect first, to read the log id";
        return;
      }
      if (!confirm(discardText(logId))) return;
      if (await control(OPCODE_DISCARD, logId, 0)) {
        setStatus("discard sent for log " + (logId >>> 0), true);
        receiver = null;
        saved = false;
      }
    });
    save.addEventListener("click", function () {
      if (!receiver) {
        error.textContent = "no log yet";
        return;
      }
      saveFile(fileName(logId, receiver.bytes()), receiver.bytes());
      saved = true;
    });
    // View flight: hand the bytes received so far to the flight review page in a new tab. It reads
    // them from this page's memory while this page stays open; nothing is stored or uploaded.
    const view = ids.view ? $(ids.view) : null;
    if (view) {
      view.addEventListener("click", function () {
        if (!receiver) {
          error.textContent = "no log yet";
          return;
        }
        window.open(reviewAddress(URL.createObjectURL(new Blob([receiver.bytes()], { type: "application/octet-stream" }))), "_blank");
      });
    }
  }

  const LogDownload = {
    DEVICE_NAME: DEVICE_NAME,
    SERVICE: SERVICE,
    STATUS: STATUS,
    CONTROL: CONTROL,
    DATA: DATA,
    UNLOCK: UNLOCK,
    UNLOCK_BYTES: UNLOCK_BYTES,
    reviewAddress: reviewAddress,
    exchangeUnlock: exchangeUnlock,
    sendToRocket: sendToRocket,
    PAYLOAD: PAYLOAD,
    MTU: MTU,
    VERSION: VERSION,
    OPCODE_RESUME: OPCODE_RESUME,
    OPCODE_ABORT: OPCODE_ABORT,
    OPCODE_CONFIRM: OPCODE_CONFIRM,
    OPCODE_DISCARD: OPCODE_DISCARD,
    FLAG_LAST: FLAG_LAST,
    FLAG_CORRUPT: FLAG_CORRUPT,
    FLAG_TRUNCATED: FLAG_TRUNCATED,
    DENY_ARMED: DENY_ARMED,
    DENY_GROUND: DENY_GROUND,
    crc32: crc32,
    parseStatus: parseStatus,
    parseChunk: parseChunk,
    encodeControl: encodeControl,
    encodeChunk: encodeChunk,
    denyText: denyText,
    Receiver: Receiver,
    nameInLog: nameInLog,
    fileName: fileName,
    confirmText: confirmText,
    discardText: discardText,
    bind: bind,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = LogDownload;
  if (typeof globalThis !== "undefined") globalThis.LogDownload = LogDownload;
})();
