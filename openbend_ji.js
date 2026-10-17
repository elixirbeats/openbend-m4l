// OpenBend JI: adaptive 5-limit just intonation as a Max for Live MIDI effect.
// A port of the core of OpenBend (github.com/Licensed-Driver/OpenBend, GPLv3):
// every held note gets its own MPE channel and a pitch bend that moves it from
// 12-TET to the pure ratio above the chord's most likely root.
//
// In:  raw MIDI bytes from [midiin], plus control messages
//      (porta, portams, curvetype, range, chordwindow, lock, click)
// Out: 0 = MIDI messages as byte lists for [iter] -> [midiout]
//      1 = display messages, each led by the name of the box it is for

inlets = 1;
outlets = 2;

const RATIOS = [1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 9 / 5, 15 / 8];
const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const FIRST_CHANNEL = 2;
const LAST_CHANNEL = 15;
const TICK_MS = 5;

let bendRange = 48;
let portaOn = false;
let portaMs = 100;
let portaCurve = 0;
let chordWindowMs = 0;  // how long to gather a strummed chord before tuning it

const active = new Array(128).fill(false);
const noteChannel = new Array(128).fill(0);
const noteInChannel = new Array(128).fill(0);
const current = new Float64Array(128);
const start = new Float64Array(128);
const target = new Float64Array(128);
const phase = new Float64Array(128).fill(1);
const lastSent = new Int32Array(128).fill(-1);
const inputBend = new Float64Array(17);
let nextChannel = FIRST_CHANNEL;
let root = -1;  // pitch class every held note is tuned against, or -1 with nothing to tune
let lockedRoot = -1;  // pitch class 0..11 picked by clicking a note, or -1 for auto

const slider = new Task(tick, this);
slider.interval = TICK_MS;
let pending = [];  // note-ons waiting out the chord window
const gather = new Task(flushPending, this);

// ---- tuning -------------------------------------------------------------

function mod12(x) {
    return ((x % 12) + 12) % 12;
}

// Semitones from the 12-TET interval to its pure ratio, e.g. -0.137 for a major third.
function jiOffset(interval) {
    return 12 * Math.log2(RATIOS[interval]) - interval;
}

// Locked: the pitch class the user picked. Auto: OpenBend's scoring, which folds
// octaves away, so an inversion such as E-G-C still finds C: G is a fifth and E a
// third above it. Ties, and chords with no fifth or third, go to the lowest note.
function updateRoot() {
    if (lockedRoot >= 0) {
        root = lockedRoot;
        return;
    }
    root = -1;
    let bestScore = -1;
    for (let candidate = 0; candidate < 128; candidate++) {
        if (!active[candidate]) continue;
        let score = 0;
        for (let other = 0; other < 128; other++) {
            if (other === candidate || !active[other]) continue;
            const interval = mod12(other - candidate);
            if (interval === 7) score += 3;
            else if (interval === 4 || interval === 3) score += 2;
            else if (interval === 10) score += 1;
        }
        if (score > bestScore) {
            bestScore = score;
            root = candidate % 12;
        }
    }
}

function jiBend(note) {
    return root === -1 ? 0 : jiOffset(mod12(note - root));
}

// Porta Curve menu: 0 = Linear, 1 = Log (fast, then settles), 2 = Exp (slow, then speeds up)
function curve(t) {
    if (portaCurve === 1) return Math.log10(1 + 9 * t);
    if (portaCurve === 2) return (Math.pow(10, t) - 1) / 9;
    return t;
}

// ---- output -------------------------------------------------------------

function send(bytes) {
    outlet(0, bytes);
}

function sendBend(note) {
    const channel = noteChannel[note];
    if (channel < 1) return;
    const semitones = current[note] + inputBend[noteInChannel[note]];
    const value = Math.max(0, Math.min(16383, 8192 + Math.round((semitones / bendRange) * 8192)));
    if (value === lastSent[note]) return;
    lastSent[note] = value;
    send([0xe0 | (channel - 1), value & 127, value >> 7]);
}

// ---- display ------------------------------------------------------------
// Outlet 1 drives the strip: "scale set <text>", "n<pc> textcolor r g b a" for
// the 12 note names, "c<pc> set <cents>" / "c<pc> textcolor ..." under them,
// and "lockmenu <0..12>" to the Root menu when a note is clicked.

// Chord shapes as intervals above their root. Shapes that hold a fifth also
// match without it (C-E-Bb is still C7), since players drop the fifth first.
const SHAPES = [
    ["", [0, 4, 7]], ["m", [0, 3, 7]], ["dim", [0, 3, 6]], ["aug", [0, 4, 8]],
    ["sus2", [0, 2, 7]], ["sus4", [0, 5, 7]], ["5", [0, 7]],
    ["6", [0, 4, 7, 9]], ["m6", [0, 3, 7, 9]], ["7", [0, 4, 7, 10]], ["maj7", [0, 4, 7, 11]],
    ["m7", [0, 3, 7, 10]], ["m(maj7)", [0, 3, 7, 11]], ["m7b5", [0, 3, 6, 10]], ["dim7", [0, 3, 6, 9]],
    ["7sus4", [0, 5, 7, 10]], ["aug7", [0, 4, 8, 10]], ["maj7#5", [0, 4, 8, 11]], ["7b5", [0, 4, 6, 10]],
    ["add9", [0, 2, 4, 7]], ["m(add9)", [0, 2, 3, 7]], ["add11", [0, 4, 5, 7]], ["6/9", [0, 2, 4, 7, 9]],
    ["9", [0, 2, 4, 7, 10]], ["maj9", [0, 2, 4, 7, 11]], ["m9", [0, 2, 3, 7, 10]], ["9sus4", [0, 2, 5, 7, 10]],
    ["7b9", [0, 1, 4, 7, 10]], ["7#9", [0, 3, 4, 7, 10]], ["7#11", [0, 4, 6, 7, 10]], ["maj7#11", [0, 4, 6, 7, 11]],
    ["11", [0, 2, 4, 5, 7, 10]], ["m11", [0, 2, 3, 5, 7, 10]],
    ["13", [0, 2, 4, 7, 9, 10]], ["maj13", [0, 2, 4, 7, 9, 11]], ["m13", [0, 2, 3, 7, 9, 10]],
];
const SHAPE_OF = {};
for (const [suffix, iv] of SHAPES) SHAPE_OF[iv.join(",")] = { suffix, exact: true };
for (const [suffix, iv] of SHAPES) {
    const no5 = iv.filter(i => i !== 7).join(",");
    if (iv.length >= 4 && iv.includes(7) && !(no5 in SHAPE_OF)) SHAPE_OF[no5] = { suffix, exact: false };
}
const INTERVALS = ["", "m2", "M2", "m3", "M3", "P4", "tritone", "P5", "m6", "M6", "m7", "M7"];
const INVERSION = { 3: "1st inversion", 4: "1st inversion", 6: "2nd inversion", 7: "2nd inversion",
    8: "2nd inversion", 9: "3rd inversion", 10: "3rd inversion", 11: "3rd inversion" };

const SHARP = [1.0, 0.56, 0.22];
const FLAT = [0.36, 0.66, 1.0];
const PURE = [0.86, 0.86, 0.86];
const ROOT = [1.0, 0.86, 0.3];
let lastChord = null;  // {name, root, size}: the fullest chord since the first key went down
let gestureOpen = false;

function rgba(rgb, bright) {
    return rgb.concat([bright ? 1.0 : 0.38]);
}

// Names what is held: tries every held pitch class as the root, keeps the shape
// that fits, preferring the tuning root, then the bass. A bass note that is not
// the root makes a slash chord, and which chord tone it is gives the inversion.
function nameChord(held, bass, preferRoot) {
    const pcs = [...new Set(held)];
    if (pcs.length === 1) return NAMES[pcs[0]];
    let best = null;
    for (const r of pcs) {
        const key = pcs.map(pc => mod12(pc - r)).sort((a, b) => a - b).join(",");
        const shape = SHAPE_OF[key];
        if (!shape) continue;
        const score = (shape.exact ? 10 : 8) + (r === preferRoot ? 2 : 0) + (r === bass ? 1 : 0);
        if (!best || score > best.score) best = { r, shape, score };
    }
    if (!best) {
        if (pcs.length === 2) {
            const [lo, hi] = [bass, pcs.find(pc => pc !== bass)];
            return NAMES[lo] + " + " + NAMES[hi] + " (" + INTERVALS[mod12(hi - lo)] + ")";
        }
        return pcs.map(pc => NAMES[pc]).join(" ");
    }
    let name = NAMES[best.r] + best.shape.suffix;
    if (bass !== best.r) {
        name += "/" + NAMES[bass];
        const inversion = INVERSION[mod12(bass - best.r)];
        if (inversion) name += " (" + inversion + ")";
    }
    return name;
}

function display() {
    const held = [];  // pitch classes from the bass up
    for (let n = 0; n < 128; n++) if (active[n]) held.push(n % 12);
    const bass = held.length ? held[0] : -1;
    const size = new Set(held).size;
    const chord = size ? nameChord(held, bass, root) : "";
    if (size === 0) gestureOpen = false;
    else {
        if (!gestureOpen) lastChord = null;
        gestureOpen = true;
        if (!lastChord || size >= lastChord.size) lastChord = { name: chord, root, size };
    }
    // locked: that root; while notes sound: the root they are tuned to; after release: the last chord's
    const shownRoot = lockedRoot >= 0 ? lockedRoot : size ? root : lastChord ? lastChord.root : -1;
    if (shownRoot === -1) {
        outlet(1, "scale", "set", "play a chord  ·  root found automatically");
        for (let pc = 0; pc < 12; pc++) {
            outlet(1, "n" + pc, "textcolor", ...rgba(PURE, false));
            outlet(1, "c" + pc, "set", "-");
            outlet(1, "c" + pc, "textcolor", ...rgba(PURE, false));
        }
        return;
    }
    const shownChord = size ? chord : lastChord ? "last: " + lastChord.name : "";
    const tuning = (lockedRoot >= 0 ? "locked to " : "auto root ") + NAMES[shownRoot];
    outlet(1, "scale", "set", shownChord ? shownChord + "   ·   " + tuning : tuning);
    for (let pc = 0; pc < 12; pc++) {
        const isHeld = held.includes(pc);
        const cents = 100 * jiOffset(mod12(pc - shownRoot));
        const text = pc === shownRoot ? (lockedRoot >= 0 ? "lock" : "root") : (cents > 0 ? "+" : "") + cents.toFixed(1);
        const tone = pc === shownRoot ? ROOT : Math.abs(cents) < 0.05 ? PURE : cents > 0 ? SHARP : FLAT;
        outlet(1, "n" + pc, "textcolor", ...rgba(pc === shownRoot ? ROOT : PURE, isHeld || (pc === shownRoot && lockedRoot >= 0)));
        outlet(1, "c" + pc, "set", text);
        outlet(1, "c" + pc, "textcolor", ...rgba(tone, isHeld));
    }
}

// The portamento graph: an [lcd] 60 x 30 px, drawn with lcd's own messages.
// x is time through the slide, y how far the pitch has moved to its new tuning.
const GRAPH_W = 60;
const GRAPH_H = 30;

function drawCurve() {
    const g = (...m) => outlet(1, "curvegraph", ...m);
    g("brgb", 38, 38, 38);
    g("clear");
    g("frgb", 80, 80, 80);
    g("linesegment", 3, GRAPH_H - 4, GRAPH_W - 3, GRAPH_H - 4);
    g("linesegment", 3, 3, GRAPH_W - 3, 3);
    g("frgb", ...(portaOn ? [255, 143, 56] : [130, 130, 130]));
    g("pensize", 2, 2);
    for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const x = Math.round(3 + t * (GRAPH_W - 6));
        const y = Math.round(GRAPH_H - 4 - curve(t) * (GRAPH_H - 7));
        g(i === 0 ? "moveto" : "lineto", x, y);
    }
    g("pensize", 1, 1);
}

// How fine the tuning can be: 14-bit bends span +/- the range in 8192 steps.
function stepText() {
    outlet(1, "steptext", "set", "1 step = " + ((bendRange * 100) / 8192).toFixed(2) + " c");
}

function loadbang() {
    display();
    drawCurve();
    stepText();
}

// ---- notes --------------------------------------------------------------

// Round-robin over the member channels, skipping busy ones so a note's release
// tail keeps its bend. Past 14 notes the next channel in turn is shared.
function freeChannel() {
    const span = LAST_CHANNEL - FIRST_CHANNEL + 1;
    let channel = nextChannel;
    for (let k = 0; k < span; k++) {
        const candidate = FIRST_CHANNEL + ((nextChannel - FIRST_CHANNEL + k) % span);
        if (!noteChannel.includes(candidate)) {
            channel = candidate;
            break;
        }
    }
    nextChannel = channel === LAST_CHANNEL ? FIRST_CHANNEL : channel + 1;
    return channel;
}

// Moves every held note toward its bend for the current root.
function retarget() {
    let sliding = false;
    for (let n = 0; n < 128; n++) {
        if (!active[n]) continue;
        const next = jiBend(n);
        if (Math.abs(next - target[n]) > 0.001) {
            target[n] = next;
            start[n] = current[n];
            phase[n] = portaOn ? 0 : 1;
            if (!portaOn) current[n] = next;
        }
        if (phase[n] < 1) sliding = true;
        sendBend(n);
    }
    if (sliding && !slider.running) slider.repeat();
}

// With a chord window, note-ons wait until the window closes so the whole
// strum is tuned on one root; without one they start at once.
function noteOn(inChannel, note, velocity) {
    if (active[note]) noteOff(inChannel, note, 0);
    if (chordWindowMs > 0) {
        pending = pending.filter(p => p.note !== note);
        pending.push({ inChannel, note, velocity });
        if (pending.length === 1) gather.schedule(chordWindowMs);
        return;
    }
    startNotes([{ inChannel, note, velocity }]);
}

function flushPending() {
    if (!pending.length) return;
    const notes = pending;
    pending = [];
    gather.cancel();
    startNotes(notes);
}

function startNotes(notes) {
    for (const { note } of notes) active[note] = true;
    updateRoot();
    for (const { inChannel, note, velocity } of notes) {
        const bend = jiBend(note);
        target[note] = bend;
        start[note] = portaOn ? 0 : bend;
        current[note] = start[note];
        phase[note] = portaOn ? 0 : 1;
        noteInChannel[note] = inChannel;
        noteChannel[note] = freeChannel();
        lastSent[note] = -1;
        sendBend(note);
        send([0x90 | (noteChannel[note] - 1), note, velocity]);
    }
    retarget();
    display();
}

function noteOff(inChannel, note, velocity) {
    if (pending.some(p => p.note === note)) flushPending();
    if (!active[note]) return;
    active[note] = false;
    send([0x80 | (noteChannel[note] - 1), note, velocity]);
    noteChannel[note] = 0;
    target[note] = current[note] = start[note] = 0;
    phase[note] = 1;
    lastSent[note] = -1;
    updateRoot();
    retarget();
    display();
}

function allOff() {
    pending = [];
    gather.cancel();
    for (let n = 0; n < 128; n++) if (active[n]) noteOff(0, n, 0);
}

function tick() {
    let sliding = false;
    for (let n = 0; n < 128; n++) {
        if (!active[n] || phase[n] >= 1) continue;
        phase[n] = Math.min(1, phase[n] + TICK_MS / Math.max(1, portaMs));
        current[n] = start[n] + (target[n] - start[n]) * curve(phase[n]);
        sendBend(n);
        if (phase[n] < 1) sliding = true;
    }
    if (!sliding) slider.cancel();
}

// ---- MIDI parsing -------------------------------------------------------

let status = 0;
let data = [];
let sysex = null;

function dataLength(s) {
    const kind = s & 0xf0;
    return kind === 0xc0 || kind === 0xd0 ? 1 : 2;
}

// Channel 1 is the MPE master channel: its messages pass through and reach every
// note. Expression on another channel belongs to the notes played on it, and poly
// aftertouch to its one note, so both follow their notes to their output channels.
function handle(s, d) {
    const kind = s & 0xf0;
    const inChannel = (s & 0x0f) + 1;
    if (kind === 0x90 && d[1] > 0) return noteOn(inChannel, d[0], d[1]);
    if (kind === 0x80 || kind === 0x90) return noteOff(inChannel, d[0], d[1]);
    if (kind === 0xa0) {
        if (active[d[0]]) send([0xa0 | (noteChannel[d[0]] - 1), d[0], d[1]]);
        return;
    }
    if (kind === 0xe0 && inChannel > 1) {
        // rides on top of the JI bend, read with the same bend range as the output
        inputBend[inChannel] = (((d[1] << 7) | d[0]) - 8192) / 8192 * bendRange;
        for (let n = 0; n < 128; n++) if (active[n] && noteInChannel[n] === inChannel) sendBend(n);
        return;
    }
    if (kind === 0xb0 && (d[0] === 123 || d[0] === 120)) allOff();
    if (inChannel > 1 && (kind === 0xd0 || kind === 0xb0)) {
        for (let n = 0; n < 128; n++) {
            if (active[n] && noteInChannel[n] === inChannel) send([kind | (noteChannel[n] - 1)].concat(d));
        }
        return;
    }
    send([s].concat(d));
}

function msg_int(byte) {
    if (byte >= 0xf8) return send([byte]);
    if (byte === 0xf0) {
        sysex = [byte];
        return;
    }
    if (sysex) {
        sysex.push(byte);
        if (byte === 0xf7) {
            send(sysex);
            sysex = null;
        }
        return;
    }
    if (byte > 0xf0) {
        status = 0;  // system common messages are dropped, and they cancel running status
        return;
    }
    if (byte >= 0x80) {
        status = byte;
        data = [];
        return;
    }
    if (!status) return;
    data.push(byte);
    if (data.length === dataLength(status)) {
        handle(status, data);
        data = [];
    }
}

// ---- controls -----------------------------------------------------------

function porta(v) {
    portaOn = v > 0.5;
    drawCurve();
}

function portams(v) {
    portaMs = Math.max(1, v);
}

function curvetype(v) {
    portaCurve = Math.round(v);
    drawCurve();
}

function chordwindow(v) {
    chordWindowMs = Math.max(0, v);
    if (chordWindowMs === 0) flushPending();
}

function range(v) {
    bendRange = Math.max(1, v);
    for (let n = 0; n < 128; n++) {
        lastSent[n] = -1;
        if (active[n]) sendBend(n);
    }
    stepText();
}

// A click on a note in the strip toggles the lock through the Root menu, so the
// menu stays the one saved, automatable source of truth: it answers with lock().
function click(pc) {
    outlet(1, "lockmenu", lockedRoot === pc ? 0 : pc + 1);
}

// Root menu: 0 = auto, 1..12 = C..B
function lock(v) {
    lockedRoot = v >= 1 ? (Math.round(v) - 1) % 12 : -1;
    updateRoot();
    retarget();
    display();
}
