import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure } from "../../src/web/api";
import { failureHandler } from "../../src/web/views/common";

/** Just enough of a DOM for h() and mount(): elements with a class, attributes, children and text. */
class FakeNode {
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  className = "";
  style = { cssText: "" };
  constructor(
    readonly tag: string,
    private ownText = "",
  ) {}
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(): void {}
  append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: FakeNode[]): void {
    this.ownText = "";
    this.children = nodes;
  }
  querySelector(sel: string): FakeNode | null {
    const cls = sel.replace(/^\./, "");
    for (const c of this.children) {
      if (c.className.split(" ").includes(cls)) return c;
      const hit = c.querySelector(sel);
      if (hit) return hit;
    }
    return null;
  }
}

function loadingRoot(): FakeNode {
  const root = new FakeNode("section");
  const p = new FakeNode("p", "טוען… / Loading…");
  p.className = "muted";
  root.append(p);
  return root;
}

const hooks = { needTerms: () => Promise.resolve(), signedOut: vi.fn() };
const asRoot = (n: FakeNode) => n as unknown as HTMLElement;

describe("failureHandler", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { createElement: (tag: string) => new FakeNode(tag), createTextNode: (t: string) => new FakeNode("#text", t) });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    hooks.signedOut.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("replaces the Loading placeholder with the error when the first load fails", () => {
    const root = loadingRoot();
    failureHandler(asRoot(root), hooks)(new ApiFailure(500, "internal"));
    expect(root.textContent).not.toContain("Loading");
    expect(root.children).toHaveLength(1);
    const shown = root.children[0]!;
    expect(shown.className).toBe("msg");
    expect(shown.attrs.role).toBe("alert");
    expect(shown.textContent).toBe("שגיאה. נסו שוב. / Error, please try again.");
  });

  it("shows a non-API error (e.g. a network failure) on first load too", () => {
    const root = loadingRoot();
    failureHandler(asRoot(root), hooks)(new TypeError("Failed to fetch"));
    expect(root.textContent).toBe("שגיאה. נסו שוב. / Error, please try again.");
  });

  it("writes into the existing status line once the screen is rendered", () => {
    const root = new FakeNode("section");
    const scan = new FakeNode("img");
    const msg = new FakeNode("p");
    msg.className = "msg";
    root.append(scan, msg);
    failureHandler(asRoot(root), hooks)(new ApiFailure(429, "rate_limited"));
    expect(root.children).toEqual([scan, msg]);
    expect(msg.textContent).toContain("Too many actions a minute");
  });

  it("signs out on 401 and leaves the page as it is", () => {
    const root = loadingRoot();
    failureHandler(asRoot(root), hooks)(new ApiFailure(401, "unauthenticated"));
    expect(hooks.signedOut).toHaveBeenCalledOnce();
    expect(root.textContent).toBe("טוען… / Loading…");
  });
});
