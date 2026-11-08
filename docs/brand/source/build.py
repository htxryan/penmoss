import json, os, datetime, html
import icons

OUT = "/tmp/claude-1000/-home-agent-personal-assistant/ed3fe5a7-a8d1-54b6-b228-4dfbc7d48b02/scratchpad/logo-canvas/project"
os.makedirs(OUT, exist_ok=True)

BW, BH = 520, 640
MW, MH = 1360, 900
GAPX, GAPY = 80, 120
ROW_W = 5 * BW + 4 * GAPX
ROW0_Y = 1300
NOTE_Y = 1060

FONT_LINK = ('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
             'family=Fraunces:opsz,wght@9..144,600&amp;display=swap">')


def page(title, w, h, css, body, extra_head=""):
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{html.escape(title)}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
{extra_head}<style>
body{{margin:0}}
{css}
</style>
</helmet>
{body}
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":{w},"height":{h}}}}}'>
class Component extends DCLogic {{
renderVals() {{ return {{}}; }}
}}
</script>
</body>
</html>
"""


def title_of(i):
    return f"{i + 1:02d} · {icons.OPTIONS[i][0]}"


# ------------------------------------------------------------------ canvas.json
now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
boards = {"Main.dc.html": {"x": 0, "y": 0, "w": MW, "h": MH, "title": "Overview · all 20"}}
order = ["Main.dc.html"]
for i in range(20):
    r, c = divmod(i, 5)
    name = f"Option{i + 1:02d}.dc.html"
    boards[name] = {"x": c * (BW + GAPX), "y": ROW0_Y + r * (BH + GAPY), "w": BW, "h": BH, "title": title_of(i)}
    order.append(name)
canvas = {
    "v": 3,
    "createdOnFiles": {"v": 1, "at": now},
    "title": "Penmoss Logo Options",
    "launch": {"view": "canvas"},
    "pages": [],
    "boards": boards,
    "order": order,
    "notes": {
        "note-title": {"kind": "title1", "x": 0, "y": NOTE_Y, "maxW": ROW_W,
                       "text": "20 directions · comment on any you like"}
    },
    "designSystems": [],
}
with open(f"{OUT}/canvas.json", "w") as fh:
    json.dump(canvas, fh, indent=2, ensure_ascii=False)
    fh.write("\n")

# ------------------------------------------------------------------ Main
main_css = """.m-grid{display:grid;grid-template-columns:repeat(5,1fr);row-gap:32px;column-gap:16px}
.m-cell{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center}
.m-ic{display:block;border-radius:22.27%;box-shadow:0 0 0 1px rgba(29,33,28,.10),0 2px 6px rgba(29,33,28,.08)}
.m-name{font-size:15px;font-weight:600}
.m-pal{font-size:12px;color:#565B53}"""
cells = []
for i, o in enumerate(icons.OPTIONS):
    cells.append(
        f'<div class="m-cell">{icons.svg(i, o[3], 96).replace("<svg ", "<svg class=\"m-ic\" ", 1)}'
        f'<div class="m-name">{html.escape(title_of(i))}</div><div class="m-pal">{html.escape(o[6])}</div></div>')
main_body = f"""<div style="width: {MW}px; height: {MH}px; box-sizing: border-box; padding: 44px 48px; display: flex; flex-direction: column; gap: 28px; background: #F6F5F0; color: #1d211c; font-family: system-ui, sans-serif">
<div style="display: flex; flex-direction: column; gap: 6px">
<div style="font-size: 30px; font-weight: 700; letter-spacing: -0.01em">Penmoss logo options</div>
<div style="font-size: 15px; color: #565B53">20 directions at 96 px app-icon size. Each has its own board below with small sizes, dark, light and one-colour versions.</div>
</div>
<div class="m-grid">
{chr(10).join(cells)}
</div>
</div>"""
with open(f"{OUT}/Main.dc.html", "w") as fh:
    fh.write(page("Penmoss logo options", MW, MH, main_css, main_body))

# ------------------------------------------------------------------ Options
opt_css = """.hd{font-size:24px;font-weight:700;letter-spacing:-0.01em}
.ic{display:block;border-radius:22.27%;box-shadow:0 0 0 1px rgba(29,33,28,.10)}
.top{display:flex;gap:24px}
.side{display:flex;flex-direction:column;gap:12px;flex:1}
.lbl{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#565B53}
.sizes{display:flex;align-items:flex-end;gap:16px}
.sz{display:flex;flex-direction:column;align-items:center;gap:6px;font-size:12px;color:#565B53}
.lock{display:flex;align-items:center;gap:10px;font-size:24px;font-weight:650;letter-spacing:-0.01em}
.tiles{display:flex;justify-content:space-between}
.tl{display:flex;flex-direction:column;align-items:center;gap:6px;font-size:12px;color:#565B53;width:96px;text-align:center}
.concept{margin:0;font-size:15px;line-height:1.4}
.pal{margin:0;font-size:13px;color:#565B53}
.wm{font-family:'Fraunces',Georgia,serif;font-weight:600}"""


def ic(svg_markup):
    return svg_markup.replace("<svg ", '<svg class="ic" ', 1)


for i, o in enumerate(icons.OPTIONS):
    name, _, concept, prim, dark, light, pal = o
    is_wm = i == 19
    label = f"Penmoss logo option {i + 1:02d}, {name}"
    big = ic(icons.svg(i, prim, 240, label=label))
    sizes = "".join(f'<div class="sz">{ic(icons.svg(i, prim, s))}<span>{s}</span></div>' for s in (64, 32, 16))
    if is_wm:
        word = '<span class="wm" style="font-size: 30px">penmoss<span style="color: #3F7A37">.</span></span>'
    else:
        word = "<span>Penmoss</span>"
    lock = f'<div class="lock">{ic(icons.svg(i, prim, 44))}{word}</div>'
    tiles = "".join(
        f'<div class="tl">{ic(svgm)}<span>{cap}</span></div>'
        for svgm, cap in (
            (icons.svg(i, dark, 96), "Dark"),
            (icons.svg(i, light, 96), "Light"),
            (icons.mono(i, "light", 96), "One colour"),
            (icons.mono(i, "dark", 96), "One colour, inverse"),
        ))
    wordmark_band = ""
    gap = 20
    if is_wm:
        gap = 16
        wordmark_band = ('<div style="display: flex; align-items: center; justify-content: center; height: 64px; '
                         'border-radius: 14px; background: #FFFFFF; box-shadow: 0 0 0 1px rgba(29,33,28,.10)">'
                         '<span class="wm" style="font-size: 44px; letter-spacing: -0.01em; color: #171C26">penmoss'
                         '<span style="color: #3F7A37">.</span></span></div>')
    body = f"""<div style="width: {BW}px; height: {BH}px; box-sizing: border-box; padding: 32px; display: flex; flex-direction: column; gap: {gap}px; background: #F6F5F0; color: #1d211c; font-family: system-ui, sans-serif">
<div class="hd">{html.escape(title_of(i))}</div>
<div class="top">
{big}
<div class="side">
<div class="lbl">Small sizes</div>
<div class="sizes">{sizes}</div>
<div class="lbl" style="margin-top: 14px">Lockup</div>
{lock}
</div>
</div>
<div class="tiles">{tiles}</div>
{wordmark_band}<p class="concept">{html.escape(concept)}</p>
<p class="pal">Palette: {html.escape(pal)}</p>
</div>"""
    with open(f"{OUT}/Option{i + 1:02d}.dc.html", "w") as fh:
        fh.write(page(title_of(i), BW, BH, opt_css, body, FONT_LINK + "\n" if is_wm else ""))

print("written", now)
