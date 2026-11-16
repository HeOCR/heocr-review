# 2026-11-16: what a deletion on request does with a reviewer's decisions (privacy policy 2026-11-16-v2)

- **Decision:** when a reviewer asks to be deleted, we delete their record and credit name from the site. For their
  decisions that are not yet published, **they choose**: we delete them, or we keep them with no link to them (no
  pseudonym and no name), to be published later as an anonymous contribution. **With no choice, the default is to
  keep them unlinked.** A decision already used in a registered evaluation set is kept in any case, unlinked, so
  published results can be reproduced. Decisions already published in public releases stay there, under the
  pseudonym only. This is **option C**.
- **Approved by:** the maintainer, on 2026-11-16, relayed word for word by heocr-lead, who also relayed his approval of
  the text below.
- **The alternatives were:**
  - **A**, delete everything not yet published, with no choice;
  - **B**, keep everything not yet published, unlinked, with no choice.
- **The item, word for word** (the "Deletion" item of `public/privacy.html`; the mailto links are unchanged):
  - HE: "<b>מחיקה</b>: כתבו ל-heocrproject@gmail.com עם הכינוי שלכם (מופיע בהגדרות). נמחק את הרשומה שלכם ואת שם
    הקרדיט מהאתר. על ההחלטות שלכם שעוד לא פורסמו תחליטו אתם: למחוק אותן, או להשאיר אותן בלי שום קשר אליכם (בלי כינוי
    ובלי שם), כדי שיוכלו להתפרסם בהמשך כתרומה אנונימית. אם לא תבחרו, נשאיר אותן בלי קשר אליכם. החלטה ששימשה כבר בסט
    הערכה רשום נשארת בכל מקרה, בלי קשר אליכם, כדי שאפשר יהיה לשחזר תוצאות שפורסמו. החלטות שכבר פורסמו במהדורות
    ציבוריות נשארות שם, עם הכינוי בלבד."
  - EN: "<b>Deletion</b>: email heocrproject@gmail.com with your pseudonym (shown in Settings). We delete your record and
    credit name from the site. For your decisions that are not yet published, you choose: we delete them, or we keep
    them with no link to you (no pseudonym and no name), so they can be published later as an anonymous contribution.
    If you don't choose, we keep them with no link to you. A decision already used in a registered evaluation set stays
    in any case, with no link to you, so published results can be reproduced. Decisions already published in public
    releases stay there, under your pseudonym only."
- **Why:** the policy `2026-11-16-v1` said only that we delete the record and credit name, and was silent on the
  decisions in the database. Decisions cannot stay pointing at a deleted record (foreign key), so the policy had to
  say what happens to them.
- **Terms unchanged:** `TERMS_VERSION` stays `2026-11-12-v1`, so nobody is asked to accept again. The CC0 1.0
  dedication of each decision is recorded on the decision itself (`decisions.terms_version`) and survives unlinking.
- **Covers:** `public/privacy.html` (the item, HE and EN, and the version), `PRIVACY_VERSION` in
  `src/shared/terms.ts`, the version on `public/index.html` and in the README. Requests are handled by hand with
  [`docs/runbooks/reviewer-deletion.md`](../runbooks/reviewer-deletion.md); there is no deletion code path in the app.

— contrib[claude/claude-code#shay-macbook-m4]@heocr/opensource
