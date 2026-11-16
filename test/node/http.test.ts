import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, MAX_PAGE_BODY_BYTES, readJson } from "../../src/worker/http";

describe("readJson body cap", () => {
  const req = (bytes: number) =>
    new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: "א".repeat(bytes / 2) }) });
  it("keeps 16 KB by default, and takes a whole page's lines where asked (decisions)", async () => {
    await expect(readJson(req(MAX_BODY_BYTES + 100))).rejects.toMatchObject({ status: 413 });
    await expect(readJson(req(64 * 1024), MAX_PAGE_BODY_BYTES)).resolves.toHaveProperty("t");
    await expect(readJson(req(MAX_PAGE_BODY_BYTES + 100), MAX_PAGE_BODY_BYTES)).rejects.toMatchObject({ status: 413 });
  });
});
