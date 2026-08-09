"""Single source for every Resparkable brand asset. Re-run to regenerate public/brand/."""
import os
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
OUT = f"{ROOT}/public/brand"
os.makedirs(OUT, exist_ok=True)

# ---- geometry -------------------------------------------------------------
# Lemniscate built only from straight facets: two hexagonal lobes sharing the
# vertex at C, with both diagonals running straight through it, so the ribbon
# genuinely crosses itself rather than two shapes merely touching.
CX, CY, SW = 32, 17, 4.6
LOOP = ("M32,17 L23,6 L12,6 L4,17 L12,28 L23,28 "
        "L32,17 L41,6 L52,6 L60,17 L52,28 L41,28 Z")
VB_W, VB_H = 64, 34
INK = (1.16, 3.70, 62.84, 30.30)          # after miter overshoot, measured

def sparkle(cx, cy, R, waist=.45):
    c = R * (1 - waist)
    n = lambda v: f"{v:g}"
    return (f"M{n(cx)},{n(cy-R)}"
            f"C{n(cx)},{n(cy-R+c)} {n(cx+R-c)},{n(cy)} {n(cx+R)},{n(cy)}"
            f"C{n(cx+R-c)},{n(cy)} {n(cx)},{n(cy+R-c)} {n(cx)},{n(cy+R)}"
            f"C{n(cx)},{n(cy+R-c)} {n(cx-R+c)},{n(cy)} {n(cx-R)},{n(cy)}"
            f"C{n(cx-R+c)},{n(cy)} {n(cx)},{n(cy-R+c)} {n(cx)},{n(cy-R)}Z")

SPARK, GAP = sparkle(CX, CY, 10.5), 2.8

LIGHT_HOT = "#c2410c"   # matches --color-primary on paper
DARK  = dict(ramp=("#a3480a", "#e0891c", "#f5a524"), core="#fff8ea", tip="#ffc65c",
             ink="#e9ebf2", hot="#f5a524")
LIGHT = dict(ramp=("#f0a882", "#dd6a2a", "#c2410c"), core="#fbbf24", tip="#f59e0b",
             ink="#1b1511", hot=LIGHT_HOT)

BLURB = ("A faceted infinity loop with a spark at its crossing: an idea captured, "
         "carried round, and lit again.")

def defs(p, ramp, core, tip, mw=VB_W, mh=VB_H):
    return f'''  <defs>
    <linearGradient id="{p}-ember" gradientUnits="userSpaceOnUse" x1="4" y1="30" x2="60" y2="4">
      <stop offset="0" {paint(ramp[0], "stop-color")}/><stop offset=".46" {paint(ramp[1], "stop-color")}/><stop offset="1" {paint(ramp[2], "stop-color")}/>
    </linearGradient>
    <radialGradient id="{p}-spark" gradientUnits="userSpaceOnUse" cx="{CX}" cy="{CY}" r="11.5">
      <stop offset="0" {paint(core, "stop-color")}/><stop offset="1" {paint(tip, "stop-color")}/>
    </radialGradient>
    <mask id="{p}-clear">
      <rect x="-10" y="-10" width="{mw+20}" height="{mh+20}" fill="#fff"/>
      <path d="{SPARK}" fill="#000" stroke="#000" stroke-width="{GAP}" stroke-linejoin="round"/>
    </mask>
  </defs>
'''

def art(p, indent="  "):
    return (f'{indent}<path mask="url(#{p}-clear)" fill="none" stroke="url(#{p}-ember)" '
            f'stroke-width="{SW}" stroke-miterlimit="10" d="{LOOP}"/>\n'
            f'{indent}<path fill="url(#{p}-spark)" d="{SPARK}"/>\n')

def write(name, body):
    open(f"{OUT}/{name}", "w").write(body)
    return name

# ---- 1. standalone mark ---------------------------------------------------
def mark(name, p, pal, style="", note=""):
    write(name, f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VB_W} {VB_H}" role="img" aria-labelledby="{p}-t {p}-d">
  <title id="{p}-t">Resparkable</title>
  <desc id="{p}-d">{BLURB}{note}</desc>{style}
{defs(p, pal["ramp"], pal["core"], pal["tip"])}{art(p)}</svg>
''')

ADAPT_VARS_T = ('''
  <style>
    :root{ --e0:#f0a882; --e1:#dd6a2a; --e2:#c2410c; --kc:#fbbf24; --kt:#f59e0b; --ink:#1b1511; --hot:LIGHTHOT; }
    @media (prefers-color-scheme: dark){
      :root{ --e0:#a3480a; --e1:#e0891c; --e2:#f5a524; --kc:#fff8ea; --kt:#ffc65c; --ink:#e9ebf2; --hot:#f5a524; }
    }
  </style>''')
def V(var, fallback):
    """Adaptive paint: CSS variable, with a static presentation-attribute fallback."""
    return (f"var({var})", fallback)

ADAPT = dict(ramp=(V("--e0", LIGHT["ramp"][0]), V("--e1", LIGHT["ramp"][1]), V("--e2", LIGHT["ramp"][2])),
             core=V("--kc", LIGHT["core"]), tip=V("--kt", LIGHT["tip"]),
             ink=V("--ink", LIGHT["ink"]), hot=V("--hot", LIGHT["hot"]))

def paint(v, prop):
    """Render a paint value as SVG attributes."""
    if isinstance(v, tuple):
        return f'{prop}="{v[1]}" style="{prop}:{v[0]}"'
    return f'{prop}="{v}"' 

ADAPT_VARS = ADAPT_VARS_T.replace("LIGHTHOT", LIGHT_HOT)
mark("resparkable-mark.svg", "rm", ADAPT, ADAPT_VARS, " Follows the viewer's colour scheme.")
mark("resparkable-mark-dark.svg", "rmd", DARK, note=" Ember ramp, for dark grounds.")
mark("resparkable-mark-light.svg", "rml", LIGHT, note=" Indigo ramp, for light grounds.")

write("resparkable-mark-mono.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VB_W} {VB_H}" fill="currentColor" role="img" aria-labelledby="rmm-t rmm-d">
  <title id="rmm-t">Resparkable</title>
  <desc id="rmm-d">{BLURB} Single colour, inherits currentColor.</desc>
  <mask id="rmm-clear">
    <rect x="-10" y="-10" width="{VB_W+20}" height="{VB_H+20}" fill="#fff"/>
    <path d="{SPARK}" fill="#000" stroke="#000" stroke-width="{GAP}" stroke-linejoin="round"/>
  </mask>
  <path mask="url(#rmm-clear)" fill="none" stroke="currentColor" stroke-width="{SW}" stroke-miterlimit="10" opacity=".7" d="{LOOP}"/>
  <path d="{SPARK}"/>
</svg>
''')

# ---- 2. icon tile (favicon / app icon) ------------------------------------
IS = .86
ix = (64 - (INK[2] - INK[0]) * IS) / 2 - INK[0] * IS
iy = (64 - (INK[3] - INK[1]) * IS) / 2 - INK[1] * IS
write("resparkable-icon.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-labelledby="ri-t ri-d">
  <title id="ri-t">Resparkable</title>
  <desc id="ri-d">{BLURB} Tile lockup for favicons and app icons.</desc>
{defs("ri", DARK["ramp"], DARK["core"], DARK["tip"], 64, 64)}  <rect width="64" height="64" rx="13" fill="#10121a"/>
  <rect x=".5" y=".5" width="63" height="63" rx="12.5" fill="none" stroke="#232732"/>
  <g transform="translate({ix:.2f} {iy:.2f}) scale({IS})">
{art("ri", "    ")}  </g>
</svg>
''')

# ---- 3. horizontal lockup (wordmark outlined, no font dependency) ---------
def find_martian_mono():
    """Locate the Martian Mono latin subset next/font cached under .next.

    next/font content-hashes the filename, so it moves on every dependency bump;
    resolve it by reading each candidate's name table rather than pinning a path.
    """
    import glob
    for path in sorted(glob.glob(f"{ROOT}/.next/**/static/media/*.woff2", recursive=True)):
        try:
            font = TTFont(path, lazy=True)
            family = font["name"].getDebugName(1) or ""
            if "Martian Mono" in family and "fvar" in font and 0x61 in font.getBestCmap():
                return path
        except Exception:
            continue
    raise SystemExit(
        "Martian Mono not found under .next — run `npm run dev` once so next/font "
        "caches the webfont, then re-run this script.")

f = instantiateVariableFont(TTFont(find_martian_mono()), {"wght": 600}, inplace=True)
gs, cmap, hmtx, UPEM = f.getGlyphSet(), f.getBestCmap(), f["hmtx"], f["head"].unitsPerEm
SIZE, TRACK = 24.0, -0.012 * 24.0
S = SIZE / UPEM
adv = lambda t: sum(hmtx[cmap[ord(c)]][0] * S + TRACK for c in t)

def outline(text, x, base):
    d = []
    for ch in text:
        g = cmap[ord(ch)]
        pen = SVGPathPen(gs, ntos=lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
        gs[g].draw(TransformPen(pen, (S, 0, 0, -S, x, base)))
        d.append(pen.getCommands()); x += hmtx[g][0] * S + TRACK
    return "".join(d)

bp = BoundsPen(gs); x = 0.0
for ch in "resparkable":
    gs[cmap[ord(ch)]].draw(TransformPen(bp, (1, 0, 0, 1, x, 0))); x += hmtx[cmap[ord(ch)]][0]
tx0, ty0, tx1, ty1 = [v * S for v in bp.bounds]
TXT_W, ASC, DESC = tx1 - tx0, ty1, -ty0

MS, PAD, GAPX = .90, 4.0, 21.0
mw, mh = (INK[2] - INK[0]) * MS, (INK[3] - INK[1]) * MS
base = PAD + ASC
mid  = base - (ASC - DESC) / 2
mx, my = PAD - INK[0] * MS, mid - mh / 2 - INK[1] * MS
if my < PAD:                                    # mark is the taller element
    d = PAD - my; my += d; base += d
W = PAD + mw + GAPX + TXT_W + PAD
H = max(base + DESC, my + INK[3] * MS) + PAD

runs, cx = [], PAD + mw + GAPX - tx0
for part, tone in (("re", "ink"), ("spark", "hot"), ("able", "ink")):
    runs.append((tone, outline(part, cx, base))); cx += adv(part)

def lockup(name, p, pal, style="", note=""):
    words = "\n".join(f'    <path {paint(pal[t], "fill")} d="{d}"/>' for t, d in runs)
    write(name, f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.1f} {H:.1f}" role="img" aria-labelledby="{p}-t {p}-d">
  <title id="{p}-t">Resparkable</title>
  <desc id="{p}-d">The Resparkable wordmark beside the mark. {BLURB}{note}</desc>{style}
{defs(p, pal["ramp"], pal["core"], pal["tip"])}  <g transform="translate({mx:.2f} {my:.2f}) scale({MS})">
{art(p, "    ")}  </g>
  <g>
{words}
  </g>
</svg>
''')

lockup("resparkable-logo.svg", "rl", ADAPT, ADAPT_VARS, " Follows the viewer's colour scheme.")
lockup("resparkable-logo-dark.svg", "rld", DARK, note=" Ember ramp, for dark grounds.")
lockup("resparkable-logo-light.svg", "rll", LIGHT, note=" Indigo ramp, for light grounds.")

mono_words = "\n".join(f'    <path d="{d}"/>' for _, d in runs)
write("resparkable-logo-mono.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.1f} {H:.1f}" fill="currentColor" role="img" aria-labelledby="rlm-t rlm-d">
  <title id="rlm-t">Resparkable</title>
  <desc id="rlm-d">The Resparkable wordmark beside the mark. {BLURB} Single colour, inherits currentColor.</desc>
  <mask id="rlm-clear">
    <rect x="-10" y="-10" width="{VB_W+20}" height="{VB_H+20}" fill="#fff"/>
    <path d="{SPARK}" fill="#000" stroke="#000" stroke-width="{GAP}" stroke-linejoin="round"/>
  </mask>
  <g transform="translate({mx:.2f} {my:.2f}) scale({MS})">
    <path mask="url(#rlm-clear)" fill="none" stroke="currentColor" stroke-width="{SW}" stroke-miterlimit="10" opacity=".7" d="{LOOP}"/>
    <path d="{SPARK}"/>
  </g>
  <g>
{mono_words}
  </g>
</svg>
''')
print(f"lockup {W:.1f}x{H:.1f}  mark@({mx:.2f},{my:.2f})x{MS}  baseline {base:.2f}")
print("files:", len([n for n in os.listdir(OUT) if n.endswith('.svg')]))
