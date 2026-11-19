"""HeOCR Review, direction round: line verification on a phone (default, editing) and on a desktop.
All text is invented. The "scans" are HTML set in Frank Ruhl Libre (OFL), standing in for the Worker's images."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent

def ico(d, cls=""):
    return f'<svg class="ico {cls}" viewBox="0 0 24 24" aria-hidden="true">{d}</svg>'
I = dict(
    back='<path d="M20 12H5M11 6l-6 6 6 6"/>', undo='<path d="M4 9h11a5 5 0 0 1 0 10H8"/><path d="M8 5L4 9l4 4"/>',
    page='<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><rect x="8.5" y="11" width="7" height="3"/>',
    more='<rect x="4" y="10.5" width="3" height="3" class="f"/><rect x="10.5" y="10.5" width="3" height="3" class="f"/><rect x="17" y="10.5" width="3" height="3" class="f"/>',
    check='<path d="M4.5 12.5l5 5L19.5 7"/>', close='<path d="M6 6l12 12M18 6L6 18"/>', edit='<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    reset='<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19 4v5h-5"/>', pieces='<rect x="3" y="5" width="18" height="6"/><rect x="3" y="13" width="18" height="6"/>',
    fit='<rect x="3" y="8" width="18" height="8"/>', zoomin='<rect x="4" y="4" width="12" height="12"/><path d="M15 15l6 6M10 7v6M7 10h6"/>',
    zoomout='<rect x="4" y="4" width="12" height="12"/><path d="M15 15l6 6M7 10h6"/>', settings='<rect x="4" y="4" width="16" height="16"/><rect x="9" y="9" width="6" height="6"/>',
    book='<path d="M4 4h7v16H4zM13 4h7v16h-7z"/>',
)
MARK = ('<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="7" y="7" width="34" height="34" class="lg-box"/>'
        + "".join(f'<rect x="{x}" y="{y}" width="6" height="6" class="lg-h"/>' for x, y in ((4, 4), (38, 4), (4, 38), (38, 38)))
        + '<path d="M16 18H32V32.5M16 24.5V32.5" class="lg-ink"/></svg>')

# invented prose, in the manner of a mid-century printed novel
LINE = "ובבוקר יצאו הדייגים אל המזח הישן, ואיש מהם לא הביט לאחור אל בתי העיירה."
ABOVE = "הגשם פסק לפני עלות השחר, והרחובות עוד נצצו באור הפנסים האחרונים שלא כבו."
BELOW = "רק הנער שנשא את הסלים עצר לרגע ליד הבאר, כאילו שכח שם דבר־מה, והמשיך."
BODY = [ABOVE, LINE, BELOW,
        "הים היה שקט באותה שעה, אפור כעופרת, והסירות התנדנדו לאטן על החבלים.",
        "מן הגבעה נשמע פעמון רחוק, פעם ופעמיים, ואחר כך שבה הדממה אל החוף כולו.",
        "הזקן שישב על הארגז ההפוך תיקן רשת קרועה, ואצבעותיו זכרו את המלאכה היטב.",
        "אמרו עליו שפעם הפליג רחוק מכל האחרים, אבל הוא עצמו לא סיפר על כך דבר.",
        "כשעלתה השמש מעל שובר הגלים נדלקו החלונות בזה אחר זה, כמו נרות של חג."]
CAND_BAD = LINE.replace("הדייגים", "הדיגים")

S = {
    "he": dict(dir="rtl", batch="אל המזח · שורות", where="שורה 14 · עמ׳ 37", left="נשארו", today="היום", ask="האם הטקסט זהה בדיוק לשורה, אות באות וסימן בסימן?",
               exact="מדויק", fix="תיקון", niqqud="בדפוס יש ניקוד", unread="לא קריא", misal="לא תואם", skip="דילוג", prev="הקודם", page="העמוד המלא", more="עוד",
               saved="ההחלטה הקודמת נשמרה", pieces="2 חלקים", fit="לרוחב", edit_title="תיקון השורה", save="שמירת התיקון", cancel="ביטול", reset="חזרה לטקסט המוצע",
               nq="בדפוס יש ניקוד (מקלידים אותיות בלבד)", changed="שינית:", kb="מקלדת המערכת", pg="העמוד", src="אל המזח, עמ׳ 37", zoom="זום", conv="כללי ההקלדה", settings="הגדרות",
               enlarge="הגדלה", decided="הוחלטו היום"),
    "en": dict(dir="ltr", batch="אל המזח · lines", where="Line 14 · p. 37", left="left", today="today", ask="Is the text exactly the line, letter by letter and mark by mark?",
               exact="Exact", fix="Correct it", niqqud="Print has niqqud", unread="Unreadable", misal="Misaligned", skip="Skip", prev="Previous", page="Full page", more="More",
               saved="Previous decision saved", pieces="2 pieces", fit="Fit width", edit_title="Correct the line", save="Save correction", cancel="Cancel", reset="Back to the candidate",
               nq="Print has niqqud (type letters only)", changed="You changed:", kb="System keyboard", pg="Page", src="אל המזח, p. 37", zoom="Zoom", conv="Conventions", settings="Settings",
               enlarge="Enlarge", decided="Decided today"),
}


def strip(pieces, size):
    if pieces == 1:
        return f'<div class="linestrip" dir="ltr" role="img" aria-label="the line on the scan"><div class="seg"><div class="print" style="inset-inline:0;font-size:{size}px"><span>{LINE}</span></div></div></div>'
    segs = "".join(f'<div class="seg"><div class="print" style="width:calc(200% - 20px);right:{"0" if k == 0 else "calc(-100% + 20px)"};font-size:{size}px"><span>{LINE}</span></div></div>' for k in range(2))
    return f'<div class="linestrip" dir="ltr" role="img" aria-label="the line on the scan">{segs}</div>'


def ctx_band(size=11.5):
    row = lambda t, cur=False: f'<div style="position:relative;padding:3px 0"><div class="print" style="font-size:{size}px">{t}</div>{"<div class=hl style=inset:0_-5px></div>".replace("_", " ") if cur else ""}</div>'
    return f'<div style="padding:10px 16px 12px">{row(ABOVE)}{row(LINE, True)}{row(BELOW)}</div>'


def mock_page():
    lines = (BODY[3:] + BODY[6:] + [ABOVE, LINE, BELOW] + BODY[3:] + BODY[4:] + BODY[3:] + BODY[5:] + BODY[3:6])[:36]
    cur = 8
    rows = "".join(f'<div style="position:relative;padding:2.2px 0"><div class="print" style="font-size:9.6px{";padding-inline-start:14px" if i in (0, 13, 24) else ""}">{t}</div>{"<div class=hl style=inset:0_-5px></div>".replace("_", " ") if i == cur else ""}</div>' for i, t in enumerate(lines))
    head = '<div class="print" style="display:flex;justify-content:space-between;font-size:9.6px;margin-bottom:12px;text-align-last:auto"><span>37</span><span style="font-weight:700">אל המזח</span><span></span></div>'
    return f'<div class="mockpage">{head}{rows}</div>'


def head(lang, title, theme):
    t = S[lang]
    return f'''<!doctype html>
<html lang="{lang}" dir="{t["dir"]}" data-theme="{theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HeOCR Review · {title}</title>
<link rel="stylesheet" href="../../css/tokens.css">
<link rel="stylesheet" href="../../css/fonts.css">
<link rel="stylesheet" href="../../css/review.css">
</head>'''


def top_phone(t):
    return (f'<header class="top"><a class="home" href="#" aria-label="HeOCR Review">{MARK}</a><div class="where"><b><bdi>{t["batch"]}</bdi></b><span>{t["where"]}</span></div>'
            f'<div class="left"><strong class="num">212</strong>{t["left"]}</div></header><div class="progress" role="progressbar" aria-valuenow="38" aria-valuemin="0" aria-valuemax="100"><i style="width:38%"></i></div>')


def phone_default(lang, theme):
    t = S[lang]
    return head(lang, "line verification, phone", theme) + f'''
<body class="rv">
{top_phone(t)}
<main class="review lineverify">
<p class="ask">{t["ask"]}</p>
<div class="linebox">{strip(2, 23)}
<div class="cropbar"><button type="button" aria-pressed="true">{ico(I["pieces"], "sm")}{t["pieces"]}</button><button type="button" aria-pressed="false">{ico(I["fit"], "sm")}{t["fit"]}</button></div></div>
<div class="txt cand" lang="he">{LINE}</div>
<div class="slot"></div>
<div class="ctxbox" dir="rtl">{ctx_band()}<button type="button" class="open">{ico(I["page"], "sm")}{t["page"]}</button></div>
</main>
<footer class="dock">
<div class="aux"><button type="button" class="act quiet">{ico(I["undo"], "sm flip")}{t["prev"]}</button>
<span class="savestate" data-state="saved" role="status">{ico(I["check"], "sm")}{t["saved"]}</span>
<button type="button" class="act quiet">{ico(I["more"], "sm")}{t["more"]}</button></div>
<nav class="actions"><button type="button" class="act primary" data-value="exact">{t["exact"]}</button><button type="button" class="act" data-value="edited">{t["fix"]}</button></nav>
</footer>
</body></html>
'''


def phone_editing(lang, theme):
    t = S[lang]
    fixed = LINE
    return head(lang, "line verification, phone, editing", theme) + f'''
<body class="rv editing">
<header class="top"><button type="button" class="iconbtn" aria-label="{t["cancel"]}">{ico(I["close"])}</button><div class="where"><b>{t["edit_title"]}</b></div><div class="left">{t["where"]}</div></header>
<main class="review lineverify">
<div class="linebox">{strip(2, 23)}</div>
<div class="editbox">
<textarea rows="3" dir="rtl" lang="he" spellcheck="false" aria-label="{t["edit_title"]}">{fixed}</textarea>
<p class="changes" role="status">{t["changed"]} <bdi><del>הדיגים</del> ← <ins>הדייגים</ins></bdi></p>
<div class="edittools"><button type="button" class="act quiet">{ico(I["reset"], "sm")}{t["reset"]}</button><label class="check"><i></i>{t["nq"]}</label></div>
</div>
</main>
<div class="savebar"><button type="button" class="act primary">{t["save"]}</button><button type="button" class="act">{t["cancel"]}</button></div>
<div class="kb" aria-hidden="true">{t["kb"]}</div>
</body></html>
'''


def desktop(lang, theme):
    t = S[lang]
    k = lambda x: f'<kbd>{x}</kbd>'
    acts = "".join(f'<button type="button" class="act{c}" data-value="{v}"><span>{t[l]}</span>{k(key)}</button>' for v, l, key, c in
                   (("exact", "exact", "Enter", " primary"), ("edited", "fix", "E", ""), ("pointed_print", "niqqud", "N", ""), ("unreadable", "unread", "U", ""), ("misaligned", "misal", "M", ""), ("skip", "skip", "S", "")))
    return head(lang, "line verification, desktop", theme) + f'''
<body class="rv">
<header class="top"><a class="home" href="#" aria-label="HeOCR Review">{MARK}</a><span class="wordmark">He<b>OCR</b><i>Review</i></span>
<div class="where"><b><bdi>{t["batch"]}</bdi></b><span>{t["where"]}</span></div>
<div class="left" style="margin-inline-start:24px"><strong class="num">212</strong>{t["left"]}</div><div class="left"><strong class="num">64</strong>{t["decided"]}</div>
<nav class="links"><a href="#">{ico(I["book"], "sm")}{t["conv"]}</a><a href="#">{ico(I["settings"], "sm")}{t["settings"]}</a></nav></header>
<div class="progress" role="progressbar" aria-valuenow="38" aria-valuemin="0" aria-valuemax="100"><i style="width:38%"></i></div>
<div class="deck">
<main class="review lineverify">
<p class="ask">{t["ask"]}</p>
<div class="linebox">{strip(1, 27)}</div>
<div class="txt cand" lang="he">{LINE}</div>
<div class="slot"></div>
<nav class="actions six">{acts}</nav>
<div class="subnav"><button type="button" class="act quiet">{ico(I["undo"], "sm flip")}{t["prev"]} {k("B")}</button>
<button type="button" class="act quiet">{ico(I["zoomout"], "sm")}{k("−")}</button><button type="button" class="act quiet">{ico(I["zoomin"], "sm")}{k("+")}</button>
<span class="savestate" data-state="saved" role="status">{ico(I["check"], "sm")}{t["saved"]}</span></div>
</main>
<aside class="side"><h2><span>{t["pg"]}</span><button type="button" class="act quiet" style="min-height:32px">{t["enlarge"]} {k("P")}</button></h2>
<div class="ctxbox" dir="rtl">{mock_page()}</div><p class="src"><bdi>{t["src"]}</bdi></p></aside>
</div>
</body></html>
'''


if __name__ == "__main__":
    jobs = []
    for lang in ("he", "en"):
        d = OUT / "mockups" / lang
        d.mkdir(parents=True, exist_ok=True)
        for name, fn, w, h in (("line-phone-default", phone_default, 412, 915), ("line-phone-editing", phone_editing, 412, 915), ("line-desktop", desktop, 1440, 900)):
            (d / f"{name}.html").write_text(fn(lang, "light").replace(' data-theme="light"', ""), encoding="utf-8")
            jobs.append(dict(lang=lang, name=name, w=w, h=h))
    (HERE / "jobs.json").write_text(json.dumps(jobs))
    print(len(jobs))
