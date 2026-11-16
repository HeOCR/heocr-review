# 2026-11-16: unsaved page corrections kept on the server (privacy policy 2026-11-16-v1)

- **Decision:** the app keeps a reviewer's unsaved corrections on a page (page_review) on the server, as a draft, so a
  reload, a crash or another device does not lose them. The privacy policy's "What we store" gains one item, and its
  version becomes `2026-11-16-v1`. The terms do not change (`TERMS_VERSION` stays `2026-11-12-v1`), so nobody is
  asked to accept them again.
- **Approved by:** the maintainer, on 2026-11-16, relayed word for word by heocr-lead. He was asked "Approve the new
  line in the privacy policy as it stands?", shown the Hebrew item below, and answered: "מאשר" ("approved").
- **The item, word for word:**
  - HE: "תיקונים שעוד לא אישרתם או פסלתם בעמוד שאתם בודקים (טקסט השורות וסימוניהן), כדי שלא יאבדו בטעינה מחדש או
    במכשיר אחר. הם נמחקים כשאתם מאשרים או פוסלים את העמוד, ואינם מתפרסמים."
  - EN: "corrections you have not yet confirmed or rejected on a page you are reviewing (the lines' text and marks), so
    they survive a reload or another device. They are deleted when you confirm or reject the page, and are never
    published."
- **Why:** the maintainer asked for his edits to be saved per line ("אני צריך שהעריכות ישמרו לי פר שורה"). The privacy
  policy `2026-11-12-v1` listed what is stored, and an unsaved draft was not on that list (its decisions item covers
  decisions only). Browser storage stays out.
- **Terms unchanged:** "Your decisions and any text you edit are dedicated to the public domain under CC0 1.0" already
  covers the licence of edited text; drafts are never published.
- **Covers:** `public/privacy.html` (the item, HE and EN, and the version) and `PRIVACY_VERSION` in
  `src/shared/terms.ts`; the code is migration `0004_drafts.sql` (a draft is deleted when the page is confirmed or
  rejected, and with the reviewer's record), `PUT`/`DELETE /api/proposals/<id>/draft` and the page review screen.
- **Not decided here:** what a deletion on request does with a reviewer's unpublished decisions (heocr-lead raises it
  with the maintainer separately).

— contrib[claude/claude-code#shay-macbook-m4]@heocr/opensource
