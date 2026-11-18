import { describe, expect, it } from "vitest";
import { isOpenLicence } from "../../src/shared/licence";

describe("open licences", () => {
  it.each(["CC BY-SA 4.0", "CC BY 4.0", "CC0 1.0", "CC0", "public domain", "Public Domain", "Public domain (US)", "CC BY-SA 3.0 (Hebrew Wikisource)"])(
    "accepts %s",
    (text) => expect(isOpenLicence(text)).toBe(true),
  );

  it.each(["CC BY-NC 4.0", "CC BY-NC-SA 4.0", "CC BY-ND 4.0", "CC BY-NC-ND 3.0", "CC BY (non-commercial use only)", "all rights reserved", "", null, 3])(
    "refuses %s",
    (text) => expect(isOpenLicence(text)).toBe(false),
  );
});
