import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertNoDevAuth } from "../../scripts/deploy";
import { assertOpenSource } from "../../scripts/lib/guard";
import { buildImportSql } from "../../scripts/lib/importsql";
import { cropRect } from "../../scripts/lib/media";
import { inline, lit } from "../../scripts/lib/sql";
import { referenceAuditImporter } from "../../src/tasks/reference_audit/importer";

describe("wrangler.jsonc", () => {
  it("never enables the dev sign-in", () => {
    const text = readFileSync("wrangler.jsonc", "utf8");
    expect(() => assertNoDevAuth(text)).not.toThrow();
    expect(() => assertNoDevAuth(text.replace('"ENVIRONMENT": "preview"', '"ENVIRONMENT": "development"'))).toThrow();
    expect(() => assertNoDevAuth(text.replace('"vars": {', '"vars": { "DEV_AUTH_BYPASS": "1",'))).toThrow();
  });
});

describe("import", () => {
  it("escapes SQL literals", () => {
    expect(lit("it's")).toBe("'it''s'");
    expect(lit(null)).toBe("NULL");
    expect(inline("SELECT ?1, ?2", "a'b", 3)).toBe("SELECT 'a''b', 3");
  });

  it("orders proposals easiest first and writes upserts that never touch decisions", () => {
    const raw: unknown = JSON.parse(readFileSync("test/fixtures/proposals.fixture.json", "utf8"));
    const bundle = referenceAuditImporter.bundle(raw);
    expect(bundle.proposals.map((p) => `${p.confidence}:${p.category}`)).toEqual([
      "high:spacing",
      "high:letter_confusion",
      "medium:letter_confusion",
      "low:missing_text",
    ]);
    expect(bundle.items).toHaveLength(2); // the no-findings page has nothing to review
    const sql = buildImportSql(bundle, new Map(), { minReviewers: 1, importedAt: "2026-11-07T00:00:00Z" });
    expect(sql).not.toMatch(/(INTO|UPDATE|FROM) decisions/i);
    expect(sql).toContain("UPDATE proposals SET active = 0");
  });

  it("cuts a crop around the region that contains it", () => {
    const r = cropRect([0.5, 0.5, 0.52, 0.51], 1920, 2700);
    expect(r.left).toBeLessThanOrEqual(0.5 * 1920);
    expect(r.left + r.width).toBeGreaterThanOrEqual(0.52 * 1920);
    expect(r.width).toBeGreaterThanOrEqual(0.32 * 1920 - 1);
    const edge = cropRect([0.95, 0.97, 1, 1], 1920, 2700);
    expect(edge.left + edge.width).toBeLessThanOrEqual(1920);
    expect(edge.top + edge.height).toBeLessThanOrEqual(2700);
  });

  it("refuses restricted sources", () => {
    expect(() => assertOpenSource("test/fixtures")).not.toThrow();
  });
});

describe("hocrgen crop bundle", () => {
  it("checks checksums and maps the region into crop coordinates", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { bundleCropBox, bundleProblems, sha256File } = await import("../../scripts/lib/media");
    const dir = mkdtempSync(join(tmpdir(), "bundle-"));
    mkdirSync(join(dir, "crops"));
    writeFileSync(join(dir, "proposals.json"), "{}");
    writeFileSync(join(dir, "crops", "p1.jpg"), "jpeg");
    const crop = {
      proposal_id: "p1",
      item_id: "x:y",
      path: "crops/p1.jpg",
      sha256: sha256File(join(dir, "crops", "p1.jpg")),
      width: 200,
      height: 100,
      source_image_size: [1000, 2000] as [number, number],
      crop_box_px: [100, 200, 300, 300] as [number, number, number, number],
      region_box_normalized: [0.15, 0.11, 0.25, 0.14] as [number, number, number, number],
    };
    const bundle = { schema_version: "reference_audit_crops.v1" as const, audit_id: "a", proposals_file: "proposals.json", proposals_sha256: sha256File(join(dir, "proposals.json")), crops: [crop] };
    expect(bundleProblems(dir, bundle, "a")).toEqual([]);
    expect(bundleCropBox(crop)).toEqual([0.25, 0.2, 0.75, 0.8]);
    writeFileSync(join(dir, "crops", "p1.jpg"), "changed");
    expect(bundleProblems(dir, bundle, "a").join()).toContain("checksum");
    expect(bundleProblems(dir, { ...bundle, audit_id: "b" }, "a").join()).toContain("audit_id");
  });
});
