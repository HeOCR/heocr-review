# Private contributor app v1

`/app/#contributor` uses the existing Google sign-in. The private roster pairs
each writer's pseudonymous reviewer ID with a separate, organiser-verified
guardian account. A Google login establishes account ownership. The organiser
confirms the guardian relationship before adding the pair. Enter an age band
only. Invited account holders without assignments can copy their account
code from the contributor link and share it privately with the organiser.
Keep enrolment and account matching outside public channels.

The invitation link opens the Hebrew sign-in screen. After signing in, a
writer can switch to English and will see only the queues assigned below.

Capture, handwriting and other intake switches are independent. For local
testing use invented inputs and a disposable Wrangler state. Production config
stays off until the lead approves activation, eval pins the writer assignments
and Shay approves the exact bilingual wording.

## Private manifest

Store the UTF-8 manifest in the TRAIN bucket at
`contributor-v1/config/<sha256>.json`. Set `CONTRIBUTOR_CONFIG_SHA256` to the
exact byte digest and `CONTRIBUTOR_APP_ENABLED` to `1` only in an authorised
environment. The manifest uses:

- `schema: "heocr.contributor.v1"` and
  `approval: {evalSplitSha256, leadGo}`, with the private eval split SHA and
  lead approval record ID.
- `policy: {version, licence: "cc0_open", guardian, assent}`. Each language key `he` and
  `en` under both roles has `{text, sha256}`. Each SHA covers the exact UTF-8
  text shown before agreement. A version change requires renewed agreement. Draft wording below stays outside the runtime manifest.
- `writers: [{id, writerAccount, guardianAccount, ageBand, split, tasks}]`.
  Generate a random `cw-` ID with 16 random bytes in hex. Use existing
  `rv_` pseudonyms and an organiser-confirmed age band (`10_12`, `13_15` or
  `16_17`). Confirm age eligibility with the guardian and keep only the band.
  Use an eval-assigned
  `train`, `dev`, or `eval_open`. Preserve writer ID and split across
  revisions. Preflight the proposed 30 EVAL and six DEV writers with eval
  before allocation, preserving writer and prompt disjointness.
- All tasks have an opaque `id` and printable `page`. Keep IDs stable across
  revisions to preserve the slot receipt. `writers[].tasks` is the allow-list
  for that writer. A queue appears only when its kind occurs in the list.
  First occurrence determines queue order, and only the first unfinished task
  of that kind can accept a new submission. For the starter group, assign the
  chosen two or three tasks from the TRN-PRINT-01 print-and-capture pack, an
  exact fictional form worksheet, and a handwriting copy sheet. Omit other
  work from that writer's list. Each photo task shows the guide for its
  assigned capture condition.
- `print`: `{kind:"print", mode, sheetSha256}`. Assign TRAIN PDF pages and
  use `flat`, `angle`, `shadow`, `crumpled`, `scribbled`, or `folded`
  per capture slot.
- `form`: `{kind:"form", pack:"TRN-FM01", variant:"worksheet", sheetSha256,
  referenceSha256}`. Resolve `page` against the approved TRAIN worksheet roster.
  Pin that exact leaf's PDF and its fictional field-value reference. The card
  displays the exact values in the reference's order. Writers copy those
  values verbatim.
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
Store the form reference JSON in the same private TRAIN bucket at
`contributor-v1/form-references/<sha256>.json`. The SHA covers the exact UTF-8
file bytes. This invented example illustrates the reference shape:

```json
{
  "schema": "heocr.contributor.form_reference.v1",
  "page": "P01",
  "worksheetSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "fields": [
    {"id": "sample-email", "label": "דוא״ל", "value": "sample@example.invalid"}
  ]
}
```

Check that each field label refers to the intended printed field and every
value is fictional. Change the assignment ID if a completed slot needs a
different reference. Keep each accepted reference available by its original
hash for QA and exact labels. Check captured text against the assigned
reference before admitting data. A missing or mistyped value needs a retake
or a corrected verified transcription of what appears in the photo.

Use distinct private `CONTRIBUTOR_DEV_MEDIA` and `CONTRIBUTOR_EVAL_MEDIA`
bindings when those splits are authorised. Print, forms, and line verification
are TRAIN tasks. DEV and EVAL writers get handwriting only. Contributions
remain in private quarantine until authorised for downstream use.

## Upload, withdrawal and approval

The app stores the original bytes in private quarantine and keeps opaque
writer/task IDs, digests, decisions and consent receipts in D1. Each result
carries the two accepted wording hashes and the licence version. A form or
handwriting submission also records the reference SHA shown to the writer. The
upload requires that SHA so an old page cannot submit against revised labels. It discards
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

Shay selected CC0 1.0 and ages 10–17. Approve the exact guardian and writer
wording in both languages before pinning. Agree the retention period and the
timing of any public release before approval.

**Guardian, English**

I am the writer's parent or legal guardian, and they are 10–17 years old.
I give permission for them to choose whether to take part in the HeOCR writing and scanning project. We use
an age band and project code. The writer should photograph the assigned page
alone, with no faces, real names, contact details or location information.
The writer will copy the assigned fictional worksheet details exactly. Approved contributions may be shared publicly
under CC0 1.0, allowing people to copy and reuse them. The team checks materials
before any release. Use the withdrawal code to contact heocrproject@gmail.com
to stop participation and request removal of copies the team controls.
Public copies other people already obtained may remain available.

**הורה או אפוטרופוס**

אני הורה או אפוטרופוס של הכותב או הכותבת, וגילם 10–17. אני מאשר/ת להם לבחור אם להשתתף
במיזם הכתיבה והסריקה של HeOCR. אנחנו משתמשים בקבוצת גיל ובקוד מיזם.
מצלמים רק את הדף שהוקצה, בלי פנים, שמות אמיתיים, פרטי קשר או נתוני מיקום.
לטפסים מעתיקים בדיוק את הפרטים המומצאים שניתנו. חומרים שיאושרו עשויים להתפרסם במסגרת
CC0 1.0, המאפשרת להעתיק אותם ולהשתמש בהם שוב. הצוות בודק את החומרים לפני
פרסום. כדי להפסיק להשתתף ולבקש הסרה של עותקים שבשליטת הצוות, אפשר לשלוח
את קוד ההסרה לכתובת heocrproject@gmail.com. עותקים שאנשים אחרים כבר קיבלו
עשויים להישאר זמינים.

**Writer, English**

I can choose whether to help. I will write and photograph only my assigned
pages. I will copy the pretend details I was given for forms exactly and
leave my real name, other people, and location out of the photo. If the team approves my work, it may be
shared publicly and people can reuse it. I can stop and ask for help removing
the team's copies. Copies other people already have may stay available.
I want to take part.

**הכותב או הכותבת**

אני יכול/ה לבחור אם להשתתף. אכתוב ואצלם רק את הדפים שקיבלתי. אשתמש בפרטים
מומצאים בטפסים ואעתיק אותם בדיוק כפי שקיבלתי. לא אכלול בצילום שם אמיתי, אנשים אחרים או מיקום. אם הצוות
יאשר את העבודה שלי, היא עשויה להתפרסם ואנשים יוכלו להשתמש בה שוב. אפשר
להפסיק ולבקש עזרה בהסרת העותקים של הצוות. עותקים שכבר הגיעו לאחרים עשויים
להישאר זמינים. אני רוצה להשתתף.

CC0 explains the permanence of the public waiver and fallback licence in its
[legal code](https://creativecommons.org/publicdomain/zero/1.0/legalcode.en).
