# OpenBend JI

<img src="docs/device.png" width="698" alt="OpenBend JI in Ableton Live">

A Max for Live version of [OpenBend](https://github.com/Licensed-Driver/OpenBend) by Licensed-Driver.

It retunes the chords you play to 5-limit just intonation and follows the root as the harmony moves. Each note goes out on its own MPE channel with its own pitch bend.

## Use

Needs Live 12 with Max 9, and an MPE synth after it with a ±48 semitone bend range. Drift and Wavetable work as they are.

Download `OpenBend-JI.amxd` from Releases and drop it into your User Library under `Presets/MIDI Effects/Max MIDI Effect/`, then put it in front of the synth.

In Auto, the sustain pedal keeps released notes in the chord. New notes join them, and the tuning follows all notes still sounding. Lift the pedal to release those notes and tune from the keys still held. A manually locked root stays fixed.

Sustain uses MIDI CC64 (64–127 down, 0–63 up). OpenBend holds the notes itself and consumes CC64. Channel 1 controls sustain for all notes; other channels control notes played on that input channel.

## Build

`build_amxd.py` (Python 3.12+) writes the device into your User Library. `test_engine.js` tests the engine without Live.

```bash
python3 build_amxd.py
```

```bash
node test_engine.js
```

## License

GPLv3, like OpenBend.
