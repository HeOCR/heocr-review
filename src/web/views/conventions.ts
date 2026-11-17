/**
 * eval's registered Hebrew conventions sheet (REVIEW_BATCH_SPEC.md), shown on the page review and the volunteer
 * line review (the margin-note row is about regrouping lines, which only the page review can do).
 */
export const CONVENTIONS: [string, string][] = [
  ["מקף ומקף עליון (גם מקף בסוף שורה, כמו שהוא מודפס)", "-"],
  ["קו מפריד בין מילים, עם רווחים", "– (כפתור, או Alt+-)"],
  ["גרש וגרשיים", "' ו־\" מהמקלדת"],
  ["מירכאות מכל צורה („ \" “ ” וגם בודדות)", "\" ו־'"],
  ["שורת נקודות בטבלה או בתוכן עניינים, בכל אורך", "... (שלוש נקודות בדיוק)"],
  ["מספרים ותאריכים", "כמו שמודפס, למשל 18.11.1952"],
  ["סוגריים", "כמו שמקלידים רגיל, (א); לא להעתיק סוגריים הפוכים"],
  ["ניקוד בשורה", "לא מקלידים ניקוד; מסמנים \"ניקוד בדפוס\""],
  ["מילים במרווח (ר ח ב ה)", "בלי המרווחים: רחבה"],
  [
    "הערת שוליים",
    "כשורות נפרדות (שורה לכל שורה מודפסת), מיד לפני השורה שלידה היא עומדת, ולהסיר אותה מהשורה הראשית. חסרה? + שורה (Alt+A, נוספת מתחת) והזזה בכפתורי ↑/↓ (Alt+↑/↓)",
  ],
];

/** The rows that apply to one line at a time (the volunteer line review has no merge, split or added lines). */
export const LINE_CONVENTIONS: [string, string][] = CONVENTIONS.filter(([what]) => what !== "הערת שוליים");
