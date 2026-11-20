# Synthetic realism pilot

This admin-only review gives generator developers a human development signal about the appearance of synthetic pages. The queue uses a local Worker and local D1. A reference must be openly licensed, cleared by eval, and drawn from training or dev. Keep held-out material outside the workflow.

## Bundle contract for synth-gen

Place `manifest.json` and the assets under `images/` in one bundle. One bundle is one session, usually 50 pairs. IDs and versions use 1–100 ASCII letters, digits, periods, underscores, or hyphens. All hashes are lowercase SHA-256 hex of the original file bytes, except `params_hash`, which pins the generator's canonical parameter serialization.

```ts
type Image = { path: string; sha256: string };
type Manifest = {
  schema: "synth_realism_manifest.v1";
  batch_id: string;
  items: {
    item_id: string;
    synthetic_image: Image;
    synthetic_line_crop: Image;
    real_ref_image: Image;
    real_ref_line_crop: Image;
    real_ref_id: string;
    synthetic_ref_id?: string; // required only for real_real
    generator_id: string;
    generator_version: string;
    params_hash: string;
    control_kind: "standard" | "real_real" | "attention";
  }[];
};
```

Use bundle-relative paths such as `images/p001.jpg`. A page and its line crop must correspond. The importer accepts single-frame JPEG, PNG and WebP, up to 20 MiB and 25 megapixels per asset. It verifies the hashes, re-encodes all images consistently, strips metadata, and stores the resulting JPEGs privately in D1. A pair must contain distinct pages and distinct crops, including after normalization. A page pair (in either order) may occur only once per batch.

For a session of length *n* (1–50), supply `round(n × .10)` real/real controls and `round(n × .05)` attention controls. At 50 that is 5 real/real and 3 attention. Assign the first real page and crop of a real/real pair to the two `synthetic_*` fields and identify it with `synthetic_ref_id`. An attention control pairs one deliberately obvious synthetic example with a cleared real scan. Supply the generator fields for all rows so the shape is uniform. The Worker draws without replacement for each reviewer and randomizes side independently for every pair.

Eval supplies a separate clearance file. The lead provides its SHA-256 independently of the bundle. Each reference record pins both the exact scan and the crop, with source and license. Retain the clearance record separately for provenance and attribution.

```ts
type EvalClearance = {
  schema: "synth_realism_clearance.v1";
  references: {
    id: string;
    split: "train" | "dev";
    source: string;
    license: string; // Public Domain, CC0, or CC BY / CC BY-SA 3.0 or 4.0
    page_sha256: string;
    line_sha256: string;
  }[];
};
```

```sh
npm run import -- --task synth_realism --bundle /path/to/bundle \
  --clearance /path/to/eval-clearance.json --clearance-sha256 <lead-pinned-sha> --target local
```

A batch ID is immutable after import so an existing blind trial cannot change under a reviewer. Run with `--dry-run` to validate a bundle without loading it into local D1.

## Review and export

Set `SYNTH_REALISM_ENABLED=1` in local `.dev.vars` and authorize the reviewer pseudonym in `ADMIN_REVIEWER_IDS`. Reviewers see the physical left and right options in both languages. The line zoom is available during the blind step and after reveal. The timer starts once both page images decode and measures milliseconds until the first choice. The server stores the choice before revealing the pair, caps the browser duration at elapsed server time, and resumes an active pair on reload. Score (0–10) is required, and tags and comment are optional.

Export from the Admin screen or use `npm run export -- --batch <batch> --target local --out <new-private-directory>`. `synth_realism_dev.json` includes reviewer pseudonym, chosen side (0 = left, 1 = right), correctness, latency, score, tags, optional comment, generator/version/params, control kind, and timestamps. A choice waiting for feedback has a null completion timestamp and score. The per-generator/version aggregates use standard pairs only. Fooling rate is the fraction of choices for the synthetic side, with a two-sided 95% Wilson interval. Mean score and tags use the submitted feedback, so the denominator for the score is also included. These are development statistics from the reviewed sample.

A real/real control has null correctness. The selection records which real side the reviewer treated as real and which one they rejected. Because one rejection is required on each such trial, it measures side preference and examples the reviewer rejects, with no independent false-positive rate. Attention controls report choices and correct answers separately from generator statistics.

## Local screenshot fixture

Generate a disposable demo. Both sides are generated solely for exercising the UI, and exports from a fixture have no generator aggregates.

```sh
clearance_sha="$(npx tsx scripts/synth-realism-demo.ts)"
npm run import -- --task synth_realism --bundle .import/synth-demo \
  --clearance .import/synth-demo/fixture-clearance.json --clearance-sha256 "$clearance_sha" \
  --target local --fixture
```

The production guard requires a follow-up after the maintainer approves the strings and the reviewer-data notice. The pilot stores the reviewer's pseudonym, chosen side, choice timing, rating, tags and optional comment. Real assets and these records are available only to admins. A production change also needs the lead's deployment go.
