# HeOCR Review: design specification

The review web app in the Bounding Box brand, for a desktop with a keyboard and a phone held in one hand. Sizes are CSS px. Designed at 412 × 915 and 1440 × 900; checked at 360 × 800, 1024 × 768 and 1280 × 800; light and night; Hebrew (right to left) and English.

Owner decisions this spec follows: Exact is the only filled button; on a phone Skip is inside More; on a desktop the page beside the line counts as "opened" for a flagged line, on a phone it must be opened; the theme follows the system setting, with an override in settings.

## 1. Principles

1. **Accuracy before speed.** The common answer is one tap or one key. No answer is coloured as good or bad, and nothing rewards speed.
2. **Nothing moves.** The crop, the candidate and the notice slot keep their heights. The next line lands where the last one was.
3. **One model on both devices.** Same words, same order, same save-state position. One markup; the layout changes at 900 px.
4. **Rare cases are quiet.** A flag, a failed save or a misaligned line appear in one slot above the answers, with an icon and words.
5. **No bias.** Gold lines and blind-pass lines use exactly the same screen as ordinary lines. The candidate's source and provenance are not shown. Progress shows counts, never streaks, ranks or agreement rates.

## 2. Tokens

`css/tokens.css` carries the brand tokens for light and night and the app extensions already used by the Android design (`--control-line`, `--accent-press`, `--scrim`, toast colours, `--touch`, `--bar`, `--pad`, `--gap`).

New for the review app:

| Token | Light | Night | Used for |
|---|---|---|---|
| `--scan-bg` | `#f1ece0` | `#ddd7ca` | Ground behind every scan image. Stays light at night: a scan is a photograph of paper |
| `--scan-ink` | `#2a2622` | `#2a2622` | Controls drawn on the scan ground |
| `--attn-bg` | `#eef1ff` | `#1b2040` | "Look here" marks in the candidate and look-here chips |
| `--attn-line` | `#2447f9` | `#8fa3ff` | The dotted underline of those marks |

Green (`--ok`) and red (`--no`) appear only in the diff of a correction (inserted, removed) and in a failed-save notice. They never colour an answer button.

**Type.** Noto Sans Hebrew for all Hebrew and all body text; JetBrains Mono for the wordmark, counts, key caps, small labels and tags.

| Role | Phone | Desktop |
|---|---|---|
| Candidate text | 20.5 / 34 | 27 / 46 (22 under 1200 wide) |
| Edit box | 21 / 34 | 27 / 43 |
| Question (`.ask`) | 15, bold | 16, bold |
| Main answers | 19, bold | 15.5, bold |
| Quiet controls, notices | 14.5 | 14.5 |
| Save state, source line | 13 | 13 |
| Labels, tags, counts | 12 mono | 12 mono |
| Key caps | hidden | 11 mono |

## 3. Layout

### Phone (under 900 px)

Top to bottom: top bar (52), progress line (3), question, **crop** (min 190), **candidate** (min 76), notice slot, the line among its neighbours, then free space. Fixed to the bottom: the **dock**.

The dock has two rows. Lower row, 64 high, 12 apart: **Exact** (three fifths of the width) and **Correct it**. Upper row, 44 high: Previous at the start, the save state in the middle, More at the end. The dock pads for the bottom inset.

- Exact is on the start side: the right in Hebrew, under a right thumb. Settings has "Side of Exact on a phone" for left-handed use, which swaps the two columns.
- More opens a sheet from the bottom with Print has niqqud, Unreadable, Misaligned and Skip, each 60 high with an icon and one line of explanation. Tapping the dimmed area or pressing Back closes it.

### Desktop (900 px and wider)

Two columns. The work column (up to 1000 wide) holds the question, the crop as one wide strip, the candidate on the same right edge, the notice slot (min 46, so a notice does not push the answers), the answers in one row, and a row with Previous, zoom and the save state. The page column (280 to 460 wide) always shows the page with the current line in the box.

Under 1200 wide the crop falls back to two pieces and the candidate drops to 22.

### The crop

- The line is cut from the context crop on the client, as today. The `.linebox` keeps a fixed minimum height and centres the strip.
- **Phone:** two pieces by default, right piece first. A two-button control under the strip switches between "2 pieces" and "Fit width" (the whole line across the width, smaller). Pinch zooms the strip; the box scrolls sideways when zoomed.
- **Desktop:** one strip when it fits at the chosen ink height, otherwise two. `+`/`−` (or `Z`/`X`) step the zoom.
- **Mapping the eye.** The candidate has the same inline edges as the crop. The script should pick the candidate's font size (19 to 25 on a phone, 22 to 31 on a desktop) so that it breaks into as many lines as the crop has pieces whenever it can.

### The page

- **Phone:** the band under the candidate shows the line among its neighbours, marked with the brand box, with a "Full page" button across its foot. It opens the page full-screen (`.side.open`): the scan scrolls and pinch-zooms, the line is boxed and scrolled into view, and one large "Back to the line" button sits at the bottom with zoom out and zoom in beside it.
- **Desktop:** the page is always in the side column. `P` enlarges it over the task (`.side.enlarged`); `P` or `Esc` returns.

The brand box (1.5 px accent outline, four 8 px handles) is used in exactly one way in this app: to mark the current line on a scan (`.hl`). It is not used on buttons, cards or titles.

## 4. Screen flow

```
sign-in → terms (once) → tasks ─┬─ line verification ─┐
                                ├─ consensus          ├─ item → answer → next item … → done
                                ├─ reference audit    ┘
                                └─ page review (desktop; phone shows the hand-off)
any screen → conventions, settings
any save → saved | failed (rate limited, offline, server error, quota)
```

### 4.1 Line verification

| State | Mockup | What changes |
|---|---|---|
| Default | `line-01-default` | The screen above |
| Flagged | `line-02-flagged` | The slot shows the pre-check notice with the flag icon; the doubtful span is marked in the candidate. **Phone:** Exact is drawn disabled and the "Full page" button turns into the filled accent; opening the page enables Exact. **Desktop:** Exact stays enabled, because the page is beside the line |
| Editing | `line-03-editing` | See 4.2 |
| More | `line-04-more` | The sheet (phone). On a desktop the same four buttons are in the row |
| Misaligned | `line-05-misaligned` | A blank box, one sentence of instruction, "Save as misaligned". No niqqud checkbox |
| Typed line or blind second pass | `line-06-typing` | No candidate and no hint of one. The box is open from the start. The answers that are not text (Unreadable, More than one line, No text, Skip) are in More on a phone and in the row on a desktop. A blind pass looks the same as a typed line |
| Full page | `line-07-full-page` | See 3 |
| Saving | `line-08-saving` | The pressed answer shows "Saving…"; the others are disabled; the save state says "Saving…" |
| Saved | `line-01-default` | The next line is shown and the save state reads "Previous decision saved" with a check |
| Failed | `line-09-failed` | The same line stays. The slot shows a notice with the reason, "Try again" and "Kept on this device". The save state reads "Not saved" with a warning icon |

Gold lines have no state of their own. They must use the default screen byte for byte.

### 4.2 Editing

Opening the box (`E`, or Correct it):

- **Phone.** The top bar becomes a 44 px bar with Cancel (×), the title and the line reference. The progress line, question, candidate, context band and dock are hidden. The crop stays pinned at the top, at 50 px per piece, directly above the box. Under the box: one line saying what changed, "Back to the candidate", and the niqqud checkbox. Save and Cancel sit in a bar fixed directly above the keyboard. With the keyboard up on a 412 × 915 phone, crop, box and Save are all visible.
- **Desktop.** The box opens under the candidate, which stays visible. The answers are dimmed while the box is open. `Ctrl+Enter` saves, `Esc` cancels.
- **The box:** `dir="rtl"`, `lang="he"`, three rows, grows with the text, no spell-check, no auto-capitalise, no line breaks. The caret starts at the end of the text. Each character is typed where the caret is; digits and Latin run left to right inside the line as the browser's bidi does it.
- **"You changed":** the removed text struck through in red, the inserted text underlined in green, in one line. It replaces today's three-row comparison on a phone; a desktop may keep the code-point row below it.
- **"Back to the candidate"** restores the candidate text in one tap.
- **Niqqud-free typing:** the checkbox "Print has niqqud (type letters only)" turns the answer into `pointed_print`. If niqqud is typed, saving is refused with the reason in the message line, as today.
- **Drafts.** The text being edited is kept in the browser (session storage) per line, so a reload or a dropped connection does not lose it. Nothing is written to the database until Save.

### 4.3 Consensus (volunteer lines)

The line verification screen with these differences (`consensus`): the main answers are **Correct** and **Correct it**; More holds Print has niqqud, Unreadable, Not on the page and Skip; there is no Previous, because a volunteer's decision is final; the top bar shows the volunteer's own count only and the progress line is empty; look-here hints are chips in the slot; a Help button reopens the introduction.

### 4.4 Reference audit

`audit`: the crop, a category tag, the text now and the text proposed with the difference marked, and the agent's note as a quiet quote. The two main answers, **Accept** and **Reject**, are equal in size and both outlined: neither is the expected one. Edit and Skip are in More on a phone. The page is in the side column or behind "Full page".

### 4.5 Page review

- **Desktop** (`page-review`): the scan and the lines side by side, each scrolling on its own; moving to a line scrolls the scan so the line's box is in view. The current line has the accent border and soft ground, its tools appear under it with their key caps, and its box is drawn on the scan. Flags are chips above the line; a looked-at flag turns grey. Under the list: add a line, back to the pre-fill, skip the page; then Confirm the page (disabled while flagged lines remain, with the count stated above the list), the draft's save state, and the reject disclosure.
- **Phone:** see section 9.

### 4.6 The rest

| Screen | Mockup | Notes |
|---|---|---|
| Sign-in | `signin` | One heading, two sentences, Google's button in its own centred box (min height 44, not restyled), the reason for Google sign-in, the two policy links |
| Terms | `terms` | The existing wording in a card, the pseudonym, the optional credit checkbox and name, one primary button |
| Tasks | `tasks` | One card per batch: task name, count left, title, thin progress line. Page-review batches carry an "On a computer" tag |
| Done, empty | `done`, `empty` | The state layout: icon in a square frame, title, one sentence, actions |
| Errors | `error-*` | The same layout. Each says what happened, whether the answer is safe, and what to do |
| Settings | `settings` | Appearance (System, Light, Night), language, side of Exact, named credit, sign out |
| Conventions | `conventions` | A two-column list: what is printed, what to type |

## 5. Components

States: default / hover / focus / pressed / disabled, and saving / saved / error where they apply. Focus is always a 2 px accent outline, 2 px away, on `:focus-visible`.

| Component | Class | Default | Hover | Pressed | Disabled |
|---|---|---|---|---|---|
| Main answer | `.act` | min height 48 (64 in the phone dock, 68 in the desktop row); 1 px `--control-line`; ground `--bg`; text bold | border `--accent`, ground `--accent-soft` | same as hover | ground `--tag`, border `--line`, text `--muted` |
| Exact (the one filled button) | `.act.primary` | ground and border `--accent`, text `--on-accent` | `--accent-press` | `--accent-press` | as above |
| Answer while saving | `.act[data-busy]` | ground `--tag`, border `--control-line`, label "Saving…", cursor progress | | | |
| Quiet control | `.act.quiet`, `button.small` | min height 44, no border, 14.5 | ground `--accent-soft` | same | text `--line-strong` |
| Key cap | `kbd` | 1 px `--line-strong`, mono 11; on the filled button it takes the button's text colour | | | hidden under 900 px and on touch devices |
| Crop control | `.cropbar button` | 44 × 44 min, 1 px border on the scan ground | | `aria-pressed="true"`: ink ground, paper text | |
| Notice | `.precheck`, `.notice` | ground `--tag`, icon 20, text 14 | | | |
| Failed notice | `.notice.failed` | ground `--no-soft`, icon `--no`, `role="alert"` | | | |
| Save state | `.savestate[data-state]` | `saved`: check and words, muted. `saving`: words. `failed`, `stale`: warning icon, bold, `--no` | | | |
| Look-here mark | `mark.attn`, `.tag.look` | ground `--attn-bg`, 2 px dotted underline `--attn-line` | | | |
| Edit box | `.editbox textarea` | 1.5 px `--accent` border | | focus: 2 px outline | |
| Checkbox | `.check` | 20 box in a 44-high row | | checked: accent with an inner gap | |
| Segmented choice | `.seg-control` | 44 high, 1 px `--control-line` | | `aria-pressed="true"`: ink ground | |
| Sheet | `.moregroup.open` | from the bottom, 1.5 px top rule, grip, rows 60 high | | row ground `--accent-soft` | |
| Toast | `.toast` | as in the Android design; used for "link copied" | | | |
| Tag | `.tag` | ground `--tag`, mono 12 | | | |
| Card, task card | `.card`, `a.pick` | 1 px `--line-strong`, radius 2, no shadow | task card: border `--accent`, ground `--accent-soft` | | |
| State screen | `.state` | 56 px framed icon, title, sentence, hint, stacked actions | | | |
| Progress | `.progress > .bar` | 3 px line, `--accent` on `--line` | | | |

## 6. Saving and bad connections

The database is written only when the user commits a decision; nothing is saved per keystroke.

1. **On commit** the pressed answer shows "Saving…" and every answer is disabled (`line-08-saving`). A second tap cannot send a second decision.
2. **On success** the next line appears and the save state reads "Previous decision saved".
3. **On failure** the line stays, the slot shows why, and the answer (and any typed text) is written to the browser's storage, keyed by the line. "Try again" resends it. The notice stays until the save succeeds; it is never dismissed on its own.
4. **Offline** is detected from the failed request and from the browser's `online` event; when the connection returns the kept answer is sent once, and the user sees it turn into "saved".
5. **Rate limited, server error, quota** use the same notice with their own sentence. If no line can be shown at all, the full-screen error state is used.

| Case | What the user reads |
|---|---|
| Rate limited | Too many actions in a minute; continue in about half a minute |
| Offline | No connection; the answer is kept on this device and will be sent |
| Server error | Something went wrong on our side; the answer is kept; write to us if it repeats |
| Quota reached | Today's quota is used up; saved decisions are safe; it resets at midnight UTC |

## 7. Keyboard map (desktop)

Shortcuts are on physical keys (`e.code`), so they work in a Hebrew layout. Each key cap is printed inside the button it triggers.

| Key | Line verification | Consensus | Reference audit |
|---|---|---|---|
| `Enter`, `1` | Exact | Correct | |
| `E`, `2` | Correct it | Correct it | Edit |
| `N` | Print has niqqud | Print has niqqud | |
| `U`, `3` | Unreadable | | |
| `M`, `4` | Misaligned | | |
| `A` / `R` | | | Accept / Reject |
| `S`, `5` | Skip | Skip | Skip |
| `B`, `Backspace` | Previous | | Previous |
| `+` / `−`, `Z` / `X` | Zoom | Zoom | Zoom |
| `P` | Enlarge the page | Enlarge the page | Enlarge the page |
| `Ctrl+Enter` / `Esc` | Save / cancel the edit | same | same |
| `J`, `T` | (typed line) More than one line, No text | | |

Page review keeps its keys: `Enter` looked and next flagged line, `↑`/`↓`, `Alt+Enter` split, `Alt+J` merge, `Alt+N`, `Alt+X`, `Alt+U`, `Alt+↑`/`↓` move, `Alt+A` add, `Alt+-` dash, `Ctrl+Enter` confirm.

Proposed changes:

1. **Drop `Backspace` for Previous.** It is the key a typist reaches for by habit, and one stray press leaves the line. `B` is enough.
2. **`Esc` closes the enlarged page and the More sheet**, as well as cancelling an edit.
3. **`?` shows the key list** in a small panel, replacing the line of shortcuts under the answers, which the key caps on the buttons now make redundant.
4. A held key still never repeats a decision.

## 8. Touch

Few gestures, each with a visible control that does the same thing:

| Gesture | Where | Visible equivalent |
|---|---|---|
| Pinch | The crop and the full page | The "2 pieces / Fit width" control; zoom buttons on the full page |
| Drag | A zoomed crop, the full page | none needed |
| Tap the context band | Opens the full page | The "Full page" button on the band |
| Tap outside the sheet | Closes More | The system Back button |

No swipe answers. A swipe that decides a line is too easy to trigger by accident and cannot be undone by sight.

## 9. Deliberately not on a phone

| What | Phone behaviour | Why |
|---|---|---|
| Page review | The batch is listed with an "On a computer" tag. Opening it shows the hand-off screen: one sentence of explanation, "Copy a link to this page", "Go to a line task", and the page with its pre-fill to read, view only | A page is dozens of lines with split, merge, move and add. On a phone that is slow and error-prone, and errors here become reference data. View-only is kept so the owner can look at a page away from the desk |
| Admin views | Not adapted | Desktop only, as the brief allows |
| Key caps and the shortcut list | Hidden | No keyboard |
| The code-point row of the comparison | Hidden while editing | The "You changed" line carries the same decision in one row |
| Zoom buttons on the crop | Replaced by pinch and the two-state control | Two fewer targets beside the answers |

## 10. Right to left and left to right

- The interface follows the user's language: `<html lang dir>`. Everything uses logical properties, so the layout mirrors with `dir` alone.
- The crop is always laid out left to right internally (`dir="ltr"` on `.linestrip`) with the right piece first. The candidate and the edit box are always `dir="rtl"`, whatever the interface language, and share the crop's inline edges.
- Text from documents and batch titles is isolated with `<bdi>`.
- Counts, key caps, the pseudonym, versions and dates are left to right (`.num`, `.mono`, `kbd`).
- Mixed lines (digits, Latin, brackets) rely on the browser's bidi with `unicode-bidi: plaintext` on `.txt`; odd spaces and invisible characters keep their visible markers (`.ws`, `.sp`).
- Icons that mirror in Hebrew: Previous, Skip, Back, Sign out. All others do not (`icons/icons.json`).
- "Side of Exact on a phone" swaps the dock's two columns without changing `dir`.

## 11. Accessibility

- **Contrast** (AA): text on ground 18.7 light and 15.5 night; muted text 6.3 and 6.8; muted on `--tag` 5.5 and 5.7; accent on ground 6.3 and 7.8; label on the filled button 6.3 and 8.0; control borders 3.4 and 4.1; `--scan-ink` on `--scan-bg` 12.7 and 10.5; failed-save text on `--no-soft` 15.9 and 13.0; diff green and red on the ground 7.1 and 7.3 light, 9.9 and 8.4 night.
- **Targets:** every control in the mockups measures at least 44 × 44 at 412 and 360 wide (checked by script: 760 controls, none smaller). The two main answers are 64 high and 12 apart.
- **Labels:** icon-only controls carry `aria-label`; the crop is `role="img"` with a label; the save state, the "You changed" line and notices are `role="status"`, a failed save is `role="alert"`; the progress line is `role="progressbar"`; the sheet is a labelled group; the page column is a labelled `aside`.
- **Not colour alone:** look-here marks have a dotted underline; the diff uses strike-through and underline; save states have an icon and words; the flagged state has an icon and a sentence.
- **Zoom and large text:** layouts are flex and grid with wrapping labels and no fixed heights on text; at 200% browser zoom the desktop layout becomes the phone layout (the breakpoint is in px).
- **Motion:** none is required. Sheets and overlays may fade in 160 ms; `prefers-reduced-motion` removes it.
- **Focus:** after a decision, focus returns to the first answer of the new line, so `Enter` keeps working and a screen reader starts from the question.

## 12. Performance

First screen beyond the scan crop: `review.css` 27 KB, `tokens.css` 3 KB, `fonts.css` 1 KB, five font files 51 KB, icons inline in the markup. About 82 KB uncompressed against the 150 KB budget. Line verification needs only Noto Sans Hebrew 400 and 700 and JetBrains Mono 500 and 700 on first paint.

## 13. Brand extensions made here

1. The four review tokens in section 2.
2. The box used as a working marker on a scan (`.hl`), and nowhere else.
3. A scan ground that stays light in night mode.
4. The dock with one filled and one outlined answer, and the sheet for rare answers.
5. Key caps as a component.
6. The segmented choice in settings.
7. Twenty new icons for answers, line tools and states, in the Android set's drawing rules.

## 14. Changes this design asks of the app (for contrib)

1. Remove the candidate's source and provenance tags from the line screen; keep the book title and page.
2. Show the interface in one language at a time instead of Hebrew and English together.
3. On a desktop, treat the side page as "seen" for a flagged line; on a phone require the full page to be opened.
4. Keep a failed decision in browser storage and resend it; today a failure only prints a message.
5. Add the settings for appearance, language and the side of Exact.
6. On a phone, replace the page-review screen with the hand-off.
7. Pick the candidate's font size to match the crop's pieces.

## 15. Not verified

Nothing was run in the app, on a phone or with a screen reader. The scans in the mockups are HTML stand-ins, so pinch-zoom, real crop geometry and image loading are not exercised. The keyboard height on the editing mockup is a 318 px placeholder.

---

`design[claude/claude-code#shay-macbook-m4]@heocr/opensource`
