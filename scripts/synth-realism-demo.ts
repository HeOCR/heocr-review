/** Local screenshot fixture. Both sides are generated; no dataset pages or reviewer data. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { CLEARANCE_SCHEMA, MANIFEST_SCHEMA, type ImageFile, type RealismItem } from "../src/tasks/synth_realism/schema";

const folder = resolve(process.argv[2] ?? ".import/synth-demo");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const lines = [
  "דברי קהלת בן דוד מלך בירושלם",
  "הבל הבלים אמר קהלת הבל הבלים הכל הבל",
  "מה יתרון לאדם בכל עמלו שיעמל תחת השמש",
  "דור הלך ודור בא והארץ לעולם עמדת",
  "וזרח השמש ובא השמש ואל מקומו שואף",
  "הולך אל דרום וסובב אל צפון סובב סבב",
  "כל הנחלים הלכים אל הים והים איננו מלא",
  "כל הדברים יגעים לא יוכל איש לדבר",
  "לא תשבע עין לראות ולא תמלא אזן משמע",
  "מה שהיה הוא שיהיה ומה שנעשה הוא שיעשה",
  "ואין כל חדש תחת השמש",
  "יש דבר שיאמר ראה זה חדש הוא",
  "כבר היה לעלמים אשר היה מלפננו",
  "אין זכרון לראשנים וגם לאחרנים שיהיו",
];

async function save(name: string, bytes: Buffer): Promise<ImageFile> {
  const path = `images/${name}.jpg`;
  await writeFile(join(folder, path), bytes, { flag: "wx" });
  return { path, sha256: sha(bytes) };
}

async function page(id: string, seed: number, style: "aged" | "clean" | "obvious") {
  let state = seed;
  const rand = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const w = 720, h = 920;
  const paper = style === "aged" ? "#f3e5c3" : style === "obvious" ? "#dae8f4" : "#faf1d9";
  const edge = style === "aged" ? "#bd9866" : style === "obvious" ? "#93b7e3" : "#d1b486";
  const ink = style === "obvious" ? "#274d78" : "#392c20";
  const grains = Array.from({ length: style === "aged" ? 420 : 150 }, () =>
    `<circle cx="${Math.round(rand()*w)}" cy="${Math.round(rand()*h)}" r="${(rand()*4+.4).toFixed(1)}" fill="${edge}" opacity="${(rand()*.18).toFixed(2)}"/>`).join("");
  const paragraph = Array.from({ length: 22 }, (_, i) => {
    const text = lines[(i + seed) % lines.length];
    const y = 179 + i * 29 + Math.floor(i / 7) * 10;
    const x = 624 + Math.round(rand() * 10);
    return `<text x="${x}" y="${y}" font-size="${style === "obvious" ? 24 : 22}" text-anchor="end">${text}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><radialGradient id="paper" cx=".53" cy=".46" r=".74"><stop stop-color="${paper}"/><stop offset="1" stop-color="${edge}"/></radialGradient>
    <linearGradient id="gutter"><stop stop-color="#392710" stop-opacity=".57"/><stop offset="1" stop-color="#634226" stop-opacity="0"/></linearGradient></defs>
    <rect width="720" height="920" fill="url(#paper)"/>
    <rect width="${style === "aged" ? 57 : 28}" height="920" fill="url(#gutter)"/>
    ${grains}
    <g fill="${ink}" font-family="'Times New Roman', Arial, serif">
      <text x="360" y="75" font-size="19" text-anchor="middle">ספרי מקרא</text>
      <path d="M110 91 H610" stroke="${ink}" stroke-opacity=".55"/>
      <text x="360" y="132" font-size="36" text-anchor="middle">קהלת</text>
      ${paragraph}
      <text x="360" y="875" font-size="15" text-anchor="middle">${seed}</text>
    </g></svg>`;
  const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  const crop = await sharp(jpeg).extract({ left: 100, top: 215, width: 560, height: 36 }).jpeg({ quality: 88 }).toBuffer();
  return { image: await save(id, jpeg), line: await save(`${id}-line`, crop) };
}

async function main() {
  await mkdir(join(folder, "images"), { recursive: true });
  const sources = [];
  for (let i = 1; i <= 14; i++) sources.push({ id: `demo-reference-${i}`, ...await page(`demo-ref-${i}`, 10 + i, "aged") });
  const items: RealismItem[] = [];
  for (let i = 0; i < 50; i++) {
    const control_kind = i < 5 ? "real_real" : i < 8 ? "attention" : "standard";
    const ref = sources[i % sources.length]!;
    const second = sources[(i + 5) % sources.length]!;
    const synthetic = control_kind === "real_real" ? second : await page(`demo-generated-${i}`, 40 + i, control_kind === "attention" ? "obvious" : "clean");
    items.push({
      item_id: `demo-${i + 1}`, synthetic_image: synthetic.image, synthetic_line_crop: synthetic.line,
      real_ref_image: ref.image, real_ref_line_crop: ref.line, real_ref_id: ref.id,
      ...(control_kind === "real_real" ? { synthetic_ref_id: second.id } : {}),
      generator_id: "fixture", generator_version: "v1", params_hash: sha(`fixture:${i}`), control_kind,
    });
  }
  const manifest = { schema: MANIFEST_SCHEMA, batch_id: "demo-realism", fixture: true, items };
  const clearance = { schema: CLEARANCE_SCHEMA, fixture: true, references: sources.map(({ id, image, line }) => ({
    id, split: "dev", source: "generated UI fixture, not a reference scan", license: "CC0",
    page_sha256: image.sha256, line_sha256: line.sha256,
  })) };
  const content = JSON.stringify(clearance);
  await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest), { flag: "wx" });
  await writeFile(join(folder, "fixture-clearance.json"), content, { flag: "wx" });
  console.log(sha(content));
}
await main();
