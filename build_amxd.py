"""Build OpenBend-JI.amxd: a Max for Live MIDI effect with the JS engine embedded in a v8.codebox.

usage: python3 build_amxd.py [output.amxd]
Default output is the User Library's Max MIDI Effect folder, where Live's browser finds it.
"""
import json
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = Path.home() / "Music/Ableton/User Library/Presets/MIDI Effects/Max MIDI Effect/OpenBend-JI.amxd"

NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]

# The engine's second outlet addresses each display box by name, e.g. "c4 set -13.7"
# or "n4 textcolor ...", and "lockmenu 5" for the Root menu; [route] fans them out.
TARGETS = (["scale"] + [f"n{pc}" for pc in range(12)] + [f"c{pc}" for pc in range(12)]
           + ["lockmenu", "steptext", "curvegraph"])

DIM = [0.86, 0.86, 0.86, 0.38]
HINT = [0.7, 0.7, 0.7, 0.85]
STRIP_Y = 78
COLUMN_W = 34
CENTS_OVERHANG = 6  # cents text boxes reach this far into the next column on each side

type Rect = tuple[float, float, float, float]
type Json = dict[str, object]


class Patch:
    """The boxes and patch cords of a Max patcher, in the order Max saves them."""

    def __init__(self) -> None:
        self.boxes: list[Json] = []
        self.lines: list[Json] = []

    def box(self, id_: str, maxclass: str, rect: Rect, **attrs: object) -> None:
        self.boxes.append({"box": {"id": id_, "maxclass": maxclass, "patching_rect": list(rect), **attrs}})

    def obj(self, id_: str, text: str, rect: Rect, inlets: int, outlettype: list[str]) -> None:
        self.box(id_, "newobj", rect, text=text, numinlets=inlets, numoutlets=len(outlettype),
                 outlettype=outlettype, fontname="Arial Bold", fontsize=10.0)

    def wire(self, src: str, dst: str, src_out: int = 0, dst_in: int = 0) -> None:
        self.lines.append({"patchline": {"source": [src, src_out], "destination": [dst, dst_in]}})


@dataclass(frozen=True)
class Control:
    """A saved, automatable Live control whose value is sent to the engine as `<message> <value>`."""

    id: str
    maxclass: str
    message: str
    rect: Rect
    param: Json
    outlettype: list[str]
    hint: str

    @property
    def longname(self) -> str:
        return str(self.param["parameter_longname"])


def param(longname: str, shortname: str, ptype: int, mmin: float, mmax: float, initial: float,
          enum: list[str] | None = None, unitstyle: int | None = None, exponent: float | None = None) -> Json:
    v: Json = {"parameter_longname": longname, "parameter_shortname": shortname, "parameter_type": ptype,
               "parameter_modmode": 0, "parameter_linknames": 0, "parameter_mmin": mmin, "parameter_mmax": mmax,
               "parameter_initial": [initial], "parameter_initial_enable": 1}
    if enum is not None:
        v["parameter_enum"] = enum
    if unitstyle is not None:
        v["parameter_unitstyle"] = unitstyle
    if exponent is not None:
        v["parameter_exponent"] = exponent
    return v


CONTROLS = [
    Control("porta", "live.toggle", "porta", (8, 22, 15, 15), param("Portamento", "Porta", 2, 0, 1, 0, ["off", "on"]),
            [""], "Slide held notes to their new tuning when the root changes, instead of jumping."),
    Control("portams", "live.dial", "portams", (70, 4, 44, 48),
            param("Porta Time", "Time", 0, 1.0, 10000.0, 100.0, unitstyle=2, exponent=3.0),
            ["", "float"], "How long the portamento slide takes, 1 ms to 10 s."),
    Control("curve", "live.menu", "curvetype", (124, 37, 60, 15),
            param("Porta Curve", "Curve", 2, 0, 2, 0, ["Linear", "Log", "Exp"]),
            ["", "", "float"],
            "Shape of the slide, drawn above: Linear moves evenly, Log moves fast then settles, "
            "Exp starts slow then speeds up."),
    Control("range", "live.numbox", "range", (196, 22, 40, 15), param("Bend Range", "Range", 1, 1, 96, 48, unitstyle=7),
            ["", "float"],
            "How far a full pitch-bend message moves a note, in semitones. Set it to the synth's per-note bend range "
            "or every note lands out of tune: MPE synths such as Drift and Wavetable use 48. A smaller range gives "
            "finer steps (shown below) but cannot reach as far."),
    Control("rootmenu", "live.menu", "lock", (356, 22, 60, 15),
            param("Root", "Root", 2, 0, 12, 0, ["Auto"] + NOTE_NAMES),
            ["", "", "float"],
            "Auto finds the root from the chord (the note with a fifth and thirds above it). "
            "Pick a note, or click one in the strip, to tune every chord against that root instead."),
    Control("chordwin", "live.numbox", "chordwindow", (8, 140, 44, 15),
            param("Chord Window", "Window", 0, 0.0, 200.0, 0.0, unitstyle=2),
            ["", "float"],
            "Waits this long after the first note of a chord before tuning, so a strummed or rolled chord is tuned "
            "on one root instead of re-tuning as each note arrives. Delays note starts by the same time; 0 is off."),
]


def add_midi_path(p: Patch, code: str) -> None:
    p.obj("midiin", "midiin", (20, 20, 50, 20), 1, ["int"])
    p.box("engine", "v8.codebox", (20, 60, 420, 200), code=code, filename="none", numinlets=1, numoutlets=2,
          outlettype=["", ""], fontname="<Monospaced>", fontsize=10.0, saved_object_attributes={"parameter_enable": 0})
    p.obj("iter", "iter", (20, 280, 40, 20), 1, [""])
    p.obj("midiout", "midiout", (20, 310, 50, 20), 1, [])
    p.wire("midiin", "engine")
    p.wire("engine", "iter")
    p.wire("iter", "midiout")


def add_readout(p: Patch) -> None:
    p.obj("router", "route " + " ".join(TARGETS), (460, 220, 400, 20), 1, [""] * (len(TARGETS) + 1))
    p.wire("engine", "router", 1, 0)

    def text(id_: str, initial: str, prect: Rect, size: float, justify: int, color: list[float] = DIM) -> None:
        p.box(id_, "comment", (460 + prect[0], 330 + prect[1], prect[2], prect[3]), text=initial, numinlets=1,
              numoutlets=0, presentation=1, presentation_rect=list(prect), fontname="Ableton Sans Medium",
              fontsize=size, textcolor=color, textjustification=justify)
        if id_ in TARGETS:
            p.wire("router", id_, TARGETS.index(id_), 0)

    text("scale", "play a chord", (8, 58, 408, 18), 11.0, 0)
    for pc in range(12):
        x = 8 + pc * COLUMN_W
        text(f"n{pc}", NOTE_NAMES[pc], (x, STRIP_Y, COLUMN_W, 16), 11.0, 1)
        # centered in a box wider than the column, so a value like +13.7 never wraps
        text(f"c{pc}", "-", (x - CENTS_OVERHANG, STRIP_Y + 16, COLUMN_W + 2 * CENTS_OVERHANG, 16), 10.0, 1)
    text("help", "Click a note to lock the root to it; click it again for auto.", (8, 116, 408, 14), 9.0, 0, HINT)
    text("steptext", "1 step = 0.59 c", (196, 38, 100, 14), 9.0, 0, HINT)

    # the portamento curve, drawn by the engine with lcd messages (moveto, lineto, frgb ...)
    p.box("curvegraph", "lcd", (900, 60, 60, 30), numinlets=1, numoutlets=4, outlettype=["list", "list", "int", ""],
          presentation=1, presentation_rect=[124, 4, 60, 30], border=0, ignoreclick=1,
          annotation="The shape of the portamento slide: time runs left to right, the pitch moves bottom to top. "
                     "Orange while portamento is on.", annotation_name="Porta Curve")
    p.wire("router", "curvegraph", TARGETS.index("curvegraph"), 0)

    # invisible click targets over each note column, added after the text so they sit on top
    for pc in range(12):
        x = 8 + pc * COLUMN_W
        p.box(f"hit{pc}", "ubutton", (460 + x, 420, COLUMN_W, 32), numinlets=1, numoutlets=4,
              outlettype=["bang", "bang", "", "int"], presentation=1, presentation_rect=[x, STRIP_Y, COLUMN_W, 32],
              hltcolor=[1.0, 1.0, 1.0, 0.12],
              annotation=f"Click to lock the tuning root to {NOTE_NAMES[pc]}; "
                         "click again to return to automatic root detection.",
              annotation_name=f"Lock root to {NOTE_NAMES[pc]}")
        p.box(f"hitmsg{pc}", "message", (460 + x, 460 + (pc % 2) * 22, 50, 20), text=f"click {pc}", numinlets=2,
              numoutlets=1, outlettype=[""], fontname="Arial Bold", fontsize=10.0)
        p.wire(f"hit{pc}", f"hitmsg{pc}")
        p.wire(f"hitmsg{pc}", "engine")


def add_controls(p: Patch) -> None:
    # live.thisdevice bangs each control on load, which re-sends its saved value to the engine
    p.obj("thisdevice", "live.thisdevice", (460, 20, 90, 20), 1, ["bang", "int", "int"])
    for i, c in enumerate(CONTROLS):
        x = 460 + i * 110
        p.box(c.id, c.maxclass, (x, 60, c.rect[2], c.rect[3]), varname=c.longname, numinlets=1, parameter_enable=1,
              presentation=1, presentation_rect=list(c.rect), saved_attribute_attributes={"valueof": c.param},
              annotation=c.hint, annotation_name=c.longname, numoutlets=len(c.outlettype), outlettype=c.outlettype)
        p.obj(c.id + "_pre", "prepend " + c.message, (x, 130, 90, 20), 1, [""])
        p.wire(c.id, c.id + "_pre")
        p.wire(c.id + "_pre", "engine")
        p.wire("thisdevice", c.id)
    p.wire("router", "rootmenu", TARGETS.index("lockmenu"), 0)

    def label(id_: str, text: str, prect: Rect) -> None:
        p.box(id_, "live.comment", (prect[0], prect[1] + 300, prect[2], prect[3]), text=text, numinlets=1,
              numoutlets=0, presentation=1, presentation_rect=list(prect), textjustification=0)

    label("porta_label", "Porta", (28, 22, 36, 15))
    label("range_label", "Bend range", (240, 22, 60, 15))
    label("root_label", "Root", (356, 6, 60, 15))
    label("chordwin_label", "Chord window: gather a strummed chord before tuning it", (56, 140, 300, 15))


def patcher(p: Patch) -> Json:
    return {
        "patcher": {
            "fileversion": 1,
            "appversion": {"major": 9, "minor": 1, "revision": 5, "architecture": "x64", "modernui": 1},
            "classnamespace": "box",
            "rect": [100.0, 100.0, 900.0, 600.0],
            "openrect": [0.0, 0.0, 424.0, 169.0],
            "openinpresentation": 1,
            "default_fontsize": 10.0,
            "default_fontface": 0,
            "default_fontname": "Arial Bold",
            "gridsize": [8.0, 8.0],
            "devicewidth": 424.0,
            "description": "Adaptive 5-limit just intonation: retunes each held note to pure ratios above the chord "
                           "root, via MPE.",
            "title": "OpenBend JI",
            "boxes": p.boxes,
            "lines": p.lines,
            "dependency_cache": [],
            "latency": 0,
            "is_mpe": 1,
            "external_mpe_tuning_enabled": 0,
            "minimum_live_version": "12.0",
            "minimum_max_version": "9.0.0",
            "platform_compatibility": 0,
            "project": {
                "version": 1, "creationdate": 3590052786, "modificationdate": 3590052786,
                "viewrect": [0.0, 0.0, 300.0, 500.0], "autoorganize": 1, "hideprojectwindow": 1,
                "showdependencies": 1, "autolocalize": 0, "contents": {"patchers": {}}, "layout": {},
                "searchpath": {}, "detailsvisible": 0, "amxdtype": 1835887981, "readonly": 0,
                "devpathtype": 0, "devpath": ".", "sortmode": 0, "viewmode": 0,
            },
            "autosave": 0,
        }
    }


def amxd(patch: Json) -> bytes:
    """The .amxd container: an "ampf" header for a MIDI effect ("mmmm"), empty metadata, then the patcher JSON."""
    body = json.dumps(patch, indent="\t").encode() + b"\n\x00"
    header = b"ampf" + struct.pack("<I", 4) + b"mmmm" + b"meta" + struct.pack("<I", 4) + struct.pack("<I", 0)
    return header + b"ptch" + struct.pack("<I", len(body)) + body


def main(argv: list[str]) -> None:
    p = Patch()
    add_midi_path(p, (HERE / "openbend_ji.js").read_text())
    add_readout(p)
    add_controls(p)
    data = amxd(patcher(p))
    out = Path(argv[1]) if len(argv) > 1 else DEFAULT_OUT
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    print(out, len(data), "bytes")


if __name__ == "__main__":
    main(sys.argv)
