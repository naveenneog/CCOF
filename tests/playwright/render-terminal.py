"""Renders a terminal log (already pseudonymised) as a PNG for the documentation.

Usage: python render-terminal.py <in.txt> <out.png> [--title "pwsh"] [--last N] [--highlight "text" ...]

Fixed width, dark theme and font, so every capture looks the same. Lines containing a --highlight string are
drawn in green (an expected success line); lines starting with "Exception" or containing "verify_failed" in red.
"""
import argparse
import textwrap
from PIL import Image, ImageDraw, ImageFont

COLS, PAD, LINE = 120, 18, 20
BG, FG, DIM, OK, BAD, BAR = (12, 12, 12), (204, 204, 204), (130, 130, 130), (98, 211, 124), (240, 96, 96), (36, 36, 36)


def font(size):
    for name in ("CascadiaMono.ttf", "consola.ttf", "cour.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--title", default="PowerShell 7")
    p.add_argument("--last", type=int, default=0)
    p.add_argument("--highlight", action="append", default=[])
    a = p.parse_args()
    raw = open(a.input, encoding="utf-8", errors="replace").read().replace("\r\n", "\n").rstrip("\n").split("\n")
    if a.last:
        raw = raw[-a.last:]
    lines = []
    for r in raw:
        lines.extend(textwrap.wrap(r, COLS, replace_whitespace=False, drop_whitespace=False) or [""])
    f = font(15)
    width = PAD * 2 + int(f.getlength("M") * COLS)
    height = PAD * 2 + 34 + LINE * len(lines)
    img = Image.new("RGB", (width, height), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, width, 30], fill=BAR)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([12 + i * 20, 9, 24 + i * 20, 21], fill=c)
    d.text((80, 7), a.title, font=font(14), fill=DIM)
    y = 30 + PAD
    for line in lines:
        color = FG
        if any(h in line for h in a.highlight):
            color = OK
        elif line.startswith("Exception") or "verify_failed" in line or line.lstrip().startswith("|"):
            color = BAD
        elif line.startswith("PS ") or line.startswith("> "):
            color = (120, 180, 255)
        d.text((PAD, y), line, font=f, fill=color)
        y += LINE
    img.save(a.output)


if __name__ == "__main__":
    main()
