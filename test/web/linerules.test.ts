import { describe, expect, it } from "vitest";
import { ApiFailure } from "../../src/web/api";
import { setLang, tRich } from "../../src/web/i18n";
import {
  canDecidePage,
  clearDraft,
  dropPending,
  exactNeedsPage,
  failureKind,
  keepPending,
  keepable,
  pendingFor,
  readDraft,
  writeDraft,
} from "../../src/web/linerules";

const memory = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};
const blocked = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("a flagged line and its page (maintainer's decision 2026-11-19, SPEC §14.3)", () => {
  it("can't be Exact on a phone until the full page has been opened", () => {
    expect(exactNeedsPage(true, false, false)).toBe(true);
    expect(exactNeedsPage(true, true, false)).toBe(false);
  });

  it("can be Exact on a desktop at once: the page beside the line counts as seen", () => {
    expect(exactNeedsPage(true, false, true)).toBe(false);
  });

  it("never holds back a line that is not flagged", () => {
    for (const opened of [false, true]) for (const desktop of [false, true]) expect(exactNeedsPage(false, opened, desktop)).toBe(false);
  });
});

describe("page review on a phone (SPEC §9, §14.6)", () => {
  it("never decides a page on a phone; a desktop can", () => {
    expect(canDecidePage(false)).toBe(false);
    expect(canDecidePage(true)).toBe(true);
  });
});

describe("why a save failed (SPEC §6)", () => {
  it("tells the cases apart", () => {
    expect(failureKind(new TypeError("Failed to fetch"), false)).toBe("offline");
    expect(failureKind(new TypeError("Failed to fetch"), true)).toBe("server");
    expect(failureKind(new ApiFailure(429, "rate_limited"))).toBe("rate_limited");
    expect(failureKind(new ApiFailure(429, "daily_limit"))).toBe("daily_limit");
    expect(failureKind(new ApiFailure(500, "internal"))).toBe("server");
    expect(failureKind(new ApiFailure(400, "invalid_decision", "x"))).toBe("rejected");
  });

  it("keeps every failure but a refusal: resending a refused decision would not help", () => {
    expect(["offline", "rate_limited", "daily_limit", "server"].every((k) => keepable(k as never))).toBe(true);
    expect(keepable("rejected")).toBe(false);
  });
});

describe("decisions kept on this device (SPEC §6, §14.4)", () => {
  const d = (proposalId: number, value: string, batchId = "b1") => ({ proposalId, batchId, value, keptAt: "2026-11-20T00:00:00.000Z" });

  it("keeps one decision per line, the latest, per batch", () => {
    const s = memory();
    expect(keepPending(d(1, "exact"), s)).toBe(true);
    expect(keepPending({ ...d(1, "edited"), text: "x" }, s)).toBe(true);
    expect(keepPending(d(2, "unreadable"), s)).toBe(true);
    expect(keepPending(d(3, "exact", "b2"), s)).toBe(true);
    expect(pendingFor("b1", s).map((p) => [p.proposalId, p.value, p.text])).toEqual([
      [1, "edited", "x"],
      [2, "unreadable", undefined],
    ]);
    dropPending(1, s);
    expect(pendingFor("b1", s).map((p) => p.proposalId)).toEqual([2]);
    expect(pendingFor("b2", s).map((p) => p.proposalId)).toEqual([3]);
  });

  it("says so when the browser won't keep it, and never throws", () => {
    expect(keepPending(d(1, "exact"), blocked)).toBe(false);
    expect(keepPending(d(1, "exact"), null)).toBe(false);
    expect(pendingFor("b1", blocked)).toEqual([]);
    expect(() => dropPending(1, blocked)).not.toThrow();
  });

  it("ignores junk in storage", () => {
    const s = memory();
    s.setItem("heocr-review.pending.v1", "{not json");
    expect(pendingFor("b1", s)).toEqual([]);
    s.setItem("heocr-review.pending.v1", JSON.stringify([{ proposalId: "1", value: 3 }, d(5, "exact")]));
    expect(pendingFor("b1", s).map((p) => p.proposalId)).toEqual([5]);
  });
});

describe("line-edit drafts (SPEC §4.2)", () => {
  it("survive a reload in session storage, and go on save or cancel", () => {
    const s = memory();
    expect(readDraft(7, s)).toBeNull();
    writeDraft(7, "שורה", s);
    expect(readDraft(7, s)).toBe("שורה");
    clearDraft(7, s);
    expect(readDraft(7, s)).toBeNull();
  });

  it("work without storage", () => {
    expect(() => writeDraft(7, "x", blocked)).not.toThrow();
    expect(readDraft(7, blocked)).toBeNull();
    expect(() => clearDraft(7, blocked)).not.toThrow();
  });
});

describe("strings with a bold lead-in", () => {
  const doc = {
    createTextNode: (text: string) => ({ kind: "text", textContent: text }),
    createElement: (tag: string) => ({ kind: tag, textContent: "" }),
  } as unknown as Document;

  it("make <strong> an element and leave everything else as text", () => {
    setLang("en", { lang: "", dir: "" });
    const nodes = tRich("flag", { reasons: "<b>x</b>" }, doc) as unknown as { kind: string; textContent: string }[];
    expect(nodes[0]).toEqual({ kind: "strong", textContent: "Pre-check:" });
    expect(nodes.slice(1).every((n) => n.kind === "text")).toBe(true);
    // A placeholder's value is never markup: it stays text.
    expect(nodes.map((n) => n.textContent).join("")).toContain("(<b>x</b>)");
    setLang("he", { lang: "", dir: "" });
  });
});
