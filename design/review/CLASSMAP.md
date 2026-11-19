# Class map: from the current markup to `review.css`

`review.css` is written so contrib can adopt it one view at a time. Most class names in `src/web/views/*.ts` are kept; this file lists what stays, what is renamed, what is new and what goes. Load `tokens.css`, `fonts.css` and `review.css` in place of `public/styles.css`, and add `class="rv"` to `<body>` (plus `task` on a task screen).

## Kept as they are

| Class (current file) | Notes |
|---|---|
| `.top`, `#nav`, `.brand` (`index.html`, `main.ts`) | `.brand` now holds `He<b>OCR</b><i>Review</i>`; add `<a class="home">` with the mark before it. Nav links take an icon and a `<span>` label |
| `.review`, `.lineverify`, `.consensus`, `.pagereview` | Root classes, unchanged |
| `.ask` | One language at a time; drop the inner English `<span>` |
| `.linebox`, `.linestrip`, `.seg` (`line.ts`) | Unchanged. `lineStrip()` keeps computing the pieces |
| `.txt`, `.txt.cand`, `mark.attn`, `.caret.attn`, `.ws`, `.sp` | Unchanged |
| `.precheck` | Add the flag icon as first child and wrap the text in a `<span>` |
| `.mine`, `.msg`, `.attrib` | Unchanged. Put `.precheck`, `.chips`, `.mine` and failed-save notices inside the new `.slot` |
| `.editbox`, `.preview`, `.check` | `.editbox` gains `.edittools` and `.savebar` (below) |
| `.ctxbox`, `.frame`, `.hl` | `.hl` is now the brand box: an outline with four handles, and no dimming shadow |
| `.actions`, `.act`, `kbd` | `.actions` sits inside the new `.dock`. Drop `.six`/`.five`: the grid sizes itself |
| `.subnav` | Moves inside `.dock`, after `.actions` in the DOM |
| `.savestate[data-state]` | Unchanged; now also used on line screens (`saved`, `saving`, `failed`) |
| `.progress`, `.bar` | `.progress` is now only the 3 px line; the text counts move to `.top .count` |
| `.card`, `.picker`, `.pick`, `.tag`, `.row`, `.muted`, `.small`, `.mono`, `.block`, `.gsi`, `.terms`, `.foot`, `.doc`, `.conventions` | Unchanged |
| `.prgrid`, `.scan`, `.lines`, `.prlines`, `.prline`, `.num`, `.lbody`, `.lhead`, `.flag`, `.state`*, `.tools`, `.lt`, `.pending`, `.decide`, `.confirmbtn`, `.reject`, `.looked`, `.excluded` (`page.ts`) | Unchanged. *`.prline .state` keeps its meaning; the whole-screen `.state` below is a different element |
| `.texts`, `.lab`, `.note`, `mark.del`, `mark.ins`, `mark.edit` (`review.ts`, `text.ts`) | Unchanged |

## Renamed or restyled

| Current | Becomes | Why |
|---|---|---|
| `button.primary` | `.act.primary` on answers; `button.primary` still works elsewhere | One button style |
| `.act.ok`, `.act.bad`, `.act.edit`, `.act.skip`, `.act.pointed` | plain `.act` (Exact, Correct, Save: `.act.primary`) | Answers are not coloured |
| `button.small` | `.act.quiet` (both are styled) | Same quiet control everywhere |
| `button.big` with `.sub` | `.act.primary` | One language, one line |
| `.tag.look`, `.tag.ai` | `.tag.look` for both | One look-here style |
| `.conf-high`, `.conf-medium`, `.conf-low` | plain `.tag` | Confidence colours nudge the answer |
| `.cta` | `.btn.primary` | |
| `.card.done` | `.state` inside `main.doc` | Shared with empty and error states |
| `.ctxscroll`, `.ctxband` | `.ctxbox.band` with the image inside and `button.open` across its foot | The whole band opens the page on a phone |
| `.viewer`, `.scroller`, `.zoombar` (`viewer.ts`) | `aside.side` with `.scroller` inside; `.backbar` on a phone | The page lives in the side column or a full-screen view |

## New

| Class | What it is |
|---|---|
| `body.rv`, `body.rv.task` | Scope for the stylesheet; `task` makes a task screen fill the window on a desktop |
| `.top .home`, `.top .where`, `.top .count` | The mark, batch title with line reference, and the counts |
| `.deck` | Wraps the work column and the page column |
| `.slot` | The one place for rare notices |
| `.notice`, `.notice.failed`, `.chips` | Notices and look-here chips |
| `.cropbar` | "2 pieces / Fit width" on a phone |
| `.dock` | The answer area: fixed to the bottom on a phone, a row on a desktop |
| `.moregroup`, `.moregroup.open`, `.scrim`, `.more-btn` | The rare answers: a sheet on a phone, part of the row on a desktop |
| `.act.quiet`, `.act[data-busy]`, `.act[data-needs-page]` | Quiet control, saving, and "open the page first" (phone) |
| `.edittools`, `.savebar`, `.changes` | Under the edit box: tools, Save and Cancel, the one-line difference |
| `body.swap` | Set from the "Side of Exact on a phone" setting; swaps the dock's two columns |
| `body.editing`, `body.typing` | Set while the box is open; `typing` for a typed line or blind pass |
| `.side`, `.side.open`, `.side.enlarged`, `.backbar` | The page: beside the task, full-screen on a phone, enlarged on a desktop |
| `.state`, `.state .mark`, `.hint`, `.stack` | Whole-screen states: done, empty, errors |
| `.field`, `.seg-control`, `.label`, `.btn` | Settings and general forms |
| `.toast` | Short confirmations |
| `.phone-only`, `.desktop-only` | Show an element on one layout only |
| `.ico`, `.ico.sm`, `.ico.flip` | Inline SVG icons; `flip` mirrors in Hebrew |

## Removed

| Class | Why |
|---|---|
| The source and provenance `.tag`s in `.meta` on line screens | The candidate's source is never shown |
| The prefill-source tags on the page review header | Same reason |
| `.keys` (the shortcut line) | Key caps sit on the buttons; `?` shows the list |
| `.legend` | The mark's meaning is in its `title` and in the conventions page |
| `.script-rashi` on tags | A script is information, not a warning; keep it as a plain `.tag` if it is shown at all |

## Suggested order of adoption

1. Tokens, fonts and the top bar on every view.
2. Line verification: `.dock`, `.moregroup`, `.slot`, `.savestate`, then editing.
3. The page (`.side`) and the flagged rule per device.
4. Consensus and reference audit, which reuse the same pieces.
5. General pages and the state screens.
6. Page review on a desktop, and the phone hand-off.
