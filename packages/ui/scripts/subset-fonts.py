"""
Cuts each Geist face down to the characters this product's pages are written in, so a page fetches about half the
bytes for the same text (fonts.css). The full file stays, and is fetched only for a character outside the cut.

    python3 -m pip install fonttools brotli
    python3 packages/ui/scripts/subset-fonts.py

Writes `fonts/<face>-Latin.woff2` next to each full file and prints, per family, the `unicode-range` the full file
keeps in fonts.css: what the font covers, less the cut. Outlines, hinting and every OpenType feature (tabular figures,
`cv11`, `ss01`) are kept, so the text is drawn exactly as before.
"""

from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

FONTS = Path(__file__).resolve().parent.parent / "fonts"

# Basic Latin and Latin-1, the punctuation and spaces of General Punctuation, super- and subscripts, the euro and the
# rupee, the arrows, and the few math signs the copy uses (− ≈ ≠ ≤ ≥). Keep in step with the `-Latin` faces in fonts.css.
LATIN = (
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,"
    "U+2070-209F,U+20AC,U+20B9,U+2122,U+2190-21FF,U+2212,U+2215,U+2248,U+2260,U+2264-2265,U+FEFF,U+FFFD"
)

FAMILIES = {
    "Geist": ["Geist-Regular", "Geist-Medium", "Geist-SemiBold"],
    "Geist Mono": ["GeistMono-Regular", "GeistMono-Medium"],
}


def parse(ranges: str) -> set[int]:
    points: set[int] = set()
    for part in ranges.split(","):
        lo, _, hi = part.removeprefix("U+").partition("-")
        points.update(range(int(lo, 16), int(hi or lo, 16) + 1))
    return points


def as_ranges(points: set[int]) -> str:
    out: list[str] = []
    run: list[int] = []
    for p in sorted(points):
        if run and p != run[-1] + 1:
            out.append(span(run))
            run = []
        run.append(p)
    if run:
        out.append(span(run))
    return ", ".join(out)


def span(run: list[int]) -> str:
    return f"U+{run[0]:04X}" if len(run) == 1 else f"U+{run[0]:04X}-{run[-1]:04X}"


latin = parse(LATIN)
for family, faces in FAMILIES.items():
    rest: set[int] = set()
    for face in faces:
        source = FONTS / f"{face}.woff2"
        options = subset.Options()
        options.layout_features = ["*"]
        options.flavor = "woff2"
        font = TTFont(source)
        rest |= set(font.getBestCmap()) - latin
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=latin)
        subsetter.subset(font)
        target = FONTS / f"{face}-Latin.woff2"
        font.flavor = "woff2"
        font.save(target)
        print(f"{target.name}: {source.stat().st_size} -> {target.stat().st_size} bytes")
    print(f"{family}, full file's unicode-range:\n  {as_ranges(rest)}\n")
