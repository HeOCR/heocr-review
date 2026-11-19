"""HeOCR Review mockups: one responsive static page per screen and language, built on css/review.css.
All text is invented. The "scans" are HTML set in Frank Ruhl Libre (OFL), standing in for the Worker's images.
Also writes the icons as standalone SVG files and the strings as JSON."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent

# ------------------------------------------------------------------ icons (24 px grid)
ICONS = {
    # name: (svg, mirrors in RTL, use)
    "exact": ('<path d="M4.5 12.5l5 5L19.5 7"/>', False, "Exact / correct / accept / saved"),
    "edit": ('<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>', False, "Correct it / edit"),
    "niqqud": ('<path d="M6 5h12v9M6 10v4"/><rect x="8" y="18" width="2.5" height="2.5" class="f"/><rect x="13.5" y="18" width="2.5" height="2.5" class="f"/>', False, "Print has niqqud"),
    "unreadable": ('<rect x="3.5" y="6.5" width="17" height="11"/><path d="M4 20L20 4"/>', False, "Unreadable"),
    "misaligned": ('<path d="M3 8h13M8 16h13"/><path d="M19 5v6M5 13v6"/>', False, "Misaligned: the candidate is another line"),
    "not-on-page": ('<path d="M6 3h8l4 4v14H6z"/><path d="M9 11l6 6M15 11l-6 6"/>', False, "Not on the page"),
    "skip": ('<path d="M5 5l8 7-8 7z"/><path d="M18 5v14"/>', True, "Skip"),
    "previous": ('<path d="M4 9h11a5 5 0 0 1 0 10H8"/><path d="M8 5L4 9l4 4"/>', True, "Previous line (undo the last decision)"),
    "page": ('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><rect x="8.5" y="11" width="7" height="3"/>', False, "Full page"),
    "more": ('<rect x="4" y="10.5" width="3" height="3" class="f"/><rect x="10.5" y="10.5" width="3" height="3" class="f"/><rect x="17" y="10.5" width="3" height="3" class="f"/>', False, "More answers"),
    "close": ('<path d="M6 6l12 12M18 6L6 18"/>', False, "Close / cancel / reject"),
    "reset": ('<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19 4v5h-5"/>', False, "Back to the candidate / try again"),
    "pieces": ('<rect x="3" y="5" width="18" height="6"/><rect x="3" y="13" width="18" height="6"/>', False, "Line in two pieces"),
    "fit": ('<rect x="3" y="8" width="18" height="8"/>', False, "Line fitted to the width"),
    "zoom-in": ('<rect x="4" y="4" width="12" height="12"/><path d="M15 15l6 6M10 7v6M7 10h6"/>', False, "Zoom in"),
    "zoom-out": ('<rect x="4" y="4" width="12" height="12"/><path d="M15 15l6 6M7 10h6"/>', False, "Zoom out"),
    "flag": ('<path d="M5 21V4h13l-3 4 3 4H5"/>', False, "Pre-check flag / look here"),
    "conventions": ('<path d="M4 4h7v16H4zM13 4h7v16h-7z"/>', False, "Typing conventions"),
    "settings": ('<rect x="4" y="4" width="16" height="16"/><rect x="9" y="9" width="6" height="6"/>', False, "Settings"),
    "tasks": ('<rect x="4" y="4" width="16" height="4"/><rect x="4" y="10" width="16" height="4"/><rect x="4" y="16" width="16" height="4"/>', False, "All tasks"),
    "desktop": ('<rect x="3" y="4" width="18" height="12"/><path d="M8 20h8M12 16v4"/>', False, "A desktop task"),
    "copy": ('<path d="M9 9h11v11H9z"/><path d="M15 9V4H4v11h5"/>', False, "Copy the link"),
    "offline": ('<path d="M3 9l9-5 9 5M6.5 12.5l5.5-3 5.5 3"/><rect x="10.5" y="15.5" width="3" height="3" class="f"/><path d="M4 20L20 4"/>', False, "No connection"),
    "clock": ('<rect x="3.5" y="3.5" width="17" height="17"/><path d="M12 7v5l3.5 2"/>', False, "Wait: rate limit or daily quota"),
    "warning": ('<path d="M12 3.5L21.5 20h-19z"/><path d="M12 10v4.5"/><path d="M12 17v.5"/>', False, "Something went wrong"),
    "sign-out": ('<path d="M10 4H4v16h6"/><path d="M9 12h11M16 8l4 4-4 4"/>', True, "Sign out"),
    "back": ('<path d="M20 12H5M11 6l-6 6 6 6"/>', True, "Back"),
    "split": ('<path d="M12 3v18"/><path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/>', False, "Split the line at the cursor"),
    "merge": ('<path d="M4 6h16M4 18h16"/><path d="M12 8v8M9 13l3 3 3-3"/>', False, "Merge with the next line"),
    "move-up": ('<path d="M12 20V5M6 11l6-6 6 6"/>', False, "Move the line up"),
    "move-down": ('<path d="M12 4v15M6 13l6 6 6-6"/>', False, "Move the line down"),
    "add-line": ('<path d="M4 6h16M4 12h9M17 12v8M13 16h8"/>', False, "Add a line below"),
}


def ico(name, cls=""):
    inner, flip, _ = ICONS[name]
    return f'<svg class="ico{" flip" if flip else ""}{" " + cls if cls else ""}" viewBox="0 0 24 24" aria-hidden="true">{inner}</svg>'


MARK = ('<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="7" y="7" width="34" height="34" class="lg-box"/>'
        + "".join(f'<rect x="{x}" y="{y}" width="6" height="6" class="lg-h"/>' for x, y in ((4, 4), (38, 4), (4, 38), (38, 38)))
        + '<path d="M16 18H32V32.5M16 24.5V32.5" class="lg-ink"/></svg>')

# ------------------------------------------------------------------ invented text
LINE = "ובבוקר יצאו הדייגים אל המזח הישן, ואיש מהם לא הביט לאחור אל בתי העיירה."
ABOVE = "הגשם פסק לפני עלות השחר, והרחובות עוד נצצו באור הפנסים האחרונים שלא כבו."
BELOW = "רק הנער שנשא את הסלים עצר לרגע ליד הבאר, כאילו שכח שם דבר־מה, והמשיך."
BODY = ["הים היה שקט באותה שעה, אפור כעופרת, והסירות התנדנדו לאטן על החבלים.",
        "מן הגבעה נשמע פעמון רחוק, פעם ופעמיים, ואחר כך שבה הדממה אל החוף כולו.",
        "הזקן שישב על הארגז ההפוך תיקן רשת קרועה, ואצבעותיו זכרו את המלאכה היטב.",
        "אמרו עליו שפעם הפליג רחוק מכל האחרים, אבל הוא עצמו לא סיפר על כך דבר.",
        "כשעלתה השמש מעל שובר הגלים נדלקו החלונות בזה אחר זה, כמו נרות של חג."]
CAND_BAD = LINE.replace("הדייגים", "הדיגים")
BOOK = "אל המזח"

T = dict(
    batch=("אל המזח · שורות", "אל המזח · lines"), where=("שורה 14 · עמ׳ 37", "Line 14 · p. 37"), left=("נשארו", "left"), decided=("היום", "today"),
    ask=("האם הטקסט זהה בדיוק לשורה, אות באות וסימן בסימן?", "Is the text exactly the line, letter by letter and mark by mark?"),
    exact=("מדויק", "Exact"), fix=("תיקון", "Correct it"), niqqud=("בדפוס יש ניקוד", "Print has niqqud"), unread=("לא קריא", "Unreadable"),
    misal=("לא תואם", "Misaligned"), skip=("דילוג", "Skip"), prev=("הקודם", "Previous"), page=("העמוד המלא", "Full page"), more=("עוד", "More"),
    niqqud_sub=("האותיות נכונות, והדפוס מנוקד", "The letters match and the print is pointed"), unread_sub=("אי אפשר לקרוא את השורה בסריקה", "The line can't be read on the scan"),
    misal_sub=("הטקסט המוצע הוא שורה אחרת", "The candidate is a different line"), skip_sub=("בלי להחליט; השורה תחזור אחר כך", "No decision; the line comes back later"),
    saved=("ההחלטה הקודמת נשמרה", "Previous decision saved"), saving=("שומר…", "Saving…"), failed=("לא נשמר", "Not saved"),
    pieces=("2 חלקים", "2 pieces"), fit=("לרוחב", "Fit width"), zoom_in=("הגדלה", "Zoom in"), zoom_out=("הקטנה", "Zoom out"),
    edit_title=("תיקון השורה", "Correct the line"), save=("שמירת התיקון", "Save correction"), cancel=("ביטול", "Cancel"), reset=("חזרה לטקסט המוצע", "Back to the candidate"),
    nq=("בדפוס יש ניקוד (מקלידים אותיות בלבד)", "Print has niqqud (type letters only)"), changed=("שינית:", "You changed:"), kb=("מקלדת המערכת", "System keyboard"),
    pg=("העמוד", "Page"), src=("אל המזח, עמ׳ 37", "אל המזח, p. 37"), conv=("כללי ההקלדה", "Conventions"), settings=("הגדרות", "Settings"), tasks=("משימות", "Tasks"),
    enlarge=("הגדלה", "Enlarge"), back_line=("חזרה לשורה", "Back to the line"), close=("סגירה", "Close"),
    flag=("<strong>בדיקה מוקדמת:</strong> ייתכן שהטקסט שגוי (אות חסרה או מיותרת). בדקו מול העמוד המלא לפני ״מדויק״.",
          "<strong>Pre-check:</strong> the text may be wrong (a missing or extra letter). Check it against the full page before “Exact”."),
    flag_phone=("פתחו את העמוד המלא כדי לסמן ״מדויק״.", "Open the full page to mark “Exact”."),
    mis_hint=("הטקסט המוצע אינו השורה הזאת. הקלידו את השורה כפי שהיא בסריקה, אותיות בלבד.", "The candidate is not this line. Type the line as the scan shows it, letters only."),
    mis_save=("שמירה: לא תואם", "Save as misaligned"), mis_title=("הקלדת השורה", "Type the line"),
    type_ask=("הקלידו את השורה כפי שהיא בסריקה, אות באות.", "Type the line as the scan shows it, letter by letter."), type_save=("שמירה", "Save"),
    type_ph=("הקלידו כאן את השורה", "Type the line here"), not_one=("יותר משורה אחת", "More than one line"), no_text=("אין טקסט", "No text"),
    fail_note=("<strong>ההחלטה לא נשמרה.</strong> אין חיבור כרגע. התשובה שלך שמורה במכשיר ולא תאבד.", "<strong>The decision wasn't saved.</strong> No connection right now. Your answer is kept on this device and won't be lost."),
    retry=("ניסיון נוסף", "Try again"), keep=("נשמר במכשיר", "Kept on this device"),
    c_batch=("שורות למתנדבים", "Volunteer lines"), c_where=("החלטת על 37 שורות", "You decided 37 lines"), correct=("נכון", "Correct"), not_on=("לא בעמוד", "Not on the page"),
    not_on_sub=("השורה המסומנת לא נמצאת בעמוד", "The marked line is not on the page"), look=("בדקו היטב", "Look closely"), digits=("ספרות או סוגריים", "Digits or brackets"), help=("הסבר", "Help"),
    a_batch=("תיקוני ייחוס", "Reference corrections"), a_where=("הצעה 9 · עמ׳ 37", "Proposal 9 · p. 37"), a_ask=("האם התיקון המוצע נכון לפי הסריקה?", "Is the proposed correction right, going by the scan?"),
    now=("כעת", "Now"), proposed=("מוצע", "Proposed"), accept=("אישור", "Accept"), reject=("דחייה", "Reject"), a_edit=("עריכה", "Edit"),
    a_note=("הערת הסוכן: בסריקה נראית יו״ד כפולה.", "Agent note: the scan appears to show a double yod."), spelling=("כתיב", "Spelling"),
    p_batch=("אל המזח · עמודים", "אל המזח · pages"), p_where=("עמוד 37", "Page 37"), p_ask=("תקנו כל שורה למה שמודפס בדיוק, לפי סדר הקריאה.", "Correct each line to exactly what is printed, in reading order."),
    p_pending=("נשארו 2 שורות מסומנות לבדיקה.", "2 flagged lines still to look at."), p_confirm=("אישור העמוד", "Confirm the page"), p_draft=("הטיוטה נשמרה", "Draft saved"),
    p_reject=("פסילת העמוד (ריק, לא קריא, שגוי)", "Reject the page (blank, unreadable, wrong)"), p_add=("הוספת שורה בסוף", "Add a line at the end"), p_reset=("חזרה לטקסט המוכן", "Back to the pre-fill"),
    p_check=("בדקו", "Look"), p_looked=("נבדק", "Looked"), p_skip=("דילוג על העמוד", "Skip the page"),
    t_niq=("ניקוד בדפוס", "Niqqud"), t_nop=("לא בעמוד", "Not on page"), t_unr=("לא קריא", "Unreadable"), t_split=("פיצול", "Split"), t_merge=("איחוד", "Merge"), t_add=("שורה", "Line"),
    pp_title=("תיקון עמוד שלם נעשה במחשב", "Whole-page correction is done on a computer"),
    pp_body=("בטלפון אפשר לראות את העמוד ואת הטקסט שלו, אבל לא לתקן: עשרות שורות עם פיצול, איחוד והזזה צריכות מסך רחב ומקלדת.",
             "On a phone you can view the page and its text, but not correct it: dozens of lines with split, merge and move need a wide screen and a keyboard."),
    pp_copy=("העתקת קישור לעמוד", "Copy a link to this page"), pp_lines=("מעבר למשימת השורות", "Go to a line task"), pp_view=("הטקסט המוכן (לצפייה בלבד)", "The pre-fill (view only)"),
    signin_h=("עוזרים לשפר זיהוי טקסט עברי", "Help improve Hebrew text recognition"),
    signin_p=("בודקים ומתקנים טקסט עברי מול סריקות של דפים מודפסים. כל החלטה משמשת לאימון ולמדידה של HeOCR, פרויקט קוד פתוח.",
              "Check and correct Hebrew text against scans of printed pages. Every decision is used to train and measure HeOCR, an open-source project."),
    signin_g=("הכפתור של Google מוצג כאן", "Google's button is rendered here"), signin_why=("הכניסה בחשבון Google משמשת לזיהוי בלבד. באתר מופיע כינוי, לא השם שלך.", "Google sign-in is used for identification only. The site shows a pseudonym, not your name."),
    privacy=("מדיניות הפרטיות", "Privacy policy"), terms=("תנאי השימוש", "Terms of service"),
    terms_h=("לפני שמתחילים", "Before you start"), terms_p=("כאן מופיע נוסח התנאים המלא, כפי שהוא באתר. הנוסח לא משתנה בעיצוב הזה.", "The full terms text appears here, as it is on the site. This design does not change the wording."),
    terms_b=["ההחלטות שלך מתפרסמות ברישיון CC0 1.0.", "באתר מופיע כינוי ולא שם, אלא אם בחרת בקרדיט בשם.", "אפשר להפסיק בכל רגע."],
    terms_b_en=["Your decisions are published under CC0 1.0.", "The site shows a pseudonym, not a name, unless you choose named credit.", "You can stop at any time."],
    credit=("אני רוצה קרדיט בשם (רשות)", "I'd like credit by name (optional)"), name=("שם לתצוגה", "Display name"), accept_terms=("קראתי ואני מסכים/ה", "I have read and I agree"), pseud=("הכינוי שלך", "Your pseudonym"),
    pick_h=("בחרו משימה", "Choose a task"), today_line=("היום החלטת על 64 שורות.", "Today you decided 64 lines."), lines_task=("בדיקת שורות", "Line verification"), pages_task=("תיקון עמודים", "Page review"),
    cons_task=("שורות למתנדבים", "Volunteer lines"), audit_task=("בדיקת תיקוני ייחוס", "Reference audit"), remain=("נשארו", "left"), on_desktop=("במחשב", "On a computer"),
    done_h=("אין עוד שורות בשבילך כרגע", "No lines left for you right now"), done_p=("תודה רבה. היום החלטת על 64 שורות.", "Thank you. Today you decided 64 lines."),
    done_skips=("חזרה ל־3 השורות שדילגת עליהן", "Go back to the 3 lines you skipped"), done_last=("חזרה להחלטה האחרונה", "Back to the last decision"), all_tasks=("כל המשימות", "All tasks"),
    empty_h=("אין כרגע משימות פתוחות", "No open tasks right now"), empty_p=("כשתיפתח משימה חדשה היא תופיע כאן.", "When a new task opens it will appear here."),
    e_rate_h=("רגע, לאט יותר", "A moment, please"), e_rate_p=("נשלחו יותר מדי פעולות בדקה. ההחלטה האחרונה לא נשמרה עדיין.", "Too many actions in a minute. Your last decision has not been saved yet."), e_rate_hint=("אפשר להמשיך בעוד כחצי דקה.", "You can continue in about half a minute."),
    e_off_h=("אין חיבור לאינטרנט", "No internet connection"), e_off_p=("התשובה האחרונה שלך שמורה במכשיר. היא תישלח כשהחיבור יחזור.", "Your last answer is kept on this device. It will be sent when the connection is back."), e_off_hint=("אין צורך להקליד אותה שוב.", "You don't need to type it again."),
    e_srv_h=("משהו השתבש אצלנו", "Something went wrong on our side"), e_srv_p=("השרת לא הצליח לשמור את ההחלטה. התשובה שלך שמורה במכשיר.", "The server couldn't save the decision. Your answer is kept on this device."), e_srv_hint=("אם זה חוזר, אפשר לכתוב לנו.", "If it keeps happening, you can write to us."),
    e_quota_h=("הגענו למכסה היומית", "Today's quota is used up"), e_quota_p=("האתר שומר מספר מוגבל של החלטות ביום, והיום הוא התמלא. ההחלטות שכבר נשמרו בטוחות.", "The site can save a limited number of decisions a day, and today's are used up. Decisions already saved are safe."),
    e_quota_hint=("המכסה מתחדשת בחצות (UTC). התשובה האחרונה שלך שמורה במכשיר ותישלח אז.", "The quota resets at midnight (UTC). Your last answer is kept on this device and will be sent then."), ok_btn=("הבנתי", "OK"),
    set_h=("הגדרות", "Settings"), set_theme=("מראה", "Appearance"), th_sys=("לפי המכשיר", "System"), th_light=("בהיר", "Light"), th_night=("כהה", "Night"),
    set_lang=("שפה", "Language"), set_side=("הצד של ״מדויק״ בטלפון", "Side of “Exact” on a phone"), side_r=("ימין", "Right"), side_l=("שמאל", "Left"),
    set_credit=("קרדיט בשם (רשות)", "Named credit (optional)"), set_credit_p=("כרגע הקרדיט הוא בכינוי בלבד.", "Right now your credit is the pseudonym only."), set_save=("שמירה", "Save"), signout=("התנתקות", "Sign out"),
    conv_h=("כללי ההקלדה", "Typing conventions"), conv_p=("מקלידים את מה שמודפס. סימנים שאין להם מקש כותבים כך:", "Type what is printed. Marks that have no key are written like this:"),
)
CONV = [(("מקף ומקף עליון", "Hyphen and maqaf"), "-"), (("קו מפריד בין מילים, עם רווחים", "Dash between words, with spaces"), "–"), (("גרש וגרשיים", "Geresh and gershayim"), "' \""),
        (("מירכאות מכל צורה", "Quotation marks of any shape"), "\" '"), (("שורת נקודות, בכל אורך", "A row of dots, any length"), "..."), (("מספרים ותאריכים", "Numbers and dates"), "18.11.1952"),
        (("ניקוד בשורה", "Niqqud on the line"), ("לא מקלידים", "Not typed")), (("מילים במרווח (ר ח ב ה)", "Spaced-out words (ר ח ב ה)"), "רחבה")]


class Ctx:
    def __init__(self, lang):
        self.lang, self.i = lang, 0 if lang == "he" else 1
        self.dir = "rtl" if lang == "he" else "ltr"

    def __call__(self, key):
        return T[key][self.i]


# ------------------------------------------------------------------ pieces
def strip(text=LINE):
    one = f'<div class="seg"><div class="print one"><span>{text}</span></div></div>'
    two = "".join(f'<div class="seg"><div class="print two p{k}"><span>{text}</span></div></div>' for k in range(2))
    return (f'<div class="linestrip wide" dir="ltr" role="img" aria-label="the line on the scan">{one}</div>'
            f'<div class="linestrip narrow" dir="ltr" role="img" aria-label="the line on the scan">{two}</div>')


def cropbar(t):
    return (f'<div class="cropbar"><button type="button" aria-pressed="true">{ico("pieces", "sm")}{t("pieces")}</button>'
            f'<button type="button" aria-pressed="false">{ico("fit", "sm")}{t("fit")}</button></div>')


def band(t, ask=False):
    row = lambda x, cur=False: f'<div class="mrow"><div class="print">{x}</div>{"<div class=hl></div>" if cur else ""}</div>'
    return (f'<div class="ctxbox band{" ask-open" if ask else ""}" dir="rtl"><div class="mockband">{row(ABOVE)}{row(LINE, True)}{row(BELOW)}</div>'
            f'<button type="button" class="open">{ico("page", "sm")}{t("page")}</button></div>')


def mock_page(cur=9, n=36):
    lines = (BODY + BODY[3:] + BODY[:1] + [ABOVE, LINE, BELOW] + BODY + BODY[1:] + BODY + BODY[2:] + BODY[:3])[:n]
    rows = "".join(f'<div class="mrow{" ind" if i in (0, 13, 24) else ""}"><div class="print">{x}</div>{"<div class=hl></div>" if i == cur else ""}</div>' for i, x in enumerate(lines))
    return f'<div class="mockpage" dir="rtl"><div class="print mhead"><span>37</span><span><b>{BOOK}</b></span><span></span></div>{rows}</div>', lines


def top(t, batch="batch", where="where", count="212", task=True):
    counts = (f'<div class="count"><strong class="num">{count}</strong>{t("left")}</div><div class="count today"><strong class="num">64</strong>{t("decided")}</div>') if count else ""
    where_html = f'<div class="where"><b><bdi>{t(batch)}</bdi></b><span>{t(where)}</span></div>' if task else '<div class="where"></div>'
    return (f'<header class="top"><a class="home" href="#" aria-label="HeOCR Review">{MARK}</a><a class="brand" href="#">He<b>OCR</b><i>Review</i></a>{where_html}{counts}'
            f'<nav id="nav"><a href="#tasks" aria-label="{t("tasks")}">{ico("tasks", "sm")}<span>{t("tasks")}</span></a><a href="#conventions" aria-label="{t("conv")}">{ico("conventions", "sm")}<span>{t("conv")}</span></a>'
            f'<a href="#settings" aria-label="{t("settings")}">{ico("settings", "sm")}<span>{t("settings")}</span></a></nav></header>')


def progress(pct=38):
    return f'<div class="progress" role="progressbar" aria-valuenow="{pct}" aria-valuemin="0" aria-valuemax="100"><div class="bar" style="width:{pct}%"></div></div>'


def k(x):
    return f'<kbd>{x}</kbd>'


def act(t, value, label, key="", cls="", attrs="", icon=None, sub=None):
    i = ico(icon) if icon else ""
    s = f'<span>{t(label)}{f"<span class=sub>{t(sub)}</span>" if sub else ""}</span>'
    return f'<button type="button" class="act{" " + cls if cls else ""}" data-value="{value}"{" " + attrs if attrs else ""}>{i}{s}{k(key) if key else ""}</button>'


def subnav(t, state="saved", prev=True, extra=""):
    st = {"saved": (ico("exact", "sm"), t("saved")), "saving": ("", t("saving")), "failed": (ico("warning", "sm"), t("failed")), "none": ("", "")}[state]
    p = f'<button type="button" class="act quiet">{ico("previous", "sm")}{t("prev")} {k("B")}</button>' if prev else ""
    return (f'<div class="subnav">{p}'
            f'<button type="button" class="act quiet zoom" aria-label="{t("zoom_out")}">{ico("zoom-out", "sm")}{k("−")}</button><button type="button" class="act quiet zoom" aria-label="{t("zoom_in")}">{ico("zoom-in", "sm")}{k("+")}</button>{extra}'
            f'<span class="savestate" data-state="{state}" role="status">{st[0]}{st[1]}</span>'
            f'<button type="button" class="act quiet more-btn" aria-haspopup="dialog">{ico("more", "sm")}{t("more")}</button></div>')


def line_dock(t, state="saved", more_open=False, exact_attrs="", busy=None):
    dis = ' disabled' if busy else ""
    ex = act(t, "exact", "saving" if busy == "exact" else "exact", "Enter", "primary", ("data-busy" if busy == "exact" else exact_attrs))
    group = (act(t, "pointed_print", "niqqud", "N", "", dis, "niqqud", "niqqud_sub") + act(t, "unreadable", "unread", "U", "", dis, "unreadable", "unread_sub")
             + act(t, "misaligned", "misal", "M", "", dis, "misaligned", "misal_sub") + act(t, "skip", "skip", "S", "", dis, "skip", "skip_sub"))
    return (f'<footer class="dock"><nav class="actions">{ex}{act(t, "edited", "fix", "E", "", dis)}'
            f'<div class="moregroup{" open" if more_open else ""}" role="group" aria-label="{t("more")}">{group}</div></nav>{subnav(t, state)}</footer>'
            f'<div class="scrim{" open" if more_open else ""}"></div>')


def side(t, open_=False, enlarged=False):
    pg, _ = mock_page()
    return (f'<aside class="side{" open" if open_ else ""}{" enlarged" if enlarged else ""}" aria-label="{t("pg")}"><h2><span>{t("pg")} · <bdi>{t("src")}</bdi></span>'
            f'<button type="button" class="act quiet desktop-only">{t("close") if enlarged else t("enlarge")} {k("P")}</button></h2>'
            f'<div class="scroller">{pg}</div>'
            f'<div class="backbar"><button type="button" class="act primary">{ico("back")}{t("back_line")}</button>'
            f'<button type="button" class="act" aria-label="{t("zoom_out")}">{ico("zoom-out")}</button><button type="button" class="act" aria-label="{t("zoom_in")}">{ico("zoom-in")}</button></div></aside>')


def editbox(t, value, changes=True, hint=None, save="save", placeholder="", niq=True, cancel=True):
    ch = f'<p class="changes" role="status">{t("changed")} <bdi><del>הדיגים</del> ← <ins>הדייגים</ins></bdi></p>' if changes else ""
    h = f'<p class="small muted">{t(hint)}</p>' if hint else ""
    tools = (f'<button type="button" class="act quiet">{ico("reset", "sm")}{t("reset")}</button>' if changes else "") + (f'<label class="check"><i></i>{t("nq")}</label>' if niq else "")
    return (f'<div class="editbox">{h}<textarea rows="3" dir="rtl" lang="he" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="{placeholder}" aria-label="{t("edit_title")}">{value}</textarea>'
            f'{ch}<div class="edittools">{tools}</div>'
            f'<div class="savebar"><button type="button" class="act primary">{t(save)} {k("Ctrl+Enter")}</button>{f"""<button type="button" class="act">{t("cancel")} {k("Esc")}</button>""" if cancel else ""}</div></div>')


def edit_top(t, title):
    return (f'<header class="top phone-only" style="display:flex"><button type="button" class="iconbtn" aria-label="{t("cancel")}">{ico("close")}</button>'
            f'<div class="where"><b>{t(title)}</b></div><div class="count">{t("where")}</div></header>')


# ------------------------------------------------------------------ line verification screens
def line(t, cand=LINE, slot="", dock=None, body_cls="", ask="ask", band_ask=False, side_open=False, enlarged=False, extra="", edit=None, top_edit=None):
    dock = dock if dock is not None else line_dock(t)
    cand_html = f'<div class="txt cand" lang="he">{cand}</div>' if cand is not None else ""
    tp = (f'<div class="desktop-only">{top(t)}</div>{edit_top(t, top_edit)}') if top_edit else top(t)
    return (f'<body class="rv task{" " + body_cls if body_cls else ""}">{tp}{progress()}<div class="deck"><main class="review lineverify">'
            f'<p class="ask">{t(ask)}</p><div class="linebox">{strip()}{cropbar(t)}</div>{cand_html}<div class="slot">{slot}</div>{edit or ""}{band(t, band_ask)}{dock}</main>'
            f'{side(t, side_open, enlarged)}</div>{extra}{"<div class=kb aria-hidden=true>" + t("kb") + "</div>" if edit else ""}</body>')


def s_line_default(t): return line(t)
def s_line_flagged(t):
    cand = LINE.replace("הדייגים", '<mark class="attn">הדיגים</mark>')
    slot = f'<p class="precheck">{ico("flag", "sm")}<span>{t("flag")}<span class="block phone-only muted">{t("flag_phone")}</span></span></p>'
    return line(t, cand, slot, line_dock(t, exact_attrs='class-needs-page'), band_ask=True).replace('data-value="exact" class-needs-page', 'data-value="exact" data-needs-page')
def s_line_editing(t): return line(t, CAND_BAD, edit=editbox(t, LINE), body_cls="editing", top_edit="edit_title")
def s_line_more(t): return line(t, dock=line_dock(t, more_open=True))
def s_line_misaligned(t): return line(t, BODY[3], edit=editbox(t, "ובבוקר יצאו הדייגים אל ", changes=False, hint="mis_hint", save="mis_save", niq=False), body_cls="editing", top_edit="mis_title")
def s_line_typing(t):
    group = act(t, "unreadable", "unread", "U", "", "", "unreadable", "unread_sub") + act(t, "not_one_line", "not_one", "J") + act(t, "no_text", "no_text", "T") + act(t, "skip", "skip", "S", "", "", "skip", "skip_sub")
    dock = f'<footer class="dock"><nav class="actions"><div class="moregroup" role="group">{group}</div></nav>{subnav(t, "saved")}</footer><div class="scrim"></div>'
    return line(t, None, dock=dock, ask="type_ask", edit=editbox(t, "", changes=False, save="type_save", placeholder=t("type_ph"), cancel=False), body_cls="editing typing", top_edit="mis_title")
def s_line_page(t): return line(t, side_open=True, enlarged=True)
def s_line_saving(t): return line(t, dock=line_dock(t, state="saving", busy="exact"))
def s_line_saved(t): return line(t, BELOW, dock=line_dock(t, state="saved")).replace(LINE, "\u0000").replace(BELOW, LINE).replace("\u0000", BELOW) if False else line(t)
def s_line_failed(t):
    slot = (f'<div class="notice failed" role="alert">{ico("offline", "sm")}<div>{t("fail_note")}<div class="row"><button type="button" class="act">{ico("reset", "sm")}{t("retry")}</button>'
            f'<span class="tag">{t("keep")}</span></div></div></div>')
    return line(t, slot=slot, dock=line_dock(t, state="failed"))


# ------------------------------------------------------------------ consensus, audit
def s_consensus(t):
    group = (act(t, "print_has_niqqud", "niqqud", "N", "", "", "niqqud", "niqqud_sub") + act(t, "unreadable", "unread", "", "", "", "unreadable", "unread_sub")
             + act(t, "not_on_page", "not_on", "", "", "", "not-on-page", "not_on_sub") + act(t, "skip", "skip", "S", "", "", "skip", "skip_sub"))
    dock = (f'<footer class="dock"><nav class="actions">{act(t, "correct", "correct", "Enter", "primary")}{act(t, "edit", "fix", "E")}<div class="moregroup" role="group">{group}</div></nav>'
            f'{subnav(t, "saved", prev=False, extra=f"""<button type="button" class="act quiet">{t("help")}</button>""")}</footer><div class="scrim"></div>')
    slot = f'<div class="chips"><span class="tag look">{ico("flag", "sm")}{t("look")}</span></div>'
    body = line(t, LINE, slot, dock)
    return body.replace(top(t), top(t, "c_batch", "c_where", count="")).replace(progress(), '<div class="progress"></div>')


def s_audit(t):
    pg, _ = mock_page()
    dock = (f'<footer class="dock"><nav class="actions even">{act(t, "accepted", "accept", "A")}{act(t, "rejected", "reject", "R")}'
            f'<div class="moregroup" role="group">{act(t, "edited", "a_edit", "E", "", "", "edit")}{act(t, "skip", "skip", "S", "", "", "skip", "skip_sub")}</div></nav>{subnav(t)}</footer><div class="scrim"></div>')
    texts = (f'<div class="texts"><div class="row"><span class="lab">{t("now")}</span><div class="txt" lang="he">ובבוקר יצאו <mark class="del">הדיגים</mark> אל המזח הישן, ואיש מהם לא הביט לאחור.</div></div>'
             f'<div class="row"><span class="lab">{t("proposed")}</span><div class="txt" lang="he">ובבוקר יצאו <mark class="ins">הדייגים</mark> אל המזח הישן, ואיש מהם לא הביט לאחור.</div></div></div>')
    return (f'<body class="rv task">{top(t, "a_batch", "a_where", "48")}{progress(71)}<div class="deck"><main class="review audit">'
            f'<p class="ask">{t("a_ask")}</p><div class="linebox">{strip()}{cropbar(t)}</div><div class="row"><span class="tag">{t("spelling")}</span></div>{texts}'
            f'<p class="note">{t("a_note")}</p><div class="slot"></div>{band(t)}{dock}</main>{side(t)}</div></body>')


# ------------------------------------------------------------------ page review
def s_page(t):
    pg, lines = mock_page(cur=4, n=30)
    def row(i, text):
        flag = i in (4, 11)
        looked = i == 1
        cur = i == 4
        head = (f'<span class="flag">{ico("flag", "sm")}{t("p_check")}</span>' if flag else "") + (f'<span class="flag">{t("p_looked")}</span>' if looked else "") + (f'<span class="state">{t("t_niq")}</span>' if i == 7 else "")
        tools = "".join(f'<button type="button" class="act quiet" title="{key}">{ico(ic, "sm")}{t(l)} {k(key)}</button>' for ic, l, key in
                        (("niqqud", "t_niq", "Alt+N"), ("not-on-page", "t_nop", "Alt+X"), ("unreadable", "t_unr", "Alt+U"), ("split", "t_split", "Alt+Enter"), ("merge", "t_merge", "Alt+J"), ("add-line", "t_add", "Alt+A")))
        tools += f'<button type="button" class="act quiet" aria-label="up">{ico("move-up", "sm")}</button><button type="button" class="act quiet" aria-label="down">{ico("move-down", "sm")}</button>'
        v = text.replace("רחוק", "רחק") if cur else text
        return (f'<li class="prline{" current" if cur else ""}{" looked" if looked else ""}"><span class="num" dir="ltr">{i + 1}</span><div class="lbody"><div class="lhead">{head}</div>'
                f'<input class="lt" type="text" dir="rtl" lang="he" value="{v}" aria-label="{i + 1}"><div class="tools">{tools}</div></div></li>')
    rows = "".join(row(i, x) for i, x in enumerate(lines[:14]))
    view_rows = "".join(f'<p class="txt" lang="he" style="font-size:17px;padding:4px 0;border-bottom:1px solid var(--line)">{x}</p>' for x in lines[:7])
    phone = (f'<div class="phone-only state" style="padding-top:8px"><div class="mark">{ico("desktop")}</div><h2>{t("pp_title")}</h2><p>{t("pp_body")}</p>'
             f'<div class="stack"><button type="button" class="act primary">{ico("copy")}{t("pp_copy")}</button><a class="btn" href="#">{t("pp_lines")}</a></div>'
             f'<details><summary>{t("pp_view")}</summary><div class="ctxbox" style="margin-bottom:10px">{mock_page(cur=-1, n=16)[0]}</div>{view_rows}</details></div>')
    return (f'<body class="rv task">{top(t, "p_batch", "p_where", "23")}{progress(54)}<div class="deck" style="display:flex"><main class="review pagereview">{phone}'
            f'<div class="prgrid"><section class="scan"><div class="scroller">{pg}</div></section><section class="lines">'
            f'<p class="ask">{t("p_ask")}</p><p class="pending" role="status">{ico("flag", "sm")} {t("p_pending")}</p><ol class="prlines">{rows}</ol>'
            f'<div class="row"><button type="button" class="act quiet">{ico("add-line", "sm")}{t("p_add")}</button><button type="button" class="act quiet">{ico("reset", "sm")}{t("p_reset")}</button>'
            f'<button type="button" class="act quiet">{ico("skip", "sm")}{t("p_skip")}</button></div>'
            f'<div class="decide"><button type="button" class="act primary confirmbtn" disabled>{t("p_confirm")} {k("Ctrl+Enter")}</button>'
            f'<span class="savestate" data-state="saved" role="status">{ico("exact", "sm")}{t("p_draft")}</span></div>'
            f'<details class="reject"><summary>{t("p_reject")}</summary></details></section></div></main></div></body>')


# ------------------------------------------------------------------ general pages
def doc(t, inner, nav=True):
    tp = top(t, task=False, count="") if nav else f'<header class="top"><a class="home" href="#" aria-label="HeOCR Review">{MARK}</a><a class="brand" href="#" style="display:inline-flex">He<b>OCR</b><i>Review</i></a></header>'
    return f'<body class="rv">{tp}<main class="doc">{inner}</main></body>'


def s_signin(t):
    return doc(t, f'<h1>{t("signin_h")}</h1><p>{t("signin_p")}</p><div class="gsi"><div class="gsi-placeholder">{t("signin_g")}</div></div><p class="small muted">{t("signin_why")}</p>'
                  f'<p class="small"><a href="#">{t("privacy")}</a> · <a href="#">{t("terms")}</a></p>', nav=False)


def s_terms(t):
    bullets = "".join(f"<li>{b}</li>" for b in (T["terms_b"] if t.lang == "he" else T["terms_b_en"]))
    return doc(t, f'<h1>{t("terms_h")}</h1><div class="card terms"><p>{t("terms_p")}</p><ul style="padding-inline-start:20px;display:grid;gap:6px">{bullets}</ul></div>'
                  f'<p class="small muted">{t("pseud")}: <bdi dir="ltr" class="mono">r-7f3k2</bdi></p><label class="check"><i></i>{t("credit")}</label>'
                  f'<div class="field"><label>{t("name")}</label><input type="text" disabled></div><button type="button" class="act primary">{t("accept_terms")}</button>'
                  f'<p class="small"><a href="#">{t("terms")}</a> · <a href="#">{t("privacy")}</a></p>', nav=False)


def s_tasks(t):
    def pick(title, sub, n, pct, desk=False):
        tag = f'<span class="tag">{ico("desktop", "sm")}{t("on_desktop")}</span>' if desk else ""
        return (f'<a class="card pick" href="#"><strong>{t(title)}</strong><span class="count"><strong class="num">{n}</strong> {t("remain")}</span>'
                f'<span class="meta"><bdi>{sub}</bdi>{tag}</span><span class="bar"><i style="width:{pct}%"></i></span></a>')
    return doc(t, f'<h1>{t("pick_h")}</h1><p class="muted">{t("today_line")}</p><div class="picker">{pick("lines_task", BOOK, 212, 38)}{pick("cons_task", "עלוני קהילה", 540, 12)}'
                  f'{pick("audit_task", BOOK, 48, 71)}{pick("pages_task", BOOK, 23, 54, True)}</div>')


def state(t, icon, h, p, hint=None, buttons=""):
    return f'<div class="state"><div class="mark">{ico(icon)}</div><h1>{t(h)}</h1><p>{t(p)}</p>{f"""<p class="hint">{t(hint)}</p>""" if hint else ""}<div class="stack">{buttons}</div></div>'


def btn(t, label, cls="", icon=None):
    return f'<button type="button" class="act{" " + cls if cls else ""}">{ico(icon) if icon else ""}{t(label)}</button>'


def s_done(t): return doc(t, state(t, "exact", "done_h", "done_p", None, btn(t, "all_tasks", "primary") + btn(t, "done_skips") + btn(t, "done_last", "", "previous")))
def s_empty(t): return doc(t, state(t, "tasks", "empty_h", "empty_p"))
def s_err_rate(t): return doc(t, state(t, "clock", "e_rate_h", "e_rate_p", "e_rate_hint", btn(t, "retry", "primary", "reset")))
def s_err_offline(t): return doc(t, state(t, "offline", "e_off_h", "e_off_p", "e_off_hint", btn(t, "retry", "primary", "reset")))
def s_err_server(t): return doc(t, state(t, "warning", "e_srv_h", "e_srv_p", "e_srv_hint", btn(t, "retry", "primary", "reset") + btn(t, "all_tasks")))
def s_err_quota(t): return doc(t, state(t, "clock", "e_quota_h", "e_quota_p", "e_quota_hint", btn(t, "all_tasks", "primary")))


def s_settings(t):
    seg = lambda items, on: '<div class="seg-control" role="group">' + "".join(f'<button type="button" aria-pressed="{"true" if i == on else "false"}">{x}</button>' for i, x in enumerate(items)) + "</div>"
    return doc(t, f'<h1>{t("set_h")}</h1><p class="small muted">{t("pseud")}: <bdi dir="ltr" class="mono">r-7f3k2</bdi></p>'
                  f'<div class="field"><span class="lab">{t("set_theme")}</span>{seg([t("th_sys"), t("th_light"), t("th_night")], 0)}</div>'
                  f'<div class="field"><span class="lab">{t("set_lang")}</span>{seg(["עברית", "English"], t.i)}</div>'
                  f'<div class="field"><span class="lab">{t("set_side")}</span>{seg([t("side_r"), t("side_l")], 0)}</div>'
                  f'<div class="card"><h3>{t("set_credit")}</h3><p class="small muted">{t("set_credit_p")}</p><div class="field"><label>{t("name")}</label><input type="text"></div>'
                  f'<label class="check"><i></i>{t("credit")}</label><div class="row"><button type="button" class="act primary">{t("set_save")}</button></div></div>'
                  f'<div class="row"><button type="button" class="act">{ico("sign-out")}{t("signout")}</button></div>')


def s_conventions(t):
    rows = "".join(f'<dt>{w[t.i]}</dt><dd dir="auto">{v[t.i] if isinstance(v, tuple) else v}</dd>' for w, v in CONV)
    return doc(t, f'<h1>{t("conv_h")}</h1><p>{t("conv_p")}</p><dl class="conv">{rows}</dl>')


SCREENS = [
    ("line-01-default", "Line verification: default", s_line_default), ("line-02-flagged", "Line verification: pre-check flag", s_line_flagged),
    ("line-03-editing", "Line verification: editing, keyboard up", s_line_editing), ("line-04-more", "Line verification: the More sheet", s_line_more),
    ("line-05-misaligned", "Line verification: misaligned, typed from blank", s_line_misaligned), ("line-06-typing", "Line verification: a typed line or blind second pass", s_line_typing),
    ("line-07-full-page", "Line verification: full page open", s_line_page), ("line-08-saving", "Line verification: saving", s_line_saving),
    ("line-09-failed", "Line verification: save failed", s_line_failed), ("consensus", "Consensus (volunteer lines)", s_consensus), ("audit", "Reference audit", s_audit),
    ("page-review", "Page review (desktop task; phone shows the hand-off)", s_page), ("signin", "Sign-in", s_signin), ("terms", "Terms acceptance", s_terms), ("tasks", "Batch list", s_tasks),
    ("done", "Done", s_done), ("empty", "No open tasks", s_empty), ("error-rate-limited", "Error: rate limited", s_err_rate), ("error-offline", "Error: offline", s_err_offline),
    ("error-server", "Error: server error", s_err_server), ("error-quota", "Error: daily quota reached", s_err_quota), ("settings", "Settings", s_settings), ("conventions", "Conventions", s_conventions),
]


def page(lang, name, title, body):
    d = "rtl" if lang == "he" else "ltr"
    return f'''<!doctype html>
<html lang="{lang}" dir="{d}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>HeOCR Review · {title} · {lang}</title>
<link rel="stylesheet" href="../../css/tokens.css">
<link rel="stylesheet" href="../../css/fonts.css">
<link rel="stylesheet" href="../../css/review.css">
<link rel="stylesheet" href="../mock.css">
</head>
{body}
</html>
'''


if __name__ == "__main__":
    d = OUT / "icons"
    d.mkdir(parents=True, exist_ok=True)
    for name, (inner, _, _) in ICONS.items():
        inner = inner.replace(' class="f"', ' fill="currentColor" stroke="none"')
        (d / f"{name}.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
                                       f'stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">{inner}</svg>\n', encoding="utf-8")
    (d / "icons.json").write_text(json.dumps({n: {"mirrors_in_rtl": f, "use": u} for n, (_, f, u) in ICONS.items()}, indent=2), encoding="utf-8")
    jobs = []
    for lang in ("he", "en"):
        t = Ctx(lang)
        dd = OUT / "mockups" / lang
        dd.mkdir(parents=True, exist_ok=True)
        for name, title, fn in SCREENS:
            (dd / f"{name}.html").write_text(page(lang, name, title, fn(t)), encoding="utf-8")
            jobs.append(dict(lang=lang, name=name))
    (HERE / "jobs.json").write_text(json.dumps(jobs))
    strings = {"_note": "Strings used in the mockups, as [Hebrew, English]. The answers keep the app's current Hebrew labels; everything else is new wording and needs the maintainer's review."}
    strings.update({key: list(v) for key, v in T.items() if isinstance(v, tuple)})
    (OUT / "strings.json").write_text(json.dumps(strings, ensure_ascii=False, indent=1), encoding="utf-8")
    rows = "".join(f'<tr><td>{title}</td><td><a href="he/{n}.html">עברית</a></td><td><a href="en/{n}.html">English</a></td></tr>' for n, title, _ in SCREENS)
    (OUT / "mockups/index.html").write_text(f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>HeOCR Review mockups</title>
<link rel="stylesheet" href="../css/tokens.css"><link rel="stylesheet" href="../css/fonts.css">
<style>body{{margin:0;padding:24px;background:var(--bg);color:var(--text);font:400 15px/1.5 var(--font-body);max-width:720px}}h1{{font:700 22px/1.2 var(--font-mono)}}table{{border-collapse:collapse;width:100%}}td{{padding:10px 8px;border-bottom:1px solid var(--line)}}a{{color:var(--accent)}}p{{color:var(--muted)}}</style></head>
<body><h1>HeOCR Review mockups</h1><p>Each page is responsive: narrow the window under 900 px for the phone layout. The pages follow the system light or dark setting. No script; states are fixed in the markup.</p><table>{rows}</table></body></html>''', encoding="utf-8")
    print(len(jobs), "pages", len(ICONS), "icons")
