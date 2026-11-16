/* BLE down envelope from the ground station (firmware/apps/gs/main/gs_envelope.hpp; type 3, the
 * command report, is gs_cmd.hpp), the command intent the page writes on the up characteristic
 * (gs_cmd.hpp IntentWire), the page's link bookkeeping, and the page viewer (GsEnvelope.Viewer):
 * what each region of index.html shows, as text, from the last envelope, packet and command
 * report. The LoRa packet is decoded by proto/gen/htg4_msg.js (HTG4Msg.decodeWire); the viewer
 * reads fields by name through that codec's table, and the intent takes its command numbers and
 * find bits from the same table (lora_uplink).
 * Browser: globalThis.GsEnvelope; Node: module.exports. */
(function () {
  "use strict";
  const MAGIC = 0x47;
  const TYPE_RAW_LORA = 2;
  const TYPE_COMMAND = 3;
  const HEADER = 4;
  const TRAILER = 12;
  const COMMAND_LEN = 14; // gs_cmd.hpp CommandWire
  const AGE_NONE = 0xffff;
  const CS_PER_S = 100;
  // gs_cmd.hpp IntentWire: u8 magic, u8 version, u8 cmd, u8 channel, u16 code, u8 find, u8 tap.
  const INTENT_MAGIC = 0x43;
  const INTENT_VERSION = 1;
  const INTENT_LEN = 8;
  // Relay hold state in the type 3 report (gs_cmd.hpp HoldState).
  const HOLD = ["idle", "holding", "echoed", "no_reply"];
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
    if (type === TYPE_COMMAND) return parseCommand(dv, len);
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
      rxErr: dv.getUint16(t + 8, true), // CRC + LoRa header errors (one count)
      rxRejected: dv.getUint16(t + 10, true),
    };
  }

  // Type 3: the relay's one command hold (gs_cmd.hpp CommandWire). A longer payload is read by its
  // known prefix, so a later field added at the end does not stop this page.
  function parseCommand(dv, len) {
    if (len < COMMAND_LEN) return { err: "type 3 len " + len + " < " + COMMAND_LEN };
    const c = HEADER;
    const state = dv.getUint8(c);
    return { command: {
      state: HOLD[state] || "state " + state,
      cmd: dv.getUint8(c + 1),
      channel: dv.getUint8(c + 2),
      find: dv.getUint8(c + 3),
      seq: dv.getUint16(c + 4, true),
      code: dv.getUint16(c + 6, true),
      result: dv.getUint8(c + 8),
      tap: dv.getUint8(c + 9),
      refused: dv.getUint8(c + 10) === 1,
      refusedTap: dv.getUint8(c + 11),
      ageS: dv.getUint16(c + 12, true) / CS_PER_S,
    } };
  }

  // One command intent for the up characteristic (apps/gs/README.md "Command contract"). cmd is a
  // lora_uplink command name and find a list of find option names, both from the generated codec.
  // The page does not sign and does not pick a number; tap is the page's own byte.
  function encodeIntent(Msg, intent) {
    const cmdField = Msg.fieldOf("lora_uplink", "cmd");
    const findField = Msg.fieldOf("lora_uplink", "find");
    const cmd = cmdField.enum[intent.cmd];
    if (cmd === undefined) throw new Error("no uplink command " + intent.cmd);
    const find = (intent.find || []).reduce(function (m, name) {
      if (findField.bits[name] === undefined) throw new Error("no find option " + name);
      return m | (1 << findField.bits[name]);
    }, 0);
    const out = new Uint8Array(INTENT_LEN);
    const dv = new DataView(out.buffer);
    dv.setUint8(0, INTENT_MAGIC);
    dv.setUint8(1, INTENT_VERSION);
    dv.setUint8(2, cmd);
    dv.setUint8(3, intent.channel || 0);
    dv.setUint16(4, intent.code || 0, true);
    dv.setUint8(6, find);
    dv.setUint8(7, intent.tap & 0xff);
    return out;
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

  // ---- Page viewer (DECISIONS HG-242) ----
  // The page is a viewer and a sender. It keeps the selected view, the last tap, the Arm confirm
  // step, the find options being chosen and its keepalive timer, and decides nothing: every line
  // below is a field of the last packet, envelope or command report put into words. A tap becomes
  // one intent; the relay holds, signs and retries it, and the rocket decides (HG-241). A view
  // changes only in selectView(), which the page calls from a tab tap, so the screen does not
  // change under the operator's finger.
  const VIEWS = ["pad", "flight", "bench", "link"];
  // Display wording only: "weak" is within about 5 dB of the SF9/BW125 demodulation limit.
  const WEAK_SNR_DB = -7.5;
  const WEAK_RSSI_DBM = -115;
  const INT32_MIN = -2147483648;
  // Display names for the warn bits and the fault_armed reasons (proto/lora_packet.yaml). Which bits
  // are hard stops, the bit numbers and the reason numbers come from the generated codec.
  const WARN = {
    no_gps: "No GPS fix",
    baro_fault: "Baro fault",
    log_warn: "Log space low",
    log_block: "Log space full",
    batt_warn: "Battery low or unknown",
    batt_block: "Battery too low",
    fault_armed: "Fault while armed",
  };
  // One reason number arrives, the most severe by the rocket's rank. The page shows its text.
  const FAULT_REASON = { link_lost: "Link lost 60 s", guide_restarted: "Guide restarted", xiao_restarted: "XIAO restarted" };
  // fault_armed is shown only before launch (GO-NOGO); the rocket clears it at launch detection.
  const BEFORE_LAUNCH = { boot: true, safe: true, armed_pad: true };
  const PHASE = {
    boot: { word: "STARTING", sub: "booting", tone: "idle", text: "starting up" },
    safe: { word: "SAFE", sub: "on pad, not armed", tone: "safe", text: "pad safe" },
    armed_pad: { word: "ARMED", sub: "on pad", tone: "armed", text: "armed on pad" },
    boost: { word: "BOOST", sub: "in flight", tone: "flight", text: "boost" },
    coast: { word: "COAST", sub: "in flight", tone: "flight", text: "coast" },
    descent_drogue: { word: "DESCENT", sub: "under drogue", tone: "flight", text: "descent, drogue" },
    descent_main: { word: "DESCENT", sub: "under main", tone: "flight", text: "descent, main" },
    landed: { word: "LANDED", sub: "on the ground", tone: "landed", text: "landed" },
    fault: { word: "FAULT", sub: "rocket reports a fault", tone: "fault", text: "fault" },
    retrieval: { word: "RETRIEVAL", sub: "landed, waiting to be found", tone: "landed", text: "retrieval" },
  };
  const RETRIEVAL_STEP = ["none", "latched", "find received", "Bluetooth on", "unlock pending"];
  const EMATCH_STATE = ["idle", "enabled", "first held message received", "fired", "cancelled", "refused"];
  const CONT = ["open", "marginal", "ok", "unknown"];
  // The armed keepalive is the page's timer (HG-242): provisional 20 s (David, 2026-11-12). It runs
  // only while the rocket is armed on the pad and the page is in the foreground (PG-3).
  const KEEPALIVE_MS = 20000;
  // Display wording for the command in flight and its outcome (lora_uplink cmd names).
  const CMD = {
    arm: { label: "Arm", doing: "arming" },
    disarm: { label: "Disarm", doing: "disarming" },
    ack_warning: { label: "Ack", doing: "acking" },
    find: { label: "Find", doing: "sending find" },
    sim_on: { label: "Sim on", doing: "turning sim on" },
    sim_off: { label: "Sim off", doing: "turning sim off" },
    sim_boost: { label: "Sim boost", doing: "sim boost" },
    bench_pyro: { label: "Bench pyro", doing: "enabling bench pyro" },
    ematch_enable: { label: "E-match test", doing: "enabling e-match test" },
    fire_held: { label: "Fire held", doing: "holding" },
  };
  // Each cmd_result put into words, with the next step for a refusal (HG-242: a refusal's reason and
  // next step until a new command or a state change). The rocket decides; the page only reads it.
  const RESULT = {
    worked: { text: "worked" },
    wrong_phase: { text: "refused, wrong phase", next: "The rocket does not take this command in its current phase." },
    replay: { text: "refused, old command number", next: "Tap again. The ground station signs the rocket's next number." },
    bad_signature: { text: "refused, bad signature", next: "The ground station and the rocket must be built with the same key file." },
    nogo: { text: "refused, a hard stop is active", next: "Clear the hard stop, then tap again." },
    warn_not_acked: { text: "refused, a warning is not acked", next: "Ack each warning, then tap again." },
    sim_rule: { text: "refused, sim rule", next: "Sim changes only at pad safe." },
    fixture: { text: "refused, a channel does not read its fixture", next: "Check the bench fixtures, then tap again." },
    ematch_setup: { text: "refused, e-match test setup", next: "One channel must read an e-match and every other channel its fixture." },
    held_missed: { text: "refused, a held message was missed", next: "Hold again from the start." },
    channel_locked: { text: "refused, channel locked out", next: "That channel is locked out." },
    busy: { text: "refused, rocket busy", next: "Tap again shortly." },
    not_applied: { text: "not applied", next: "Tap again." },
    moving: { text: "refused, the rocket is moving", next: "Hold the rocket still for 10 s, then tap again." },
    wrong_path: { text: "refused, wrong path", next: "Unlock over Bluetooth or USB, not LoRa." },
  };
  const FIND_OPTS = [["beeper", "Beeper"], ["ble", "Bluetooth"], ["wifi", "Wi-Fi"]];
  const ICON = {
    ok: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3L22.5 21h-21z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/><path d="M12 10v5M12 17.6v.4" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>',
    stop: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2.5h8l5.5 5.5v8L16 21.5H8L2.5 16V8z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/><path d="M8 8l8 8M16 8l-8 8" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>',
    clock: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M12 6.5V12l4 2.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  function esc(t) {
    return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }
  function ageText(s) {
    if (s < 100) return Math.round(s) + " s";
    if (s < 6000) return Math.round(s / 60) + " min";
    return Math.round(s / 3600) + " h";
  }
  function row(k, v, icon) {
    return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v' + (icon ? " v-" + icon : "") + '">' + (icon ? ICON[icon] : "") + esc(v) + "</span></div>";
  }
  function card(title, body, count) {
    return "<h2>" + esc(title) + (count === undefined ? "" : ' <span class="count">' + count + "</span>") + "</h2>" +
      (body ? '<div class="card">' + body + "</div>" : "");
  }
  function chList(mask) {
    const on = [1, 2, 3, 4].filter(function (n) { return (mask >> (n - 1)) & 1; });
    return on.length ? on.map(function (n) { return "channel " + n; }).join(", ") : "none";
  }

  function Viewer(Msg) {
    this.Msg = Msg;
    this.wire = Msg.TABLE.wire.find(function (l) { return l.name === "lora_packet"; });
    this.loss = new LossCounter();
    this.repeats = new RepeatFilter();
    this.view = "pad"; // kept by the page, with the tap and keepalive state below
    this.lastTap = null; // { label, time, tap, status: confirm | cancelled | sending | sent | not_sent, error }
    this.confirmArm = false; // the confirm step before Arm (HG-241)
    // Find options being chosen. Default beeper and Bluetooth: the 0.x retrieval walk-up and the
    // Bluetooth log download and unlock; Wi-Fi download comes later (#331).
    this.findOpts = { beeper: true, ble: true, wifi: false };
    this.keepalive = { lastMs: null, tap: null, error: "" };
    this.cmd = null; // last type 3 command report
    this.cmdAtMs = 0;
    this.outcome = { key: "", phase: null }; // rocket phase when an outcome was first shown
    this.ble = "idle"; // idle | connecting | connected | disconnected
    this.env = null; // last good envelope
    this.envAtMs = 0;
    this.fresh = false;
    this.pkt = null; // last decoded packet
    this.err = "";
    this.unread = false; // the newest packet could not be read (A21-4)
  }
  Viewer.prototype.field = function (name) {
    return this.wire.fields.find(function (f) { return f.name === name; });
  };
  Viewer.prototype.bits = function (name) {
    const set = {};
    if (this.pkt) this.Msg.bitNames(this.field(name), this.pkt[name]).forEach(function (b) { set[b] = true; });
    return set;
  };
  // The only place the view changes. Called from a tab tap.
  Viewer.prototype.selectView = function (name) {
    if (VIEWS.indexOf(name) >= 0) this.view = name;
    return this.view;
  };
  // A tap on a page button. Returns the intent to write ({ cmd, channel, code, find, tap }), or null
  // when the tap only changes what the page shows (the Arm confirm step, a find option). tapByte is
  // the page's own byte for this tap (1-255); the relay echoes it so the page can tell its own
  // refused tap from another phone's.
  Viewer.prototype.press = function (name, arg, timeText, tapByte) {
    const tap = { label: "", time: String(timeText), tap: tapByte, status: "sending", error: "" };
    let intent = null;
    if (name === "find-opt") {
      if (Object.prototype.hasOwnProperty.call(this.findOpts, arg)) this.findOpts[arg] = !this.findOpts[arg];
      return null;
    }
    this.confirmArm = false;
    if (name === "arm") {
      this.confirmArm = true;
      tap.label = "Arm";
      tap.status = "confirm";
    } else if (name === "arm-cancel") {
      tap.label = "Arm";
      tap.status = "cancelled";
    } else if (name === "arm-confirm") {
      tap.label = "Confirm arm";
      intent = { cmd: "arm" };
    } else if (name === "disarm") {
      tap.label = "Disarm";
      intent = { cmd: "disarm" };
    } else if (name === "find") {
      const opts = this.findOpts;
      tap.label = "Find (" + this.findText() + ")";
      intent = { cmd: "find", find: FIND_OPTS.map(function (o) { return o[0]; }).filter(function (k) { return opts[k]; }) };
    } else if (name === "ack") {
      // The ack needs the warning's GO-NOGO code (lora_uplink code). The bit-to-code table is held
      // only by the rocket's cycle library today, so the page has no code to send.
      tap.label = "Ack " + (WARN[arg] || arg);
      tap.status = "not_sent";
      tap.error = "the warning code for an ack is not in the format file yet";
    } else {
      return null;
    }
    this.lastTap = tap;
    if (intent) intent.tap = tapByte;
    return intent;
  };
  // The page reports whether the write reached the ground station. err is "" when it did.
  Viewer.prototype.sent = function (err) {
    if (!this.lastTap) return;
    this.lastTap.status = err ? "not_sent" : "sent";
    this.lastTap.error = err || "";
  };
  Viewer.prototype.findText = function () {
    const opts = this.findOpts;
    const on = FIND_OPTS.filter(function (o) { return opts[o[0]]; }).map(function (o) { return o[1].toLowerCase(); });
    return on.length ? on.join(", ") : "all off";
  };
  // The keepalive timer (HG-242, PG-3). True when the page should write a keepalive now: armed on
  // the pad, Bluetooth up, the page in the foreground, no command held at the relay, and 20 s since
  // the last one. The first period starts when the page first sees the rocket armed, so a reload
  // sends nothing at once (PG-2). Backgrounding pauses it; back in the foreground an overdue
  // keepalive goes at once.
  Viewer.prototype.keepaliveDue = function (nowMs, visible) {
    const k = this.keepalive;
    if (this.rocketState().phase !== "armed_pad" || this.ble !== "connected") {
      k.lastMs = null;
      return false;
    }
    if (k.lastMs === null) {
      k.lastMs = nowMs;
      return false;
    }
    if (!visible || (this.cmd && this.cmd.state === "holding")) return false;
    return nowMs - k.lastMs >= KEEPALIVE_MS;
  };
  Viewer.prototype.keepaliveIntent = function (nowMs, tapByte) {
    this.keepalive.lastMs = nowMs;
    this.keepalive.tap = tapByte;
    this.keepalive.error = "";
    return { cmd: "keepalive", tap: tapByte };
  };
  Viewer.prototype.keepaliveSent = function (err) { this.keepalive.error = err || ""; };
  Viewer.prototype.setBle = function (s) { this.ble = s; };
  Viewer.prototype.onEnvelope = function (env, nowMs) {
    this.err = "";
    if (env.command) {
      this.cmd = env.command;
      this.cmdAtMs = nowMs;
      this.noteOutcome();
      return;
    }
    if (env.err) {
      if (!env.skip) this.err = env.err;
      return;
    }
    this.env = env;
    this.envAtMs = nowMs;
    this.fresh = this.repeats.isNew(env);
    if (!this.fresh) return; // keepalive repeat: link numbers move, the packet does not
    try {
      this.pkt = this.Msg.decodeWire("lora_packet", env.packet);
      this.unread = false;
      this.loss.add(this.pkt.seq);
      if (!this.isGo()) this.confirmArm = false; // the confirm step belongs to the GO view
      this.noteOutcome();
    } catch (e) {
      // A21-4: a packet this page cannot read (wrong version or size) is reported, not shown.
      this.unread = true;
      this.err = "packet not read: " + String(e.message || e);
    }
  };
  // An outcome is shown until a new command or a state change (HG-242). The page notes the rocket
  // phase when it first sees each outcome; a later packet in another phase ends the display.
  Viewer.prototype.noteOutcome = function () {
    const c = this.cmd;
    if (!c || (c.state !== "echoed" && c.state !== "no_reply")) return;
    const key = [c.state, c.cmd, c.seq, c.code, c.find, c.result, c.tap].join(",");
    if (key !== this.outcome.key) this.outcome = { key: key, phase: this.rocketState().phase };
  };
  Viewer.prototype.cmdName = function (value) {
    return this.Msg.enumName(this.Msg.fieldOf("lora_uplink", "cmd"), value);
  };
  Viewer.prototype.cmdLabel = function (c) {
    const name = this.cmdName(c.cmd);
    const known = CMD[name];
    if (!known) return { label: "Command " + c.cmd, doing: "sending command " + c.cmd };
    if (name === "find") {
      const bits = this.Msg.bitNames(this.Msg.fieldOf("lora_uplink", "find"), c.find);
      const opts = FIND_OPTS.filter(function (o) { return bits.indexOf(o[0]) >= 0; }).map(function (o) { return o[1].toLowerCase(); });
      const what = opts.length ? opts.join(", ") : "all off";
      return { label: "Find (" + what + ")", doing: "sending find (" + what + ")" };
    }
    if (name === "ack_warning") return { label: "Ack code 0x" + c.code.toString(16).padStart(4, "0"), doing: "acking" };
    if (name === "ematch_enable" || name === "fire_held") return { label: known.label + " channel " + c.channel, doing: known.doing };
    return known;
  };
  // The command in flight and its outcome, from the relay's type 3 report (HG-241, HG-242). Null
  // when there is nothing to show: no report, Bluetooth down, idle, a keepalive (a keepalive the
  // rocket does not echo is silent; its line is on the armed pad view), or an outcome whose
  // phase has since changed.
  Viewer.prototype.command = function (nowMs) {
    const c = this.cmd;
    if (!c || this.ble !== "connected" || c.state === "idle") return null;
    if (this.cmdName(c.cmd) === "keepalive") return null;
    const lbl = this.cmdLabel(c);
    const age = c.ageS + Math.max(0, nowMs - this.cmdAtMs) / 1000;
    if (c.state === "holding") {
      return { kind: "holding", doing: lbl.doing, text: lbl.label + ": sent to the ground station, waiting for the rocket, " + ageText(age) };
    }
    if (this.outcome.phase !== this.rocketState().phase) return null;
    if (c.state === "no_reply") {
      return { kind: "no_reply", text: lbl.label + ": no reply from the rocket", next: "Check the link, then tap again." };
    }
    if (c.state !== "echoed") return { kind: "no_reply", text: lbl.label + ": relay " + c.state };
    const name = this.Msg.enumName(this.Msg.fieldOf("lora_packet", "cmd_result"), c.result);
    const r = RESULT[name] || { text: "outcome " + c.result + " (not known to this page)" };
    return { kind: name === "worked" ? "worked" : "refused", text: lbl.label + " " + r.text, next: r.next || "" };
  };
  // A tap of this page's that the relay did not send because another command was held (HG-241).
  Viewer.prototype.refusedMine = function () {
    const c = this.cmd;
    return !!c && this.ble === "connected" && c.refused && !!this.lastTap && this.lastTap.status === "sent" && c.refusedTap === this.lastTap.tap;
  };
  // Age of the last packet now: its age at the ground station plus the time since that report.
  Viewer.prototype.ageS = function (nowMs) {
    if (!this.env || this.env.ageS === null) return null;
    return this.env.ageS + Math.max(0, nowMs - this.envAtMs) / 1000;
  };
  Viewer.prototype.linkState = function (nowMs) {
    const age = this.ageS(nowMs);
    const bleUp = this.ble === "connected";
    const stale = age === null || age > STALE_AFTER_S;
    const weak = !!this.env && (this.env.snrDb < WEAK_SNR_DB || this.env.rssiDbm < WEAK_RSSI_DBM);
    const level = !bleUp || stale || this.unread ? "lost" : weak ? "weak" : "healthy";
    const packet = age === null ? "no packet yet" : (level === "lost" ? "last packet " : "packet ") + ageText(age) + " ago";
    const text = "Link " + level + (bleUp ? "" : " · phone not connected") +
      (this.unread ? " · packet not readable, see Link" : "") + " · " + packet;
    return { age: age, stale: stale || this.unread, weak: weak, bleUp: bleUp, level: level, text: text };
  };
  // Rocket state as best known. armedText is the HG-242 GO view wording.
  Viewer.prototype.rocketState = function () {
    if (!this.pkt) return { word: "NO DATA", sub: "no packet yet", tone: "idle", text: "unknown", phase: null };
    const name = this.Msg.enumName(this.field("phase"), this.pkt.phase);
    const ph = PHASE[name] || { word: "PHASE " + this.pkt.phase, sub: "unknown to this page", tone: "idle", text: "phase " + this.pkt.phase };
    const fl = this.bits("flags");
    let sub = ph.sub;
    let text = ph.text;
    if (name === "armed_pad") {
      if (fl.sim) sub = fl.bench_pyro ? "sim, pyro LIVE on bench" : "sim, pyro locked out";
      text = fl.sim ? "armed (" + sub + ")" : "armed on pad";
    } else if (fl.sim) {
      sub += ", sim";
      text += " (sim)";
    }
    // The command in flight beside the state, for example "pad safe (arming)" (HG-242).
    const c = this.cmd;
    if (c && this.ble === "connected" && c.state === "holding" && this.cmdName(c.cmd) !== "keepalive") {
      text += " (" + this.cmdLabel(c).doing + ")";
    }
    return { word: ph.word, sub: sub, tone: ph.tone, text: text, phase: name };
  };
  Viewer.prototype.banners = function () {
    const fl = this.bits("flags");
    if (fl.ematch_test) {
      const ch = this.pkt.ematch & 7;
      return [{ kind: "ematch", text: "LIVE E-MATCH TEST, channel " + (ch || "?") }];
    }
    if (fl.sim && fl.bench_pyro) return [{ kind: "bench", text: "SIM, BENCH PYRO LIVE" }];
    if (fl.sim) return [{ kind: "sim", text: "SIM" }];
    return [];
  };
  // fault_armed: the rocket stays armed and advises a disarm. An ack clears the banner, not the fault.
  Viewer.prototype.faultArmed = function () {
    const bit = this.field("warn").bits.fault_armed;
    const on = !!this.pkt && !!((this.pkt.warn >> bit) & 1) && !!BEFORE_LAUNCH[this.rocketState().phase];
    let reason = "";
    if (on) {
      const f = this.field("fault_armed_reason");
      const name = this.Msg.enumName(f, this.pkt.fault_armed_reason);
      // Reason none with the bit set: no reason is shown, and none is made up.
      if (name !== "none") reason = FAULT_REASON[name] || "Reason " + (this.pkt.fault_armed_reason & f.mask) + " (not known to this page)";
    }
    return { on: on, acked: on && !!((this.pkt.warn_acked >> bit) & 1), reason: reason };
  };
  Viewer.prototype.warnings = function () {
    const out = { hard: [], warn: [] };
    if (!this.pkt) return out;
    const f = this.field("warn");
    const hard = this.Msg.hardStops(f, this.pkt.warn);
    const names = {};
    Object.keys(f.bits).forEach(function (k) { names[f.bits[k]] = k; });
    for (let bit = 0; bit < 16; bit++) {
      if (!((this.pkt.warn >> bit) & 1)) continue;
      const known = WARN[names[bit]];
      const item = {
        bit: bit,
        key: names[bit],
        name: known || "Code " + bit + " (not known to this page)",
        known: !!known,
        acked: !!((this.pkt.warn_acked >> bit) & 1),
      };
      (hard.indexOf(names[bit]) >= 0 ? out.hard : out.warn).push(item);
    }
    return out;
  };

  Viewer.prototype.headHtml = function (nowMs) {
    const st = this.rocketState();
    const ln = this.linkState(nowMs);
    const stale = !!this.pkt && (ln.stale || !ln.bleUp);
    const icon = stale ? "clock" : st.tone === "safe" || st.tone === "landed" ? "ok" : st.tone === "idle" ? "clock" : "warn";
    const lost = stale ? '<div class="lastknown">last known' + (ln.age === null ? "" : ", " + esc(ageText(ln.age)) + " ago") + "</div>" : "";
    return '<div class="pin t-' + st.tone + (stale ? " stale" : "") + '"><div class="state">' + ICON[icon] +
      '<span class="word">' + esc(st.word) + '</span><span class="sub">' + esc(st.sub) + "</span></div>" + lost + this.commandHtml(nowMs) +
      '<div class="linkline l-' + ln.level + '">' + ICON[ln.level === "healthy" ? "ok" : ln.level === "weak" ? "warn" : "stop"] +
      "<span>" + esc(ln.text) + "</span></div></div>";
  };
  // Pinned under the state on every view: the command in flight, then its outcome and next step.
  Viewer.prototype.commandHtml = function (nowMs) {
    const cm = this.command(nowMs);
    const icon = { holding: "clock", worked: "ok", refused: "stop", no_reply: "stop" };
    let out = cm ? '<div class="cmdline c-' + cm.kind + '" role="status">' + ICON[icon[cm.kind]] + "<span>" + esc(cm.text) +
      (cm.next ? '<span class="next">' + esc(cm.next) + "</span>" : "") + "</span></div>" : "";
    if (this.refusedMine()) {
      out += '<div class="cmdline c-refused" role="status">' + ICON.stop + "<span>" + esc(this.lastTap.label) +
        ' not sent: another command was in flight.<span class="next">Not applied, tap again.</span></span></div>';
    }
    return out;
  };
  Viewer.prototype.bannersHtml = function () {
    const fa = this.faultArmed();
    return (fa.on && !fa.acked ? '<div class="banner b-fault" role="alert"><div class="what">' + ICON.stop +
      "<span>FAULT WHILE ARMED: DISARM ADVISED</span></div>" +
      (fa.reason ? '<div class="reason">' + esc(fa.reason) + "</div>" : "") + "</div>" : "") + this.banners().map(function (b) {
      return '<div class="banner b-' + b.kind + '" role="status">' + esc(b.text) + "</div>";
    }).join("");
  };
  // GO view line 1: link health first (packet age, signal strength, Bluetooth).
  Viewer.prototype.padLinkHtml = function (nowMs) {
    const ln = this.linkState(nowMs);
    const e = this.env;
    return card(this.isGo() ? "1. Link" : "Link",
      row("Last packet", ln.age === null ? "none yet" : ageText(ln.age) + " ago" + (ln.stale ? ", stale" : ""), ln.age !== null && !ln.stale ? "ok" : "stop") +
      row("Signal", e && ln.age !== null ? e.rssiDbm + " dBm, " + (ln.weak ? "weak" : "good") : "unknown", e && ln.age !== null ? (ln.weak ? "warn" : "ok") : "") +
      row("Bluetooth", ln.bleUp ? "connected" : "not connected", ln.bleUp ? "ok" : "stop"));
  };
  // The GO view is what the Pad tab shows before arming (David, 2026-11-15).
  Viewer.prototype.isGo = function () {
    const ph = this.rocketState().phase;
    return ph === null || ph === "boot" || ph === "safe";
  };
  Viewer.prototype.lastTapHtml = function () {
    const t = this.lastTap;
    if (!t) return "";
    const what = {
      confirm: "Tap Confirm arm to send it.",
      cancelled: "Cancelled, not sent.",
      sending: "Sending to the ground station.",
      sent: "Sent to the ground station. The rocket decides.",
      not_sent: "Not sent: " + t.error + ".",
    }[t.status];
    return '<p class="note">Last tap: ' + esc(t.label) + ", " + esc(t.time) + ". " + esc(what) + "</p>";
  };
  // The keepalive line on the armed pad view (HG-242): the page's own 20 s timer.
  Viewer.prototype.keepaliveText = function (nowMs) {
    const k = this.keepalive;
    const c = this.cmd;
    let last = "none sent yet";
    if (k.lastMs !== null && k.tap !== null) last = "last sent " + ageText(Math.max(0, nowMs - k.lastMs) / 1000) + " ago";
    if (k.error) last = "last one not sent: " + k.error;
    else if (c && this.ble === "connected" && this.cmdName(c.cmd) === "keepalive" && c.state === "echoed") {
      const name = this.Msg.enumName(this.Msg.fieldOf("lora_packet", "cmd_result"), c.result);
      last += name === "worked" ? ", worked" : ", " + (RESULT[name] || { text: "outcome " + c.result }).text;
    }
    return "every " + KEEPALIVE_MS / 1000 + " s while this page is open, " + last;
  };
  Viewer.prototype.gpsText = function () {
    const p = this.pkt;
    const fix = this.Msg.enumName(this.field("fix_type"), p.fix_type);
    const kind = fix === "fix_3d" ? "3D fix" : fix === "fix_2d" ? "2D fix" : "no fix";
    return kind + ", " + p.num_sv + " satellites";
  };
  Viewer.prototype.battText = function () {
    const low = Object.keys(this.bits("batt"));
    return (this.pkt.vbat_dv / 10).toFixed(1) + " V" + (low.length ? ", " + low.join(", ").replace(/_/g, " ") : "");
  };
  Viewer.prototype.posText = function () {
    const p = this.pkt;
    if (p.lat_e7 === INT32_MIN || p.lon_e7 === INT32_MIN) return null;
    return (p.lat_e7 / 1e7).toFixed(6) + "," + (p.lon_e7 / 1e7).toFixed(6);
  };
  // The Arm button, then the confirm step before Arm (HG-241): the first tap shows Confirm arm and
  // Cancel, and only Confirm arm sends. The button shows the rocket's own answer and is never
  // disabled by the page.
  Viewer.prototype.armHtml = function (p, fl) {
    if (this.confirmArm) {
      return '<div class="btns confirm"><button type="button" class="big arm" data-press="arm-confirm">Confirm arm</button>' +
        '<button type="button" class="big refuse" data-press="arm-cancel">Cancel</button></div>';
    }
    return '<button type="button" class="big' + (p && fl.ready_to_arm ? "" : " refuse") + '" data-press="arm">' +
      (!p ? "Arm (rocket not heard)" : fl.ready_to_arm ? "Arm" : "Arm (rocket would refuse)") + "</button>";
  };
  Viewer.prototype.padMainHtml = function (nowMs) {
    const st = this.rocketState();
    const p = this.pkt;
    const fl = this.bits("flags");
    const known = this.linkState(this.envAtMs);
    const old = p && (known.stale || !known.bleUp) ? '<p class="note">Link lost. The lines below are the last known.</p>' : "";
    if (this.isGo()) {
      const w = this.warnings();
      const none = '<div class="item none"><span class="name">' + (p ? "none" : "unknown, no packet yet") + "</span></div>";
      return old + card("2. Rocket",
        row("Phase", st.text) +
        row("Retrieval latch", p ? (fl.retrieval_latch ? "ON" : "off") : "unknown", fl.retrieval_latch ? "warn" : "") +
        row("Sim mode", p ? (fl.sim ? (fl.bench_pyro ? "ON, bench pyro LIVE" : "ON") : "off") : "unknown", fl.sim ? "warn" : "")) +
        card("3. Hard stops", "", p ? w.hard.length : undefined) +
        (w.hard.map(function (h) {
          return '<div class="item stop">' + ICON.stop + '<span class="name">' + esc(h.name) + '</span><span class="tag">blocks arming</span></div>';
        }).join("") || none) +
        card("4. Warnings", "", p ? w.warn.length : undefined) +
        (w.warn.map(function (x) {
          if (x.acked) return '<div class="item acked">' + ICON.ok + '<span class="name">' + esc(x.name) + '</span><span class="tag">acked</span></div>';
          return '<div class="item warn">' + ICON.warn + '<span class="name">' + esc(x.name) + "</span>" +
            (x.known ? '<button type="button" class="ack" data-press="ack" data-arg="' + esc(x.key) + '">Ack</button>' : '<span class="tag">not acked</span>') + "</div>";
        }).join("") || none) +
        // The rocket's own answer (HG-242): flags bit ready_to_arm, set when an Arm sent now would
        // work. The page shows it on the line and on the button and never works it out. The button is
        // not disabled by the page.
        (!p ? '<div class="ready unknown">' + ICON.clock + "<span>READY TO ARM: UNKNOWN</span></div>" :
          fl.ready_to_arm ? '<div class="ready yes">' + ICON.ok + "<span>READY TO ARM</span></div>" :
            '<div class="ready no">' + ICON.stop + "<span>NOT READY TO ARM</span></div>") +
        '<p class="note">' + (!p ? "No packet yet, so the rocket has not answered." :
          fl.ready_to_arm ? "The rocket reports an Arm sent now would work." : "The rocket reports an Arm sent now would be refused.") + "</p>" +
        this.armHtml(p, fl) + this.lastTapHtml();
    }
    if (st.phase === "armed_pad") {
      const pos = this.posText();
      const fa = this.faultArmed();
      const fault = !fa.on ? "" : card("Fault while armed", "") + (fa.acked ?
        '<div class="item acked">' + ICON.ok + '<span class="name">' + esc(fa.reason || "Disarm advised") + '</span><span class="tag">acked</span></div>' :
        '<div class="item stop">' + ICON.stop + '<span class="name">' + esc(fa.reason || "Disarm advised") + "</span>" +
        '<button type="button" class="ack" data-press="ack" data-arg="fault_armed">Ack</button></div>') +
        '<p class="note">Disarm advised. The rocket stays armed until it is told to disarm.</p>';
      return old + fault + card("Rocket",
        row("State", st.text) + row("Altitude", p.alt_agl_m.toFixed(0) + " m above ground") +
        row("GPS", this.gpsText(), fl.gps_valid ? "ok" : "warn") + row("Battery", this.battText(), p.batt ? "warn" : "ok") +
        row("Position", pos ? pos.replace(",", ", ") : "no fix seen yet")) +
        card("Radio", row("Rocket listens", p.next_rx_ds === 65535 ? "none scheduled" : (p.next_rx_ds / 10).toFixed(1) + " s after each packet") +
          row("Keepalive", this.keepaliveText(nowMs), this.keepalive.error ? "warn" : "")) +
        '<button type="button" class="big" data-press="disarm">Disarm</button>' + this.lastTapHtml();
    }
    return old + card("Rocket", row("State", st.text)) +
      '<p class="note">The rocket is off the pad. Altitude, position and retrieval are on the Flight tab.</p>' + this.lastTapHtml();
  };
  Viewer.prototype.flightHtml = function () {
    const p = this.pkt;
    if (!p) return card("Flight", row("Rocket", "no packet yet"));
    const st = this.rocketState();
    const fl = this.bits("flags");
    const pos = this.posText();
    const up = -p.vz_n_mps;
    const faults = Object.keys(this.bits("health"));
    const step = RETRIEVAL_STEP[(p.flags >> 11) & 7] || "step " + ((p.flags >> 11) & 7);
    const cont = [1, 2, 3, 4].map(function (n) { return n + " " + CONT[(p.pyro_cont >> (2 * n - 2)) & 3]; }).join(", ");
    let pin = '<div class="row"><span class="k">Position</span><span class="v">no fix seen yet</span></div>';
    if (pos) {
      pin = row(fl.gps_valid ? "Position" : "Last position (not current)", pos.replace(",", ", "), fl.gps_valid ? "ok" : "warn") +
        '<div class="links"><a class="btn" href="geo:' + pos + "?q=" + encodeURIComponent(pos + " (HT-G4)") + '">Open in Maps</a>' +
        '<a class="btn" href="https://maps.google.com/?q=' + encodeURIComponent(pos) + '">Google Maps</a></div>';
    }
    return card("Flight",
      row("Phase", st.text) + row("Altitude", p.alt_agl_m.toFixed(0) + " m above ground") +
      row("Vertical speed", Math.abs(up).toFixed(1) + " m/s " + (up >= 0 ? "up" : "down")) +
      row("Height (GPS)", (p.h_msl_cm / 100).toFixed(0) + " m above sea level")) +
      card("Position", pin + row("GPS", this.gpsText(), fl.gps_valid ? "ok" : "warn")) +
      card("Retrieval",
        row("Retrieval latch", fl.retrieval_latch ? "ON" : "off") + row("Step", step) +
        row("Rocket Bluetooth", fl.ble_on ? "ON" : "off")) + this.findHtml(st, fl) +
      card("Health",
        row("Sensor faults", faults.length ? faults.join(", ").replace(/_/g, " ") : "none", faults.length ? "stop" : "ok") +
        row("Battery", this.battText(), p.batt ? "warn" : "ok") +
        row("Guide data", fl.guide_stale ? "stale, " + (p.guide_age_ds / 10).toFixed(1) + " s old" : "current", fl.guide_stale ? "warn" : "ok") +
        (fl.altimeter_only ? row("Mode", "altimeter only", "warn") : "") +
        (fl.warm_restart ? row("Restart", "restarted in flight", "warn") : "")) +
      card("Pyro",
        row("Fired", chList(p.pyro_fired)) + row("Continuity", cont) + row("Locked out", chList(p.pyro_locked)));
  };
  // The find command (HG-230): one command that turns each of the beeper, Bluetooth and Wi-Fi on or
  // off. Shown in retrieval, where the rocket takes it. Each option says ON or off in words.
  Viewer.prototype.findHtml = function (st, fl) {
    if (st.phase !== "retrieval" && !fl.retrieval_latch) return "";
    const opts = this.findOpts;
    return card("Find", "") + '<div class="btns opts">' + FIND_OPTS.map(function (o) {
      const on = opts[o[0]];
      return '<button type="button" class="opt' + (on ? " on" : "") + '" data-press="find-opt" data-arg="' + o[0] +
        '" aria-pressed="' + on + '">' + (on ? ICON.ok : "") + esc(o[1]) + ": " + (on ? "ON" : "off") + "</button>";
    }).join("") + "</div>" +
      '<button type="button" class="big" data-press="find">Send find (' + esc(this.findText()) + ")</button>" + this.lastTapHtml();
  };
  Viewer.prototype.benchHtml = function () {
    const p = this.pkt;
    if (!p) return card("Sim and bench pyro", row("Rocket", "no packet yet"));
    const fl = this.bits("flags");
    const ch = p.ematch & 7;
    const es = (p.ematch >> 3) & 7;
    const value = es === 3 ? (p.ematch_value / 10).toFixed(1) + " A measured" :
      es === 1 || es === 2 ? p.ematch_value + " of 2 held messages" : "none";
    return card("Sim and bench pyro",
      row("Sim mode", fl.sim ? "ON" : "off", fl.sim ? "warn" : "") +
      row("Bench pyro", fl.bench_pyro ? "LIVE" : "off", fl.bench_pyro ? "warn" : "") +
      row("Fixture read on", chList(p.pyro_fixture)) + row("Locked out", chList(p.pyro_locked))) +
      card("Live e-match test",
        row("Test", fl.ematch_test ? "RUNNING" : "off", fl.ematch_test ? "warn" : "") +
        row("Channel", ch ? String(ch) : "none") + row("State", EMATCH_STATE[es] || "state " + es) + row("Progress", value));
  };
  Viewer.prototype.pktHtml = function () {
    const p = this.pkt;
    const Msg = this.Msg;
    if (!p) return row("Packet", "no packet");
    return this.wire.fields.map(function (f) {
      const v = p[f.name];
      let t;
      if (f.bits) {
        const names = Msg.bitNames(f, v);
        t = "0x" + Number(v).toString(16) + (names.length ? " [" + names.join(", ") + "]" : "");
      } else if (f.enum) t = String(Msg.enumName(f, v) || v);
      else t = (typeof v === "number" && !Number.isInteger(v) ? v.toFixed(2) : String(v)) + (f.unit && f.unit !== "1" ? " " + f.unit : "");
      return row(f.name, t);
    }).join("");
  };
  Viewer.prototype.linkHtml = function (nowMs) {
    const e = this.env;
    const ln = this.linkState(nowMs);
    if (!e) return row("Last packet", "none yet") + row("Bluetooth", ln.bleUp ? "connected" : "not connected");
    return row("Last packet", ln.age === null ? "none yet" : (this.fresh ? "NEW" : "repeat") + ", age " + ln.age.toFixed(1) + " s" + (ln.stale ? " STALE" : ""),
      ln.age !== null && !ln.stale ? "ok" : "stop") +
      row("RSSI", e.rssiDbm + " dBm") + row("SNR", e.snrDb.toFixed(2) + " dB", ln.weak ? "warn" : "") +
      row("Received", String(e.rxOk)) + row("RX errors (CRC or header)", String(e.rxErr), e.rxErr ? "warn" : "") +
      row("Rejected (format or version)", String(e.rxRejected), e.rxRejected ? "stop" : "") +
      row("Loss (sequence gaps)", this.loss.missed + " (" + this.loss.percent().toFixed(1) + " %)", this.loss.missed ? "warn" : "") +
      row("Bluetooth", ln.bleUp ? "connected" : "not connected", ln.bleUp ? "ok" : "stop");
  };
  // Every region of the page as HTML text. index.html writes a region only when its text changed.
  Viewer.prototype.regions = function (nowMs) {
    return {
      head: this.headHtml(nowMs),
      banners: this.bannersHtml(),
      padLink: this.padLinkHtml(nowMs),
      padMain: this.padMainHtml(nowMs),
      flight: this.flightHtml(),
      bench: this.benchHtml(),
      pkt: this.pktHtml(),
      link: this.linkHtml(nowMs),
      err: this.err ? '<div class="item stop">' + ICON.stop + '<span class="name">' + esc(this.err) + "</span></div>" : "",
    };
  };

  const GsEnvelope = { parse, encodeIntent, LossCounter, RepeatFilter, Viewer, VIEWS, STALE_AFTER_S, TYPE_RAW_LORA, TYPE_COMMAND, KEEPALIVE_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = GsEnvelope;
  if (typeof globalThis !== "undefined") globalThis.GsEnvelope = GsEnvelope;
})();
