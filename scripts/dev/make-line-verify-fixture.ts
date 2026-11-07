/**
 * Write the synthetic line_verify_items.v1 test bundle (items.json and pages/) used by the tests and for trying
 * the line verification task locally or on preview. Every page is drawn here from made-up Hebrew text; nothing comes
 * from a real scan or source.
 *
 *   npx tsx scripts/dev/make-line-verify-fixture.ts [--out test/fixtures/line_verify]
 *
 * The committed bundle is this script's output; rerunning it on another machine may draw slightly different
 * pixels (fonts), which changes the image checksums but not the test expectations.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { parseArgs, str } from "../lib/args";

const WIDTH = 1400;
const HEIGHT = 1500;
const TOP = 140;
const LEADING = 96;
const FONT = 46;

interface Line {
  printed: string;
  candidate: string;
  /** [start, end] code-point offsets into the candidate. */
  spans: [number, number][];
  difficulty: number;
  stratum: "hard" | "random";
  rank: number;
  alignment: number;
  faded?: boolean;
}

interface Page {
  page_id: string;
  source: "wikisource_he_proofread" | "benyehuda_nli_aligned";
  provenance: "wikisource_quality3_single_proofreader" | "pby_human_typed_aligned";
  book_id: string;
  book_title: string;
  page_label: string;
  text_license: string;
  attribution: string;
  release_split: "train" | "validation" | "test" | null;
  lines: Line[];
}

const cp = (s: string) => Array.from(s).length;
const spanOf = (text: string, part: string): [number, number] => {
  const at = text.indexOf(part);
  if (at < 0) throw new Error(`${part} not in ${text}`);
  const start = cp(text.slice(0, at));
  return [start, start + cp(part)];
};

const A1 = "בראשית היתה המלה, והמלה היתה אצל הספר.";
const A2p = "הילד הלך אל בית הספר בבקר השכם.";
const A2c = "הילד הלך אל בית הספר בבוקר השכם.";
const A3p = "ויאמר: לא אוכל לעשות את הדבר הזה.";
const A3c = "ויאמר: לא אוכל לעשות את הדבר הזה";
const A4 = "שורה זו דהויה מאוד ואי אפשר לקרוא אותה.";
const A5 = "זוהי השורה החמישית של העמוד.";
const A6 = "ואחריה באה השורה השישית והאחרונה.";
const A7 = "שָׁלוֹם עֲלֵיכֶם, אָמַר הַזָּקֵן.";
const B1 = "בימים ההם ישב הסופר בחדרו וכתב.";
const B2p = "הנר דלק על השלחן כל הלילה.";
const B2c = "הנר דלק על השולחן כל הלילה.";
const B3 = "ובבקר יצא אל השוק לקנות לחם.";
const B4p = "ספר זה נדפס בירושלים בשנת תר״ץ.";
const B4c = "ספר זה נדפס בירושלים בשנת תר\"ץ.";

const PAGES: Page[] = [
  {
    page_id: "wikisource_he_proofread:fixture_lines__p0001",
    source: "wikisource_he_proofread",
    provenance: "wikisource_quality3_single_proofreader",
    book_id: "fixture_lines",
    book_title: "ספר שורות לדוגמה (סינתטי)",
    page_label: "1",
    text_license: "CC BY-SA 4.0 (synthetic test text)",
    attribution: "Synthetic test page drawn for HeOCR Review; not a real scan or text. / עמוד סינתטי לבדיקות; לא סריקה אמיתית.",
    release_split: null,
    lines: [
      { printed: A1, candidate: A1, spans: [], difficulty: 0.12, stratum: "random", rank: 7, alignment: 0.98 },
      { printed: A2p, candidate: A2c, spans: [spanOf(A2c, "בבוקר")], difficulty: 0.81, stratum: "hard", rank: 0, alignment: 0.95 },
      { printed: A3p, candidate: A3c, spans: [[cp(A3c), cp(A3c)]], difficulty: 0.64, stratum: "hard", rank: 2, alignment: 0.93 },
      { printed: A4, candidate: A4, spans: [[0, cp(A4)]], difficulty: 0.9, stratum: "hard", rank: 1, alignment: 0.41, faded: true },
      { printed: A5, candidate: A6, spans: [spanOf(A6, "השישית")], difficulty: 0.7, stratum: "hard", rank: 3, alignment: 0.38 }, // misaligned: the next line's text
      { printed: A6, candidate: A6, spans: [], difficulty: 0.2, stratum: "random", rank: 8, alignment: 0.97 },
      { printed: A7, candidate: A7, spans: [spanOf(A7, "עֲלֵיכֶם")], difficulty: 0.55, stratum: "hard", rank: 4, alignment: 0.9 },
    ],
  },
  {
    page_id: "benyehuda_nli_aligned:fixture_pby_42__p0003",
    source: "benyehuda_nli_aligned",
    provenance: "pby_human_typed_aligned",
    book_id: "fixture_pby_42",
    book_title: "סיפורים לדוגמה (סינתטי)",
    page_label: "ג",
    text_license: "public domain (synthetic test text)",
    attribution: "Synthetic test page drawn for HeOCR Review; not a Project Ben-Yehuda text or an NLI scan.",
    release_split: "test",
    lines: [
      { printed: B1, candidate: B1, spans: [], difficulty: 0.1, stratum: "random", rank: 9, alignment: 0.99 },
      { printed: B2p, candidate: B2c, spans: [spanOf(B2c, "השולחן")], difficulty: 0.6, stratum: "hard", rank: 5, alignment: 0.92 },
      { printed: B3, candidate: B3, spans: [spanOf(B3, "ובבקר")], difficulty: 0.3, stratum: "random", rank: 10, alignment: 0.96 },
      { printed: B4p, candidate: B4c, spans: [spanOf(B4c, "תר\"ץ")], difficulty: 0.66, stratum: "hard", rank: 5, alignment: 0.91 },
    ],
  },
];

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function drawLine(text: string, faded: boolean): Promise<{ png: Buffer; box: [number, number, number, number] }> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${LEADING}">
  <rect width="100%" height="100%" fill="#fbf8f0"/>
  <text x="${WIDTH - 130}" y="${Math.round(LEADING * 0.66)}" font-family="Times New Roman, David, Frank Ruehl CLM, serif" font-size="${FONT}"
    direction="rtl" text-anchor="start" fill="${faded ? "#d6d0c4" : "#1d1a16"}">${escape(text)}</text></svg>`;
  let img = sharp(Buffer.from(svg));
  if (faded) img = img.blur(4);
  const png = await img.png().toBuffer();
  const trimmed = await sharp(png).trim({ background: "#fbf8f0", threshold: faded ? 4 : 30 }).toBuffer({ resolveWithObject: true });
  const left = -(trimmed.info.trimOffsetLeft ?? 0);
  const top = -(trimmed.info.trimOffsetTop ?? 0);
  return { png, box: [left, top, left + trimmed.info.width, top + trimmed.info.height] };
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const out = resolve(str(flags, "out", "test/fixtures/line_verify"));
  rmSync(join(out, "pages"), { recursive: true, force: true });
  mkdirSync(join(out, "pages"), { recursive: true });
  const pages: Record<string, unknown>[] = [];
  const items: Record<string, unknown>[] = [];
  for (const page of PAGES) {
    const drawn: { png: Buffer; y: number; box: [number, number, number, number] }[] = [];
    for (const [i, line] of page.lines.entries()) {
      const d = await drawLine(line.printed, line.faded === true);
      const y = TOP + i * LEADING;
      drawn.push({ ...d, y, box: [d.box[0], d.box[1] + y, d.box[2], d.box[3] + y] as [number, number, number, number] });
    }
    const jpeg = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: "#fbf8f0" } })
      .composite(drawn.map((d) => ({ input: d.png, left: 0, top: d.y })))
      .jpeg({ quality: 88 })
      .toBuffer();
    const sha = createHash("sha256").update(jpeg).digest("hex");
    writeFileSync(join(out, "pages", `${sha}.jpg`), jpeg);
    pages.push({
      page_id: page.page_id,
      image: `pages/${sha}.jpg`,
      sha256: sha,
      width: WIDTH,
      height: HEIGHT,
      source: page.source,
      book_id: page.book_id,
      book_title: page.book_title,
      page_label: page.page_label,
      text_license: page.text_license,
      attribution: page.attribution,
      release_split: page.release_split,
    });
    page.lines.forEach((line, i) => {
      const box = drawn[i]!.box;
      const above = drawn[i - 1]?.box ?? box;
      const below = drawn[i + 1]?.box ?? box;
      const context: [number, number, number, number] = [
        Math.min(box[0], above[0], below[0]),
        above[1],
        Math.max(box[2], above[2], below[2]),
        below[3],
      ];
      items.push({
        item_id: `${page.page_id}#L${String(i + 1).padStart(3, "0")}`,
        page_id: page.page_id,
        line_index: i + 1,
        box,
        context_box: context,
        candidate_text: line.candidate.normalize("NFC"),
        candidate_provenance: page.provenance,
        alignment_score: line.alignment,
        attention_spans: line.spans,
        difficulty: line.difficulty,
        stratum: line.stratum,
        rank: line.rank,
      });
    });
  }
  const bundle = {
    schema_version: "line_verify_items.v1",
    batch_id: "fixture_line_verify_v1",
    description: "Synthetic fixture for HeOCR Review tests: two drawn pages of made-up Hebrew text, not from any source.",
    created_at: "2026-11-07",
    generator: { tool: "heocr-review scripts/dev/make-line-verify-fixture.ts", ref: "fixture" },
    pages,
    items,
  };
  writeFileSync(join(out, "items.json"), JSON.stringify(bundle, null, 1) + "\n");
  console.log(JSON.stringify({ out, pages: pages.length, items: items.length }));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
