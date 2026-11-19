#!/usr/bin/env python3
"""Rebuild the app's bundled fonts: static weights, subset to Hebrew + Latin + digits + punctuation.

    pip install fonttools brotli
    python subset_fonts.py <NotoSansHebrew[wdth,wght].ttf> <JetBrainsMono[wght].ttf> [out_dir]

Sources (SIL Open Font License 1.1), from https://github.com/google/fonts:
    ofl/notosanshebrew/NotoSansHebrew[wdth,wght].ttf
    ofl/jetbrainsmono/JetBrainsMono[wght].ttf
"""
import sys
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer


def ranges(*pairs):
    out = set()
    for a, b in pairs:
        out.update(range(a, b + 1))
    return out


LATIN = ranges((0x20, 0x7E), (0xA0, 0xA0), (0xA9, 0xA9), (0xAB, 0xAB), (0xB0, 0xB1), (0xB7, 0xB7), (0xBB, 0xBB), (0xD7, 0xD7))
PUNCT = ranges((0x2010, 0x2015), (0x2018, 0x201E), (0x2022, 0x2022), (0x2026, 0x2026), (0x2032, 0x2033),
               (0x2039, 0x203A), (0x20AA, 0x20AA), (0x20AC, 0x20AC), (0x2190, 0x2193), (0x2212, 0x2212))
BIDI = ranges((0x200C, 0x200F), (0x202A, 0x202E), (0x2066, 0x2069))
HEBREW = ranges((0x0591, 0x05C7), (0x05D0, 0x05EA), (0x05EF, 0x05F4), (0xFB1D, 0xFB4F), (0x25CC, 0x25CC))

JOBS = [
    # family file, axis pins, unicodes, weights, layout features
    ("NotoSansHebrew", {"wdth": 100}, LATIN | PUNCT | BIDI | HEBREW, (400, 500, 700), ["kern", "mark", "mkmk", "ccmp", "locl"]),
    ("JetBrainsMono", {}, LATIN | PUNCT, (500, 700), ["kern", "mark", "mkmk", "ccmp"]),
]


def build(source: Path, name: str, pins: dict, unicodes: set, weights, features, out: Path) -> None:
    for weight in weights:
        font = instancer.instantiateVariableFont(TTFont(source), {**pins, "wght": weight})
        options = Options()
        options.flavor = "woff2"
        options.layout_features = features
        options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]   # keep copyright and licence names
        options.notdef_outline = True
        options.hinting = False
        subsetter = Subsetter(options)
        subsetter.populate(unicodes=unicodes)
        subsetter.subset(font)
        target = out / f"{name}-{weight}.woff2"
        font.flavor = "woff2"
        font.save(target)
        print(f"{target.name}: {target.stat().st_size / 1024:.1f} KB, {len(font.getBestCmap())} characters")


def main() -> None:
    hebrew, mono = Path(sys.argv[1]), Path(sys.argv[2])
    out = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(__file__).resolve().parent
    out.mkdir(parents=True, exist_ok=True)
    for (name, pins, unicodes, weights, features), source in zip(JOBS, (hebrew, mono)):
        build(source, name, pins, unicodes, weights, features, out)


if __name__ == "__main__":
    main()
