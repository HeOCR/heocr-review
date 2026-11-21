# Private realism ranking

Ranking is a generator development task. Each screen shows two pages and records the physical left or right choice and time from the first frame after both images decode. It keeps the same order across refreshes and retries. The next pair is preloaded after the current pair starts loading. A reviewer can undo the last answer, including after the final pair. Ranking uses its own tables and leaves existing two-alternative synthetic/real sessions unchanged.

## Bundle

Provide `manifest.json`, its SHA-256, image files under `images/`, and the existing `synth_realism_clearance.v1` file with its SHA-256. Use this manifest structure with unique stable tokens for each batch, item, arm and pair.

```json
{
  "schema": "realism_ranking_manifest.v1",
  "batch_id": "fixture-ranking",
  "title": "Fixture ranking",
  "images": [
    {"item_id": "a1", "arm_id": "arm-a", "path": "images/a.jpg", "sha256": "<sha256>"},
    {"item_id": "b1", "arm_id": "arm-b", "path": "images/b.jpg", "sha256": "<sha256>"},
    {"item_id": "c1", "arm_id": null, "real_ref_id": "cleared-train-page", "path": "images/c.jpg", "sha256": "<sha256>"}
  ],
  "pairs": [
    {"pair_id": "pair-1", "item_a": "a1", "item_b": "b1"},
    {"pair_id": "pair-2", "item_a": "b1", "item_b": "c1"}
  ]
}
```

Use unique page bytes and distinct unordered pairs. Include cross-arm synthetic comparisons for every arm. Match image modalities within each comparison. Separate scan and phone comparison components may share a session. Genuine controls must match exact cleared TRAIN page bytes. A real/synthetic control is scored by whether the reviewer chooses real. A real/real control has no right answer. The importer interleaves trials by a deterministic hash order, normalizes both sides identically and strips source metadata. The client receives only position, revision and same-origin image URLs. The batch displays a neutral title.

## Local and production

1. Run `npx tsx scripts/import-realism-ranking.ts --bundle <directory> --manifest-sha256 <pin> --clearance <path> --clearance-sha256 <pin> --target local`. For fixtures, add `--fixture` and set `fixture: true` in both JSON inputs.
2. The importer checks media and stages the batch closed. For a local rehearsal, open the matching batch in local D1 and set `REALISM_RANKING_ENABLED=1` in `.dev.vars`. The account must be both an admin and the configured `RESTRICTED_REFERENCE_REVIEWER_ID`. Production requires the canonical host. Unset or zero leaves ranking off.
3. With lead authorization, take the private production export and recount, then deploy from clean main using the standard runbook. Apply migration 0020. Run the importer with `--dry-run --target production --yes-production` to confirm the pair counts and budget estimate. Remove `--dry-run` only for the authorized production import. Each new answer or undo updates one D1 row. Preloading and reloading are read-only.
4. Verify the closed batch's manifest digest, pair/asset counts and zero answers. Enable the ranking flag and open only the row matching the exact manifest pin and expected count. Verify the batch link and initial pair plus prefetch as the allowlisted reviewer using GET requests only. Verify anonymous, unapproved admin and alternate-host denial. Recount against the private export and retain the rollback version.

## Private export and fit

The allowlisted admin export returns `realism_ranking_cc0.json` with pairs, physical side, displayed item and arm IDs, decision time and reviewer pseudonym. CC0 applies to reviewer contributions. Keep the export private. The local CLI export also writes this file in mode 0600. Production uses the authenticated admin export.

Run `npx tsx scripts/fit-realism-ranking.ts --input <private-export> --out <private-report>`. The report fits [Bradley–Terry log-strengths](https://doi.org/10.1214/aos/1079120141) using a centered Gaussian prior with standard deviation 2. Approximate 95% Laplace intervals are conditional on this roster and treat comparisons as independent. Repeated images or decisions by a single reviewer can limit generalization. Disconnected components have separate scales and cannot be ranked together. Real controls stay out of the fit. The report shows real/synthetic accuracy with a Wilson interval and real/real side choice counts separately.
