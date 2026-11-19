# HeOCR Review: design, direction round

The first step the brief asks for: **line verification on a phone (default, then editing) and on a desktop**, shown before the full set. Prepared 2026-11-19 against `HeOCR/heocr-review` at `2e6b83c`. Nothing here is final and nothing here is app code.

Look at `direction.png` first. The pages are in `mockups/he/` and `mockups/en/`; they follow the system light or dark setting.

| Path | What it is |
|---|---|
| `direction.png` | One board with the three screens, in Hebrew and English, light and night. |
| `mockups/he/`, `mockups/en/` | `line-phone-default`, `line-phone-editing`, `line-desktop` as static HTML and CSS. No script. |
| `mockups/png/` | Renders at 412 × 915 and 360 × 800 (2×), and at 1440 × 900, 1280 × 800 and 1024 × 768, `light/` and `night/`. |
| `css/tokens.css` | Brand tokens, the app extensions shared with the Android design, and four review extensions (scan paper, scan ink, attention mark). |
| `css/review.css` | Draft of the drop-in stylesheet, line verification only. It keeps the class names of `src/web/views/line.ts` where an element already exists. |
| `css/fonts.css`, `fonts/` | Noto Sans Hebrew 400/500/700 and JetBrains Mono 500/700, subset: 51 KB together. OFL texts and `subset_fonts.py` included. |
| `mockups/mock-scan-font/` | Frank Ruhl Libre (OFL), used only to draw the stand-in scans in the mockups. Not for the app. |
| `tools/` | The two scripts that produced the pages and renders. |

## What this direction proposes

**Phone**
- The scan crop and the candidate are at the top; every answer is in a dock at the bottom.
- The dock has two large buttons, 64 px high and 12 px apart: **Exact** (wider) and **Correct it**. Above them, a quiet row: Previous (undo), the save state, and **More** (print has niqqud, unreadable, misaligned, skip, in a sheet).
- The crop keeps the two-piece layout, with a visible toggle between "2 pieces" and "fit width".
- Under the candidate, the line among its neighbours, marked with the brand box; the whole band opens the full page.
- **Editing:** the top bar shrinks, the crop stays pinned above the text box, and Save and Cancel sit directly above the keyboard. One line says what changed. "Back to the candidate" and "Print has niqqud" are under the box.

**Desktop**
- The crop is one wide strip with the candidate under it, on the same right edge and sized to break where the crop breaks.
- All six answers are in one row, each with its key cap. Previous, zoom and the save state are below.
- The page is always beside the task, with the current line in the brand box. `P` enlarges it.

**Both**
- Same words, same order, same save-state position.
- The crop, candidate and notice slot keep fixed heights, so the next line lands in the same place.
- Exact is the only filled button. No green or red on the answers: they are choices, not verdicts. Progress is a thin accent line and two numbers.
- The candidate's source and provenance tags from the current screen are gone, as the brief requires. The book title and page stay.
- Attention marks ("look here") are a soft accent ground with a dotted underline, so they do not rely on colour.

## Known gaps in this round

- 1024 px wide is not tuned: the crop should fall back to two pieces there, and the page column should narrow.
- The candidate still wraps to three lines on a 412 px phone for a long line, against two crop pieces.
- Not drawn yet: flagged line, the More sheet, misaligned and typed-from-blank, full page open, saving and failed states.
- The stand-in scans are HTML text, so pinch-zoom and the real crop geometry are not exercised.
- Nothing was tested in the running app or on a phone.

## Questions for the owner, through the lead

1. **Exact as the one filled button.** It makes the common answer easy, as the brief suggests. If that reads as a nudge, the alternative is two equal outlined buttons.
2. **Skip inside More on a phone.** It keeps the dock to two targets. If skip is used often, it can take the quiet row's third place.
3. **The page always visible on a desktop.** For a flagged line, should the side page count as "opened", or should the reviewer still press `P`? This round assumes they still press `P`.
4. **Theme.** The mockups follow the system setting, with an override in settings, like the Android app. The site defaults to light.

---

`design[claude/claude-code#shay-macbook-m4]@heocr/opensource`
