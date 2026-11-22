# Private contributor app v1

`/app/#contributor` uses the existing Google sign-in. The private roster pairs
each writer's pseudonymous reviewer ID with a separate, organiser-verified
guardian account. A Google login establishes account ownership. The organiser
confirms the guardian relationship before adding the pair. Enter an age band
only. Invited account holders without assignments can copy their account
code from the contributor link and share it privately with the organiser.
Keep enrolment and account matching outside public channels.

Capture, handwriting and other intake switches are independent. For local
testing use invented inputs and a disposable Wrangler state. Production config
stays off until the lead approves activation, eval pins the writer assignments
and Shay approves the exact bilingual wording and licence.

## Private manifest

Store the UTF-8 manifest in the TRAIN bucket at
`contributor-v1/config/<sha256>.json`. Set `CONTRIBUTOR_CONFIG_SHA256` to the
exact byte digest and `CONTRIBUTOR_APP_ENABLED` to `1` only in an authorised
environment. The manifest uses:

- `schema: "heocr.contributor.v1"` and
  `approval: {evalSplitSha256, leadGo}`, with the private eval split SHA and
  lead approval record ID.
- `policy: {version, licence, guardian, assent}`. Each language key `he` and
  `en` under both roles has `{text, sha256}`. Each SHA covers the exact UTF-8
  text shown before agreement. A licence or version change requires renewed
  agreement. Draft wording below stays outside the runtime manifest.
- `writers: [{id, writerAccount, guardianAccount, ageBand, split, tasks}]`.
  Generate a random `cw-` ID with 16 random bytes in hex. Use existing
  `rv_` pseudonyms, `under_13`, `13_15`, or `16_17` and an eval-assigned
  `train`, `dev`, or `eval_open`. Preserve writer ID and split across
  revisions. Preflight the proposed 30 EVAL and six DEV writers with eval
  before allocation, preserving writer and prompt disjointness.
- All tasks have an opaque `id` and printable `page`. Keep IDs stable across
  revisions to preserve the slot receipt. List tasks in the desired order.
  Only the first unfinished task in each kind accepts a new submission.
- `print`: `{kind:"print", mode, sheetSha256}`. Assign TRAIN PDF pages and
  use `flat`, `angle`, `shadow`, `crumpled`, `scribbled`, or `folded`
  per capture slot.
- `form`: `{kind:"form", pack:"TRN-FM01", variant:"worksheet", sheetSha256,
  persona}`. Resolve `page` against the approved TRAIN worksheet roster and
  pin that exact leaf's print PDF. `persona` selects one of 99 fictional cards
  generated in the browser. The form has no real user details.
- `line`: `{kind:"line", proposalId, proposalSha256, cropSha256}`. Use the
  existing `line_verify` proposals from a private, approved TRAIN batch with
  a `contributor-train-` ID and `source_json.contributor_scope="train"`.
  Use first-pass candidates with no gates or gold. Pin the corresponding
  approved JPEG crop. The contributor API uses the existing exact/edit
  normalizer and stores decisions separately from public review exports.
- `handwriting`: `{kind:"handwriting", sentences, promptSha256, rights}`.
  Use one to ten assigned PD lines, a SHA over their UTF-8 text joined by LF,
  and a rights locator beginning `PD: `. The print view includes the page ID.
  A prompt digest cannot cross writer splits.

Put exact PDFs in `contributor-v1/sheets/<sha256>.pdf` and exact line crops
in `contributor-v1/line-crops/<sha256>.jpg` in the private TRAIN bucket.
Use distinct private `CONTRIBUTOR_DEV_MEDIA` and `CONTRIBUTOR_EVAL_MEDIA`
bindings when those splits are authorised. Print, forms, and line verification
are TRAIN tasks. DEV and EVAL writers get handwriting only. The private-eval-only
licence accepts EVAL writers only. Those submissions remain private and are
ineligible for an OPEN release regardless of the eval split assignment.

## Upload, withdrawal and approval

The app stores the original bytes in private quarantine and keeps opaque
writer/task IDs, digests, decisions and consent receipts in D1. Each result
carries the two accepted wording hashes and the licence version. It discards
client filenames and never exposes originals through download routes. This
intake accepts JPEG and PNG and rejects common identifying metadata fields.
Ask participants to turn off camera location and choose JPEG on phones that
default to HEIC. Check photos for unwanted content and strip personal metadata
from derivatives before any use outside quarantine. Gate all release or downstream transfers
on the requested split, privacy review and approved wording. Use capture
prompts and forms that contain no private source or held-out material.

The return code in the app is for withdrawal. A writer or guardian can stop
online and email the code to `heocrproject@gmail.com`. Once a request is
verified, the authenticated operator sends a same-origin POST to
`/api/contributor/v1/operator/withdrawals/<receipt>`. This closes access,
removes that writer's quarantined originals and submitted results, and keeps
a minimal pseudonymous consent and withdrawal ledger. Repeating the action
verifies removal again. Track and process any governed downstream copies
before marking a request complete. Keep the exact retention terms and operator
process aligned with the approved copy.

Each slot admits one D1 submission. Repeat submissions of the same data are
idempotent. The manifest caps work at 64 writers and 100 slots per writer, with
one successful row per slot. At those caps, one complete submission and
withdrawal cycle touches up to 51,200 submission table and index rows
(6,400 slots × four row/index entries × insert and delete). Reserve at least
60,000 writes for that cycle, account for sign-ins and any renewed consent,
and check the remaining daily budget before activation or a mass withdrawal.
Apply migration 0023 before shipping the app code. Use the private export and
recount in the production runbook. The local checks use invented accounts and
a disposable database and buckets.

## Consent copy for Shay to review

These are two alternative drafts. Choose one policy and approve both languages
and both roles before pinning. Agree the retention period and the timing of
any public release before approval.

### CC0-open option

**Guardian, English**

I am the writer's parent or legal guardian. I give permission for them to
choose whether to take part in the HeOCR writing and scanning project. We use
an age band and project code. The writer should photograph the assigned page
alone, with no faces, real names, contact details or location information.
Worksheet details are fictional. Approved contributions may be shared publicly
under CC0 1.0, allowing people to copy and reuse them. The team checks materials
before any release. Use the withdrawal code to contact heocrproject@gmail.com
to stop participation and request removal of copies the team controls.
Public copies other people already obtained may remain available.

**הורה או אפוטרופוס**

אני הורה או אפוטרופוס של הכותב או הכותבת. אני מאשר/ת להם לבחור אם להשתתף
במיזם הכתיבה והסריקה של HeOCR. אנחנו משתמשים בקבוצת גיל ובקוד מיזם.
מצלמים רק את הדף שהוקצה, בלי פנים, שמות אמיתיים, פרטי קשר או נתוני מיקום.
את הטפסים ממלאים בפרטים מומצאים. חומרים שיאושרו עשויים להתפרסם במסגרת
CC0 1.0, המאפשרת להעתיק אותם ולהשתמש בהם שוב. הצוות בודק את החומרים לפני
פרסום. כדי להפסיק להשתתף ולבקש הסרה של עותקים שבשליטת הצוות, אפשר לשלוח
את קוד ההסרה לכתובת heocrproject@gmail.com. עותקים שאנשים אחרים כבר קיבלו
עשויים להישאר זמינים.

**Writer, English**

I can choose whether to help. I will write and photograph only my assigned
pages. I will use pretend details for forms and leave my real name, other
people, and location out of the photo. If the team approves my work, it may be
shared publicly and people can reuse it. I can stop and ask for help removing
the team's copies. Copies other people already have may stay available.
I want to take part.

**הכותב או הכותבת**

אני יכול/ה לבחור אם להשתתף. אכתוב ואצלם רק את הדפים שקיבלתי. אשתמש בפרטים
מומצאים בטפסים ולא אכלול בצילום שם אמיתי, אנשים אחרים או מיקום. אם הצוות
יאשר את העבודה שלי, היא עשויה להתפרסם ואנשים יוכלו להשתמש בה שוב. אפשר
להפסיק ולבקש עזרה בהסרת העותקים של הצוות. עותקים שכבר הגיעו לאחרים עשויים
להישאר זמינים. אני רוצה להשתתף.

CC0 explains the permanence of the public waiver and fallback licence in its
[legal code](https://creativecommons.org/publicdomain/zero/1.0/legalcode.en).

### Private-evaluation-only option

**Guardian, English**

I am the writer's parent or legal guardian. I give permission for them to
choose whether to contribute to HeOCR's private evaluation. Only authorised
team members may use the contributions to check how the system reads writing.
The work stays private and is excluded from training and public release. We
use an age band and project code. Photograph only the assigned page. Leave out
faces, real names, contact details and location information. Use the
withdrawal code and email heocrproject@gmail.com to stop participation and
request removal of the team's copies.

**הורה או אפוטרופוס**

אני הורה או אפוטרופוס של הכותב או הכותבת. אני מאשר/ת להם לבחור אם לתרום
לבדיקה פרטית של HeOCR. רק חברי צוות מורשים ישתמשו בחומרים כדי לבדוק כיצד
המערכת קוראת כתב. החומרים יישארו פרטיים ולא ישמשו לאימון או לפרסום. אנחנו
משתמשים בקבוצת גיל ובקוד מיזם. מצלמים רק את הדף שהוקצה, בלי פנים, שמות
אמיתיים, פרטי קשר או נתוני מיקום. כדי להפסיק להשתתף ולבקש הסרה של
עותקי הצוות, אפשר לשלוח את קוד ההסרה לכתובת heocrproject@gmail.com.

**Writer, English**

I can choose whether to help. I will write and photograph only the pages
I was given. I will leave my real name, other people, and location out of the
photo. Only the project team will see my work for a private check. I can stop
and ask the team to remove its copies. I want to take part.

**הכותב או הכותבת**

אני יכול/ה לבחור אם להשתתף. אכתוב ואצלם רק את הדפים שקיבלתי. לא אכלול
בצילום שם אמיתי, אנשים אחרים או מיקום. רק צוות המיזם יראה את העבודה שלי
לצורך בדיקה פרטית. אפשר להפסיק ולבקש מהצוות להסיר את העותקים שלו.
אני רוצה להשתתף.
