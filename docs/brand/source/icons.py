"""Penmoss logo options: hand-placed geometry on a 1024x1024 canvas.

Each icon is a function (bg, c1, c2) -> inner SVG markup. bg is the tile colour and is also
used for knockout "gap" strokes so shapes stay separate in the one-colour version.
Content stays within a ~340 px radius of the centre (Android adaptive safe zone).
"""
import math

TILE_RX = 228


def f(n):
    """Format a number compactly."""
    n = round(n, 1)
    return str(int(n)) if n == int(n) else str(n)


def pts(*xy):
    return " ".join(f(v) for v in xy)


def scallop_path(points, bulge=0.62, sweep=1):
    """Arcs between successive points, each bulging outward (radius = chord * bulge)."""
    d = []
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        r = math.hypot(x2 - x1, y2 - y1) * bulge
        d.append(f"A{f(r)} {f(r)} 0 0 {sweep} {f(x2)} {f(y2)}")
    return " ".join(d)


def circ_pt(cx, cy, r, deg):
    a = math.radians(deg)
    return (cx + r * math.cos(a), cy + r * math.sin(a))


def dome(cx, cy, r, base):
    """Circle (cx,cy,r) clipped at y=base, as a path (centre above base)."""
    dx = math.sqrt(r * r - (base - cy) ** 2)
    large = 1 if cy < base else 0
    return f"M{f(cx - dx)} {f(base)}A{f(r)} {f(r)} 0 {large} 1 {f(cx + dx)} {f(base)}Z"


# ---------------------------------------------------------------- 01 Nib Stroke
def i01(bg, c1, c2):
    # Upright nib (point down) built on x=512, then rotated so the point aims down-left.
    nib = "M404 392H620V486L512 744L404 486Z"
    grip = "M432 250H592V364H432Z"
    trail = (
        f'<path d="{dome(356, 720, 62, 770)}" fill="{c2}"/>'
        f'<path d="{dome(484, 706, 90, 770)}" fill="{c2}"/>'
        f'<path d="{dome(650, 700, 110, 770)}" fill="{c2}"/>'
    )
    return (
        f'<g transform="rotate(40 512 512) translate(40 -150)">'
        f'<path d="{grip}" fill="{c1}"/><path d="{nib}" fill="{c1}"/></g>'
        f'{trail}'
    )


# ---------------------------------------------------------------- 02 Quill Frond
def _quad(p0, p1, p2, t):
    return tuple((1 - t) ** 2 * a + 2 * (1 - t) * t * b + t * t * c for a, b, c in zip(p0, p1, p2))


def i02(bg, c1, c2):
    # A quill: straight shaft (nib end lower-left) with a one-sided vane and two barb splits.
    p0, p2 = (300, 800), (776, 260)
    L = math.hypot(p2[0] - p0[0], p2[1] - p0[1])
    ux, uy = (p2[0] - p0[0]) / L, (p2[1] - p0[1]) / L
    lx, ly = uy, -ux  # upper-left side

    def on(t, off=0.0):
        return (p0[0] + ux * L * t + lx * off, p0[1] + uy * L * t + ly * off)

    vane = (f"M{pts(*on(0.26))}C{pts(*on(0.30, 270))} {pts(*on(0.80, 300))} {pts(*on(1.0))}"
            f"L{pts(*on(0.26))}Z")
    splits = ""
    for t in (0.50, 0.70):
        a, b = on(t - 0.08, 340), on(t, 90)
        splits += f"M{pts(*a)}L{pts(*b)}"
    return (
        f'<path d="{vane}" fill="{c2}"/>'
        f'<path d="{splits}" stroke="{bg}" stroke-width="36" stroke-linecap="butt"/>'
        f'<path d="M{pts(*p0)}L{pts(*p2)}" stroke="{c1}" stroke-width="76" stroke-linecap="round"/>'
        f'<path d="M330 770L244 862L362 800Z" fill="{c1}"/>'
    )


# ---------------------------------------------------------------- 03 Twig Pencil
def i03(bg, c1, c2):
    # Body: a twig lying at ~ -35deg; sharpened point at lower left, leaf sprouting at top.
    g = (
        '<g transform="rotate(-34 512 512) translate(0 60)">'
        f'<path d="M392 456H792A56 56 0 0 1 792 568H392Z" fill="{c1}"/>'  # twig body
        f'<path d="M362 456V568L196 512Z" fill="{c1}"/>'  # sharpened point
        f'<path d="M600 456C606 340 690 262 812 250C812 372 730 446 616 456Z" fill="{c2}" stroke="{bg}" stroke-width="28" paint-order="stroke"/>'
        '</g>'
    )
    return g


# ---------------------------------------------------------------- 04 Fiddlehead
def i04(bg, c1, c2):
    cx, cy, r0, g = 548, 430, 46, 150
    d = (
        f"M{f(cx + r0)} {f(cy)}"
        f"A{f(r0)} {f(r0)} 0 0 0 {f(cx - r0)} {f(cy)}"
        f"A{f(r0 + g / 2)} {f(r0 + g / 2)} 0 0 0 {f(cx + r0 + g)} {f(cy)}"
        f"A{f(r0 + g)} {f(r0 + g)} 0 0 0 {f(cx - r0 - g)} {f(cy)}"
        f"C{f(cx - r0 - g)} {f(cy + 170)} {f(cx - 150)} {f(cy + 290)} {f(cx - 40)} {f(cy + 360)}"
    )
    return f'<path d="{d}" fill="none" stroke="{c1}" stroke-width="84" stroke-linecap="round"/>' \
           ''


# ---------------------------------------------------------------- 05 Moss Hummocks
def i05(bg, c1, c2):
    # "pen" as in enclosure: a fenced square with a gate, a moss mound kept inside
    fence = ("M436 250H340A90 90 0 0 0 250 340V684A90 90 0 0 0 340 774H684"
             "A90 90 0 0 0 774 684V340A90 90 0 0 0 684 250H588")
    cx, base, rx, ry = 512, 712, 176, 250
    top = [(cx + rx * math.cos(math.radians(a)), base + ry * math.sin(math.radians(a)))
           for a in (180, 216, 252, 288, 324, 360)]
    mound = f"M{pts(*top[0])}" + scallop_path(top, bulge=0.6, sweep=1) + "Z"
    return (f'<path d="{fence}" fill="none" stroke="{c1}" stroke-width="64" stroke-linecap="round"/>'
            f'<path d="{mound}" fill="{c2}"/>')


# ---------------------------------------------------------------- 06 Mossy Stone
def i06(bg, c1, c2):
    stone = "M228 652C228 520 340 444 500 440C672 436 800 500 800 628C800 728 700 772 520 772C340 772 228 744 228 652Z"
    moss = [(300, 600, 70), (390, 520, 88), (512, 486, 80), (618, 500, 56)]
    halo = "".join(f'<circle cx="{x}" cy="{y}" r="{r + 22}" fill="{bg}"/>' for x, y, r in moss)
    fill = "".join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{c2}"/>' for x, y, r in moss)
    return f'<g transform="translate(-40 -88) scale(1.08)"><path d="{stone}" fill="{c1}"/>{halo}{fill}</g>'


# ---------------------------------------------------------------- 07 Sprout
def i07(bg, c1, c2):
    stem = "M512 790V560"
    leaf_l = "M506 560C500 430 400 360 250 380C260 510 360 580 506 560Z"
    leaf_r = "M518 520C530 420 600 360 724 360C722 470 650 530 518 520Z"
    return (
        f'<path d="{stem}" stroke="{c1}" stroke-width="64" stroke-linecap="round" fill="none"/>'
        f'<path d="{leaf_l}" fill="{c1}"/><path d="{leaf_r}" fill="{c1}"/>'
        f'<rect x="300" y="784" width="424" height="56" rx="28" fill="{c2}"/>'
    )


# ---------------------------------------------------------------- 08 Lichen
def i08(bg, c1, c2):
    cx, cy = 512, 512
    angs = [-90, -54, -18, 16, 50, 86, 120, 156, 194, 232, 270]
    rads = [262, 236, 284, 248, 290, 240, 280, 246, 288, 240, 262]
    p = [circ_pt(cx, cy, r, a) for r, a in zip(rads, angs)]
    p[-1] = p[0]
    d = f"M{pts(*p[0])}" + scallop_path(p, bulge=0.56, sweep=1) + "Z"
    spots = [(418, 424, 58), (540, 548, 44), (644, 650, 30)]
    s = "".join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{c2}"/>' for x, y, r in spots)
    return f'<path d="{d}" fill="{c1}"/>{s}'


# ---------------------------------------------------------------- 09 Moss P
def i09(bg, c1, c2):
    ox = -14
    stem = f'<rect x="{300 + ox}" y="220" width="124" height="584" rx="22" fill="{c1}"/>'
    cx, cy, r = 556 + ox, 392, 172
    pts_ = [circ_pt(cx, cy, r, a) for a in (-90, -30, 30, 90)]
    d = (f"M{f(454 + ox)} 220H{f(cx)}" + scallop_path(pts_, bulge=0.62, sweep=1)
         + f"H{f(454 + ox)}Z")
    return stem + f'<path d="{d}" fill="{c2}"/>'


# ---------------------------------------------------------------- 10 pm Ligature
def i10(bg, c1, c2):
    # one stroke: p stem (descender) + p bowl whose right side is the m's first stem, then two arches.
    d = ("M236 806V406H404A84 84 0 0 1 488 490V626"
         "M236 626H488"
         "M488 490A84 84 0 0 1 656 490V626"
         "M656 490A84 84 0 0 1 824 490V626")
    return f'<g transform="translate(-18 -2)"><path d="{d}" fill="none" stroke="{c1}" stroke-width="80" stroke-linecap="round" stroke-linejoin="round"/>' \
           f'<circle cx="824" cy="776" r="46" fill="{c2}"/></g>'


# ---------------------------------------------------------------- 11 Cell P
def hexagon(cx, cy, r):
    p = [circ_pt(cx, cy, r, a) for a in range(0, 360, 60)]
    return "M" + "L".join(pts(*q) for q in p) + "Z"


def i11(bg, c1, c2):
    s = 104  # grid circumradius
    hr = 90  # drawn radius (gap)
    x0, y0 = 360, 330
    hs = math.sqrt(3) * s
    stem = [(0, 0), (0, 1), (0, 2)]
    bowl = [(1, -0.5), (1, 0.5), (2, 0)]
    def at(c, r):
        return (x0 + 1.5 * s * c, y0 + hs * r)
    st = "".join(hexagon(*at(c, r), hr) for c, r in stem)
    bw = "".join(hexagon(*at(c, r), hr) for c, r in bowl)
    return f'<g transform="translate(-4 47)"><path d="{st}" fill="{c1}"/><path d="{bw}" fill="{c2}"/></g>'


# ---------------------------------------------------------------- 12 Dog-ear
def i12(bg, c1, c2):
    x1, y1, x2, y2, k, r = 272, 210, 752, 814, 196, 44
    page = (f"M{x1 + r} {y1}H{x2 - k}L{x2} {y1 + k}V{y2 - r}A{r} {r} 0 0 1 {x2 - r} {y2}"
            f"H{x1 + r}A{r} {r} 0 0 1 {x1} {y2 - r}V{y1 + r}A{r} {r} 0 0 1 {x1 + r} {y1}Z")
    gap = 26
    flap = f"M{x2 - k - 0} {y1 + gap * 1.4}L{x2 - gap * 1.4} {y1 + k}H{x2 - k + 30}A30 30 0 0 1 {x2 - k} {y1 + k - 30}Z"
    return f'<path d="{page}" fill="{c1}"/><path d="{flap}" fill="{c2}"/>'


# ---------------------------------------------------------------- 13 Note Lines
def i13(bg, c1, c2):
    bars = (f'<rect x="228" y="300" width="568" height="80" rx="40" fill="{c1}"/>'
            f'<rect x="228" y="472" width="400" height="80" rx="40" fill="{c1}"/>'
            f'<rect x="228" y="644" width="300" height="80" rx="40" fill="{c2}"/>')
    leaf = f'<path d="M548 684C560 560 660 480 800 480C796 610 700 684 548 684Z" fill="{c2}"/>'
    return bars + leaf


# ---------------------------------------------------------------- 14 Inkwell
def i14(bg, c1, c2):
    jar = ("M364 548H660A64 64 0 0 1 724 612V748A64 64 0 0 1 660 812H364A64 64 0 0 1 300 748V612A64 64 0 0 1 364 548Z"
           "M440 500H584V548H440Z"
           "M420 466H604A18 18 0 0 1 622 484V500H402V484A18 18 0 0 1 420 466Z")
    label = f'<rect x="364" y="640" width="296" height="92" rx="20" fill="{bg}"/>'
    sprout = (f'<path d="M512 470V350" stroke="{c2}" stroke-width="48" stroke-linecap="round" fill="none"/>'
              f'<path d="M506 372C500 280 430 222 330 236C334 330 410 384 506 372Z" fill="{c2}"/>'
              f'<path d="M520 340C528 268 584 220 680 222C676 300 618 348 520 340Z" fill="{c2}"/>')
    return f'<path d="{jar}" fill="{c1}"/>' + label + sprout


# ---------------------------------------------------------------- 15 Contour Hill
def i15(bg, c1, c2):
    arch = "M200 730C262 500 380 330 536 330C690 330 790 480 824 730"
    hill = "M352 770C392 600 466 500 566 500C660 500 712 600 730 770Z"
    return (f'<g transform="translate(0 -18)"><path d="{arch}" fill="none" stroke="{c1}" stroke-width="80" stroke-linecap="round"/>'
            f'<path d="{hill}" fill="{c2}"/></g>')


# ---------------------------------------------------------------- 16 Dot Grid
def i16(bg, c1, c2):
    xs = [302, 442, 582, 722]
    sizes = [[22, 22, 22, 22],
             [44, 22, 22, 22],
             [62, 50, 22, 22],
             [64, 64, 54, 34]]
    out = []
    for ri, row in enumerate(sizes):
        for ci, r in enumerate(row):
            col = c2 if r >= 34 else c1
            out.append(f'<circle cx="{xs[ci]}" cy="{xs[ri]}" r="{r}" fill="{col}"/>')
    return "".join(out)


# ---------------------------------------------------------------- 17 Pixel Moss
PIX = [
    ".....LL",
    "LL..LLL",
    "LLL.LL.",
    ".LLSL..",
    "...S...",
    "..MSMM.",
    ".MMMMMM",
]


def i17(bg, c1, c2):
    p, x0, y0 = 84, 512 - 3.5 * 84, 512 - 3.5 * 84
    runs = {"L": [], "S": [], "M": []}
    for r, row in enumerate(PIX):
        c = 0
        while c < len(row):
            ch = row[c]
            if ch == ".":
                c += 1
                continue
            s = c
            while c < len(row) and row[c] == ch:
                c += 1
            runs[ch].append(f"M{f(x0 + s * p)} {f(y0 + r * p)}h{f((c - s) * p)}v{p}h{f(-(c - s) * p)}Z")
    return (f'<path d="{"".join(runs["L"] + runs["S"])}" fill="{c1}"/>'
            f'<path d="{"".join(runs["M"])}" fill="{c2}"/>')


# ---------------------------------------------------------------- 18 Moss Sprite
def i18(bg, c1, c2):
    cx, cy, R = 512, 560, 250
    top = [circ_pt(cx, cy, R, a) for a in (-168, -132, -90, -48, -12)]
    d = f"M{pts(*top[0])}" + scallop_path(top, bulge=0.6, sweep=1)
    d += f"A{R} {R} 0 1 1 {pts(*top[0])}Z"
    eyes = (f'<circle cx="436" cy="600" r="38" fill="{c2}"/>'
            f'<circle cx="588" cy="600" r="38" fill="{c2}"/>')
    return f'<path d="{d}" fill="{c1}"/>' + eyes


# ---------------------------------------------------------------- 19 Moss Turtle
def i19(bg, c1, c2):
    base = 620
    cx, cy, R = 470, 620, 244
    a0, a1 = 180, 360
    angles = [180, 216, 252, 288, 324, 360]
    p = [circ_pt(cx, cy, R, a) for a in angles]
    shell = f"M{pts(*p[0])}" + scallop_path(p, bulge=0.6, sweep=1) + "Z"
    body = (f'<rect x="236" y="{base + 16}" width="480" height="70" rx="35" fill="{c1}"/>'
            f'<rect x="282" y="{base + 50}" width="88" height="100" rx="34" fill="{c1}"/>'
            f'<rect x="560" y="{base + 50}" width="88" height="100" rx="34" fill="{c1}"/>'
            f'<path d="M680 {base + 46}L748 {base + 6}" stroke="{c1}" stroke-width="84" stroke-linecap="round"/>'
            f'<circle cx="782" cy="{base - 8}" r="74" fill="{c1}"/>'
            f'<circle cx="806" cy="{base - 22}" r="16" fill="{bg}"/>')
    return f'<path d="{shell}" fill="{c2}"/>' + body


# ---------------------------------------------------------------- 20 Wordmark "p."
def i20(bg, c1, c2):
    # thick monoline p: ring bowl + stem, then a moss full stop on the baseline
    t = "translate(-86 -46)"
    ring = f'<circle cx="530" cy="500" r="138" fill="none" stroke="{c1}" stroke-width="112"/>'
    stem = f'<rect x="336" y="306" width="112" height="520" rx="10" fill="{c1}"/>'
    dot = f'<circle cx="812" cy="626" r="66" fill="{c2}"/>'
    return f'<g transform="{t}">{ring}{stem}{dot}</g>'


OPTIONS = [
    # (num, name, concept, palettes: primary/dark/light as (bg,c1,c2), palette label)
    ("Nib Stroke", i01, "A writing nib whose stroke lands as a growing cushion of moss.",
     ("#1C2430", "#F2EEE3", "#B5D25A"), ("#11161D", "#F2EEE3", "#B5D25A"), ("#F6F2E8", "#1C2430", "#5E9A3E"),
     "Ink blue-black, paper, lime"),
    ("Quill Frond", i02, "A quill whose vane is a one-sided fern frond.",
     ("#F4EFE4", "#A4482A", "#2F5B3C"), ("#16201A", "#E9915F", "#86B865"), ("#F4EFE4", "#A4482A", "#2F5B3C"),
     "Warm paper, rust, deep forest"),
    ("Twig Pencil", i03, "A sharpened twig that still puts out a leaf: a pen that grows.",
     ("#B4532F", "#F7EEE2", "#D9E58A"), ("#1B1714", "#E8A07C", "#B9D25A"), ("#F6F0E6", "#9C4526", "#5E9A3E"),
     "Rust, paper, lime"),
    ("Fiddlehead", i04, "A fern fiddlehead uncurling, like a thought being written out.",
     ("#1F3A2A", "#C4DA52", "#F2EEDF"), ("#111A15", "#C4DA52", "#F2EEDF"), ("#F3F1E7", "#24452F", "#7DA53A"),
     "Deep forest, lime, paper"),
    ("Moss Pen", i05, "Pen as in enclosure: a fenced plot with its gate open and moss kept inside. Your own patch, self-hosted.",
     ("#F3EEDF", "#2E5A3A", "#86AE5E"), ("#14201A", "#9CC870", "#4E7F45"), ("#F3EEDF", "#2E5A3A", "#86AE5E"),
     "Warm paper, forest, moss"),
    ("Mossy Stone", i06, "A river stone with moss creeping over one shoulder: quiet, kept, local.",
     ("#E9ECE6", "#5B6670", "#5E9A3E"), ("#1A1E22", "#8E99A3", "#8DBF5A"), ("#E9ECE6", "#5B6670", "#5E9A3E"),
     "Slate, cool paper, moss"),
    ("Sprout", i07, "A seedling rising from an underline: notes that grow.",
     ("#CFE06A", "#1F3A27", "#1F3A27"), ("#16221B", "#CFE06A", "#7FA94B"), ("#F4F2E6", "#1F3A27", "#7FA94B"),
     "Lime lichen, deep forest"),
    ("Lichen", i08, "A lobed lichen rosette with its spore cups, as on a stone.",
     ("#3E4852", "#CFE07A", "#E58A3A"), ("#171B20", "#CFE07A", "#E58A3A"), ("#EEF0EA", "#6E8F2E", "#C0612B"),
     "Slate, lime lichen, orange"),
    ("Moss P", i09, "A capital P: an ink stem with a cushion of moss for its bowl.",
     ("#F5F1E8", "#1B2230", "#4E8A47"), ("#141922", "#ECE7DA", "#7DB65E"), ("#F5F1E8", "#1B2230", "#4E8A47"),
     "Warm paper, ink, moss"),
    ("pm Ligature", i10, "One continuous pm: the p's bowl becomes the m, whose arches are hills.",
     ("#A9472A", "#F7EFE3", "#F2C08F"), ("#1D1613", "#F2B48C", "#F7EFE3"), ("#F7EFE3", "#A9472A", "#2F5B3C"),
     "Rust, paper"),
    ("Cell P", i11, "Six moss leaf-cells, the way they look under a lens, arranged into a P.",
     ("#1A2233", "#7DB65E", "#C4DA52"), ("#0F141D", "#7DB65E", "#C4DA52"), ("#F3F2EC", "#2E5A3A", "#7DA53A"),
     "Ink navy, moss, lime"),
    ("Dog-ear", i12, "A page with its corner folded down, and the fold is moss.",
     ("#213B2C", "#F4EFE2", "#9CC870"), ("#121A15", "#F4EFE2", "#9CC870"), ("#E7E3D6", "#FBF9F3", "#4E8A47"),
     "Deep forest, paper, moss"),
    ("Note Lines", i13, "Three lines of a note; the last one puts out a leaf.",
     ("#F3ECDD", "#22293A", "#4F8A3F"), ("#141820", "#E9E4D6", "#8DBF5A"), ("#F3ECDD", "#22293A", "#4F8A3F"),
     "Warm paper, ink, moss"),
    ("Inkwell", i14, "An inkwell growing a sprout instead of holding a pen.",
     ("#F4F0E6", "#1F3557", "#5E9A3E"), ("#121722", "#C9D6EA", "#B5D25A"), ("#F4F0E6", "#1F3557", "#5E9A3E"),
     "Paper, ink blue, moss"),
    ("Contour Hill", i15, "A contour line around a mossy summit: the shape of a quiet hill on a map.",
     ("#3B4550", "#E6EAE3", "#C5DA6A"), ("#15191E", "#E6EAE3", "#C5DA6A"), ("#EEF0EA", "#3B4550", "#6E9A35"),
     "Slate, paper, lime"),
    ("Dot Grid", i16, "Dot-grid paper, with moss spreading across it from one corner.",
     ("#F5F1E8", "#2A3140", "#4E8B44"), ("#141922", "#8A93A3", "#86C06A"), ("#F5F1E8", "#2A3140", "#4E8B44"),
     "Warm paper, ink, moss"),
    ("Pixel Moss", i17, "A chunky pixel sprout on a mound, drawn to be crisp at 16 px.",
     ("#17301F", "#B5D25A", "#5E9A3E"), ("#0F1A13", "#B5D25A", "#5E9A3E"), ("#F2F1E8", "#5E9A3E", "#24452F"),
     "Deep forest, lime, moss"),
    ("Moss Sprite", i18, "A small, round moss creature: friendly, a little shy.",
     ("#F4EEE0", "#5D9447", "#1C2230"), ("#151B17", "#7DB65E", "#151B17"), ("#F4EEE0", "#5D9447", "#1C2230"),
     "Warm paper, moss, ink"),
    ("Moss Turtle", i19, "A slow, steady turtle wearing a cushion of moss as its shell.",
     ("#202838", "#ECE7DA", "#B5D25A"), ("#11151D", "#ECE7DA", "#B5D25A"), ("#F4F0E6", "#2E3A48", "#5E9A3E"),
     "Ink, paper, lime"),
    ("p. Wordmark", i20, "Wordmark-led: penmoss. with a moss full stop; the icon is just p.",
     ("#F6F2EA", "#171C26", "#4E8B44"), ("#12161E", "#F1ECE0", "#7DB65E"), ("#F6F2EA", "#171C26", "#4E8B44"),
     "Warm paper, ink, moss"),
]




FIT = [(0.811, 41.6, 130.8), (0.756, 112.1, 103.1), (0.826, 50.5, 134.7), (0.997, -33.3, 2.6), (0.882, 61.2, 61.2), (1.009, -6.8, -40.1), (0.958, 46.2, -62.0), (1.045, -20.1, -27.5), (0.887, 59.6, 62.3), (0.811, 95.1, 22.9), (0.887, 58.7, 57.8), (0.875, 64.9, 64.9), (0.95, 24.7, 26.6), (0.95, 26.6, 21.9), (0.783, 111.7, 111.7), (0.936, 47.7, 14.0), (0.778, 114.6, 114.6), (1.06, -29.7, -69.9), (0.973, -3.6, -30.8), (0.868, 60.7, 61.5)]

MONO_LIGHT = ("#FFFFFF", "#1E2228")
MONO_DARK = ("#2A2E33", "#FFFFFF")


def svg(i, pal, size, label=None, tile=True, fit=True):
    bg, c1, c2 = pal
    fn = OPTIONS[i][1]
    attrs = f'width="{size}" height="{size}" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"'
    if label:
        attrs += f' role="img" aria-label="{label}"'
    else:
        attrs += ' aria-hidden="true"'
    back = f'<rect width="1024" height="1024" rx="{TILE_RX}" fill="{bg}"/>' if tile else ""
    k, tx, ty = FIT[i] if fit else (1, 0, 0)
    body = fn(bg, c1, c2)
    if fit:
        body = f'<g transform="matrix({k:g} 0 0 {k:g} {f(tx)} {f(ty)})">{body}</g>'
    return f'<svg {attrs}>{back}{body}</svg>'


MONO_KNOCKOUT = {7, 17}  # details (lichen spots, sprite eyes) become holes in one colour


def mono(i, which, size):
    bg, fg = MONO_LIGHT if which == "light" else MONO_DARK
    return svg(i, (bg, fg, bg if i in MONO_KNOCKOUT else fg), size)
