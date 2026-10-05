import { describe, expect, test } from "bun:test";
import { parseTarget } from "./target.ts";

describe("parseTarget", () => {
  test("full URL", () => {
    expect(parseTarget("https://github.com/octo-org/octo-repo/pull/1")).toEqual({
      owner: "octo-org",
      repo: "octo-repo",
      number: 1,
    });
  });

  test("URL with a trailing tab path", () => {
    expect(parseTarget("https://github.com/o/r/pull/42/files")).toEqual({
      owner: "o",
      repo: "r",
      number: 42,
    });
  });

  test("owner/repo#N shorthand", () => {
    expect(parseTarget("o/r#7")).toEqual({ owner: "o", repo: "r", number: 7 });
  });

  test("bare number with a repo hint", () => {
    expect(parseTarget("7", "o/r")).toEqual({ owner: "o", repo: "r", number: 7 });
    expect(parseTarget("#7", "o/r")).toEqual({ owner: "o", repo: "r", number: 7 });
  });

  test("bare number without a hint explains what to do", () => {
    expect(() => parseTarget("7")).toThrow(/pass -R owner\/repo/);
  });

  test("nonsense is rejected", () => {
    expect(() => parseTarget("not a pr")).toThrow(/could not read/);
  });
});
