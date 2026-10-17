// Offline tests for openbend_ji.js with Max's globals stubbed: node test_engine.js
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const SOURCE = fs.readFileSync(path.join(__dirname, "openbend_ji.js"), "utf8")
    .replace(/^inlets = .*$/m, "").replace(/^outlets = .*$/m, "");
const API = ["msg_int", "porta", "portams", "tick", "click", "lock", "chordwindow", "flushPending", "curvetype", "range"];

// A fresh engine whose outlets are recorded, with helpers that drain what it sent.
function engine() {
    const out = [];
    function Task() {
        this.running = false;
        this.repeat = () => { this.running = true; };
        this.schedule = () => { this.running = true; };
        this.cancel = () => { this.running = false; };
    }
    const api = new Function("outlet", "Task", `${SOURCE}; return {${API.join(", ")}};`)(
        (i, ...a) => out.push([i, ...a]), Task);
    const play = (bytes) => bytes.forEach(api.msg_int);
    const take = (keep) => {
        const taken = out.filter(keep);
        for (let i = out.length - 1; i >= 0; i--) if (keep(out[i])) out.splice(i, 1);
        return taken;
    };
    const midi = () => take(o => o[0] === 0).map(o => o[1]);
    // [channel, bend from center] for each pitch bend sent
    const bends = () => take(o => o[0] === 0 && (o[1][0] & 0xf0) === 0xe0)
        .map(o => [(o[1][0] & 0x0f) + 1, ((o[1][2] << 7) | o[1][1]) - 8192]);
    // last bend sent per note, keyed by the note the channel was opened for
    const finalBends = () => {
        const chanNote = {}, last = {};
        for (const [st, a, b] of midi()) {
            const ch = (st & 0x0f) + 1, kind = st & 0xf0;
            if (kind === 0x90) chanNote[ch] = a;
            if (kind === 0xe0) last[ch] = ((b << 7) | a) - 8192;
        }
        const byNote = {};
        for (const ch in chanNote) byNote[chanNote[ch]] = last[ch];
        return byNote;
    };
    // the latest state of each display box
    const shown = () => {
        const state = {};
        take(o => o[0] === 1).forEach(([, target, kind, ...rest]) => {
            state[target] = target === "lockmenu" ? kind
                : Object.assign(state[target] || {}, { [kind]: kind === "set" ? rest.join(" ") : rest });
        });
        return state;
    };
    return { play, midi, bends, finalBends, shown, api };
}

const chordName = (bytes) => {
    const e = engine();
    e.play(bytes);
    return e.shown().scale.set.split("   ·   ")[0];
};

test("C major tunes E and G against C, each note on its own channel", () => {
    const e = engine();
    e.play([0x90, 60, 100, 64, 100, 67, 100]);
    assert.deepStrictEqual(e.bends(), [[2, 0], [3, -23], [4, 3]]);  // E -13.7 c, G +2 c
    e.play([0x90, 70, 100]);
    assert.deepStrictEqual(e.bends(), [[5, 30]]);                   // Bb makes C7: +17.6 c
});

test("held notes re-bend when an added note moves the root, and back on release", () => {
    const e = engine();
    e.play([0x90, 60, 100, 64, 100]);
    e.bends();
    e.play([0x90, 57, 100]);
    assert.deepStrictEqual(e.bends(), [[4, 0], [2, 27], [3, 3]]);
    e.play([0x80, 57, 0]);
    assert.deepStrictEqual(e.bends(), [[2, 0], [3, -23]]);
});

test("an inversion is tuned on its real root", () => {
    const e = engine();
    e.play([0x90, 64, 100, 67, 100, 72, 100]);  // E G C
    assert.deepStrictEqual(e.finalBends(), { 64: -23, 67: 3, 72: 0 });
});

test("portamento slides instead of jumping", () => {
    const e = engine();
    e.api.porta(1);
    e.api.portams(10);
    e.play([0x90, 60, 100, 64, 100]);
    const first = e.bends();
    assert.deepStrictEqual(first[0], [2, 0]);
    assert.deepStrictEqual(first[1], [3, 0]);
    e.api.tick();
    e.api.tick();
    assert.deepStrictEqual(e.bends().pop(), [3, -23]);
});

test("the strip shows the chord and every pitch class's cents on its root", () => {
    const e = engine();
    e.play([0x90, 60, 100, 64, 100, 67, 100]);
    const ui = e.shown();
    assert.strictEqual(ui.scale.set, "C   ·   auto root C");
    assert.strictEqual(ui.c0.set, "root");
    assert.strictEqual(ui.c4.set, "-13.7");
    assert.strictEqual(ui.c7.set, "+2.0");
    assert.strictEqual(ui.c10.set, "+17.6");
    assert.strictEqual(ui.c4.textcolor[3], 1.0);                // E held: bright
    assert.strictEqual(ui.c10.textcolor[3], 0.38);              // Bb not held: dim
    assert.ok(ui.c4.textcolor[2] > ui.c4.textcolor[0]);         // flat reads cool
    assert.ok(ui.c7.textcolor[0] > ui.c7.textcolor[2]);         // sharp reads warm

    e.play([0x90, 70, 100]);
    assert.strictEqual(e.shown().scale.set, "C7   ·   auto root C");
    e.play([0x80, 60, 0, 64, 0, 67, 0, 70, 0]);
    assert.strictEqual(e.shown().scale.set, "last: C7   ·   auto root C");
});

test("chord names: inversions become slash chords, a dropped fifth still names the chord", () => {
    assert.strictEqual(chordName([0x90, 64, 100, 67, 100, 72, 100]), "C/E (1st inversion)");
    assert.strictEqual(chordName([0x90, 55, 100, 60, 100, 64, 100]), "C/G (2nd inversion)");
    assert.strictEqual(chordName([0x90, 59, 100, 62, 100, 65, 100, 67, 100]), "G7/B (1st inversion)");
    assert.strictEqual(chordName([0x90, 58, 100, 60, 100, 64, 100, 67, 100]), "C7/Bb (3rd inversion)");
    assert.strictEqual(chordName([0x90, 57, 100, 60, 100, 64, 100, 67, 100]), "Am7");
    assert.strictEqual(chordName([0x90, 60, 100, 64, 100, 70, 100]), "C7");
    assert.strictEqual(chordName([0x90, 62, 100, 65, 100, 69, 100, 72, 100, 76, 100]), "Dm9");
    assert.strictEqual(chordName([0x90, 60, 100, 65, 100, 67, 100]), "Csus4");
    assert.strictEqual(chordName([0x90, 60, 100, 63, 100, 67, 100]), "Cm");
    assert.strictEqual(chordName([0x90, 60, 100, 64, 100]), "C + E (M3)");
});

test("clicking a note locks the root through the Root menu; clicking again unlocks", () => {
    const e = engine();
    e.play([0x90, 60, 100, 64, 100, 67, 100]);
    e.finalBends();
    e.shown();
    e.api.click(9);
    assert.strictEqual(e.shown().lockmenu, 10);                 // menu index: 0 = Auto, 1..12 = C..B
    e.api.lock(10);                                             // what the menu sends back
    // on root A: C a minor third (+15.6 c), E a fifth (+2 c), G a minor seventh (+17.6 c)
    assert.deepStrictEqual(e.bends(), [[2, 27], [3, 3], [4, 30]]);
    const ui = e.shown();
    assert.strictEqual(ui.scale.set, "C   ·   locked to A");
    assert.strictEqual(ui.c9.set, "lock");
    e.api.click(9);
    assert.strictEqual(e.shown().lockmenu, 0);
    e.api.lock(0);
    assert.deepStrictEqual(e.bends(), [[2, 0], [3, -23], [4, 3]]);
    assert.strictEqual(e.shown().scale.set, "C   ·   auto root C");
});

test("a locked root holds with nothing played, and new notes tune against it", () => {
    const e = engine();
    e.api.lock(3);                                              // D
    e.play([0x90, 66, 100]);                                    // F#: major third above D
    assert.deepStrictEqual(e.bends(), [[2, -23]]);
});

test("the chord window tunes a strum on one root, with no re-bends", () => {
    const e = engine();
    e.api.chordwindow(30);
    e.play([0x90, 64, 100, 67, 100, 72, 100]);
    assert.deepStrictEqual(e.bends(), []);                      // nothing sounds inside the window
    e.api.flushPending();                                       // the window closes
    assert.deepStrictEqual(e.bends(), [[2, -23], [3, 3], [4, 0]]);
});

test("a key released inside the chord window still sounds, then stops", () => {
    const e = engine();
    e.api.chordwindow(30);
    e.play([0x90, 60, 100, 0x80, 60, 0]);
    assert.deepStrictEqual(e.finalBends(), { 60: 0 });
});

test("a member-channel bend from an MPE source rides on top of the JI bend", () => {
    const e = engine();
    e.play([0x91, 64, 100, 0x91, 60, 100]);                     // E then C, both on input channel 2
    e.bends();
    e.play([0xe1, 0, 68]);                                      // +512 = +3 semitones at range 48
    assert.deepStrictEqual(e.bends(), [[3, 512], [2, 512 - 23]]);
});

test("poly aftertouch reaches only its own note's channel", () => {
    const e = engine();
    e.play([0x90, 60, 100, 64, 100]);
    e.midi();
    e.play([0xa0, 64, 50]);
    assert.deepStrictEqual(e.midi(), [[0xa2, 64, 50]]);
});

test("all notes off releases every tuned note and passes through", () => {
    const e = engine();
    e.play([0x90, 60, 100, 64, 100]);
    e.midi();
    e.play([0xb0, 123, 0]);
    assert.deepStrictEqual(e.midi(), [[0x81, 60, 0], [0xe2, 0, 64], [0x82, 64, 0], [0xb0, 123, 0]]);
});

test("the curve graph redraws with the chosen shape; Bend Range reports its step size", () => {
    const e = engine();
    e.api.curvetype(1);
    const drawn = e.shown();
    assert.ok(drawn.curvegraph && "lineto" in drawn.curvegraph);
    e.api.range(2);
    assert.strictEqual(e.shown().steptext.set, "1 step = 0.02 c");
});
