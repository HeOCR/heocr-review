# 2026-11-18: check lines and accuracy in the volunteer line review (privacy policy 2026-11-18-v3)

- **Decision:** the volunteer line review (task type `line_consensus`) mixes check lines (gold: a known answer) into
  each volunteer's lines. It compares their answers with the known ones and keeps an accuracy figure per pseudonym,
  which only admins can see. Below the threshold, a volunteer's decisions stop counting toward agreement between
  volunteers. They are kept, and the volunteer counts again once their accuracy is back above the threshold.
- **Approved by:** the maintainer, on 2026-11-18, relayed word for word by heocr-lead: "Approve, privacy only".
- **The item, word for word**, a new item after "Contributions are public" in `public/privacy.html`:
  - HE: "<b>שורות בדיקה</b>: חלק מהשורות הן שורות שהתשובה עליהן ידועה. אנו משווים אליהן את התשובות שלכם ומחשבים דיוק
    לפי הכינוי. הדיוק גלוי רק למנהלים ולא מתפרסם. אם הדיוק נמוך מהסף, ההחלטות שלכם לא נספרות בהסכמה בין מתנדבים (הן
    נשמרות, ואפשר לשוב ולהיספר)."
  - EN: "<b>Check lines</b>: some lines have a known answer. We compare your answers on them and keep an accuracy figure
    under your pseudonym. It is visible to admins only and never published. If it falls below the threshold, your
    decisions stop counting toward agreement between volunteers (they are kept, and you can count again)."
- **Privacy only:** the terms do not change. `TERMS_VERSION` stays `2026-11-12-v1`, and nobody is asked to accept
  again. `PRIVACY_VERSION` becomes `2026-11-18-v3`.
- **Also decided:**
  - Accuracy is recomputed as volunteers answer more check lines; there is no permanent cut.
  - Volunteers do not see their own accuracy in v1.
- **The numbers** are eval's pre-registered floor (heocr-restricted-eval
  `preregistration/midcentury_volunteers_2026-11-18`, §4): 95%, applied once a volunteer has 20 check lines. Before
  20, none of their decisions count yet.
- **Release:** this text goes to production only together with the volunteer line review, on the maintainer's word for
  the whole volunteer launch. It is not deployed on its own.
- **Covers:** `public/privacy.html` (the item, HE and EN, and the version), `PRIVACY_VERSION` in
  `src/shared/terms.ts`, and the version on `public/index.html` and in the README. The code is the volunteer line
  review (`src/tasks/line_consensus/`, `src/worker/consensus.ts`, migration `0005_line_consensus.sql`).

— contrib[claude/claude-code#shay-macbook-m4]@heocr/opensource
