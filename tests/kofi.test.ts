import { describe, expect, it } from "vitest";
import { normalizeKofiUrl } from "../src/utils/kofi";

describe("normalizeKofiUrl", () => {
  it.each([
    "https://ko-fi.com/example_creator",
    "  HTTPS://WWW.KO-FI.COM/example_creator/  ",
    "ko-fi.com/example_creator"
  ])("normalizes %s to the canonical creator page", (input) => {
    expect(normalizeKofiUrl(input)).toBe("https://ko-fi.com/example_creator");
  });

  it.each([
    undefined,
    null,
    123,
    "",
    "example_creator",
    "https://ko-fi.com/",
    "//ko-fi.com/example_creator",
    "http://ko-fi.com/example_creator",
    "https://ko-fi.com.evil.test/example_creator",
    "https://help.ko-fi.com/example_creator",
    "https://evil.test/ko-fi.com/example_creator",
    "https://person@ko-fi.com/example_creator",
    "https://ko-fi.com:8443/example_creator",
    "https://ko-fi.com/example_creator/shop",
    "https://ko-fi.com/other/../example_creator",
    "https://ko-fi.com/example_creator?ref=redirect",
    "https://ko-fi.com/example_creator#about",
    "https://ko-fi.com/example%2Fcreator"
  ])("rejects %s", (input) => {
    expect(normalizeKofiUrl(input)).toBeUndefined();
  });
});
