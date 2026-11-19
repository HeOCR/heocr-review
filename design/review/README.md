# HeOCR Review: design files

The review web app in the Bounding Box brand, for desktop and phone. Prepared 2026-11-19 against `HeOCR/heocr-review` at `2e6b83c`. It replaces the direction round and follows the owner's four answers to it.

Start with [`SPEC.md`](SPEC.md). To see the screens, open [`mockups/index.html`](mockups/index.html) and narrow the window under 900 px for the phone layout, or look in `mockups/png/`.

Nothing here is app code, and nothing here loads anything from the network.

## Index

| Path | What it is |
|---|---|
| `overview.png` | One board with the main screens. |
| `SPEC.md` | Principles, tokens, layout, the flow per task, every component with states, saving and bad connections, the keyboard map, touch, what is not on a phone and why, right-to-left rules, accessibility, brand extensions, and the changes the design asks of the app. |
| `CLASSMAP.md` | From the current markup in `src/web/views/*.ts` to the stylesheet: kept, renamed, new, removed, and an order of adoption. |
| `USABILITY-CHECK.md` | Five tasks for the owner, ten minutes, phone and desktop. |
| `css/review.css` | **The drop-in stylesheet** (27 KB). One markup, phone and desktop. |
| `css/tokens.css` | Brand tokens for light and night, the app extensions, and four review tokens. Night follows the system; `data-theme` on `<html>` overrides it. |
| `css/fonts.css`, `fonts/` | Noto Sans Hebrew 400/500/700 and JetBrains Mono 500/700, subset WOFF2, 51 KB together; both OFL texts; `subset_fonts.py` holds the rebuild command. |
| `icons/` | 32 icons as SVG on a 24 px grid, `icons.json` (which mirror in Hebrew, and what each is for), `preview.png`. |
| `mockups/he/`, `mockups/en/` | 23 screens per language as static HTML on the stylesheets above. No script; each state is fixed in the markup. |
| `mockups/png/412x915/`, `mockups/png/1440x900/` | Renders of every screen, `light/` and `night/`, `he/` and `en/`. Phone renders are at 2× density. |
| `mockups/mock.css`, `mockups/mock-scan-font/` | The stand-in scans: invented text set in Frank Ruhl Libre (OFL). For the mockups only. |
| `strings.json` | Every string in the mockups as `[Hebrew, English]`. |
| `tools/` | The scripts that produced the pages, icons and renders. Reference only. |

## Screens

| Mockup | Screen |
|---|---|
| `line-01-default` | Line verification (also the "saved" state) |
| `line-02-flagged` | A pre-check flag |
| `line-03-editing` | Editing, keyboard up |
| `line-04-more` | The More sheet |
| `line-05-misaligned` | Misaligned: typed from blank |
| `line-06-typing` | A typed line or blind second pass |
| `line-07-full-page` | Full page open |
| `line-08-saving` | Saving |
| `line-09-failed` | Save failed |
| `consensus` | Volunteer lines |
| `audit` | Reference audit |
| `page-review` | Page review on a desktop; the hand-off on a phone |
| `signin`, `terms`, `tasks`, `settings`, `conventions` | The rest |
| `done`, `empty` | Done and empty states |
| `error-rate-limited`, `error-offline`, `error-server`, `error-quota` | Errors |

## Source of every asset

| Asset | Source | Licence |
|---|---|---|
| Tokens, the mark, the box | The brand handover in `HeOCR/heocr.github.io` (`design/brand-handover/`) | Project's own |
| App extension tokens, buttons, sheet, toast | The Android design in `HeOCR/heocr-desktop` (`design/android/`) | Project's own |
| Icons | Drawn for this handover; ten share their drawing with the Android set | Project's own |
| Noto Sans Hebrew, JetBrains Mono | `google/fonts`, subset by `fonts/subset_fonts.py` | SIL OFL 1.1 |
| Frank Ruhl Libre (mockups only) | Fontsource's build of the Google Fonts release | SIL OFL 1.1 |
| Text in the mock scans | Invented prose. No scan, no document text and no reviewer data from the app's batches | Project's own |
| Interface strings | The answers keep the app's current Hebrew labels; the rest is new wording | Project's own |

## Checks made

- Every screen rendered at 412 × 915 and 1440 × 900 in both themes and languages, and loaded at 360, 1024 and 1280 wide; none scrolls sideways.
- 760 controls measured at 412 and 360 wide: none under 44 × 44, none without a label.
- Contrast computed for the pairs listed in `SPEC.md` §11.
- First-screen payload is about 82 KB before the scan crop.

## Not checked

- Nothing was run in the app, on a phone, or with a screen reader.
- The mock scans are HTML text, so pinch-zoom and the real crop geometry are untested.
- New Hebrew wording needs the maintainer's review.
- 1024 wide loads without overflow but was only spot-checked by eye.

---

`design[claude/claude-code#shay-macbook-m4]@heocr/opensource`
