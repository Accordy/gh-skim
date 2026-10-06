import { describe, expect, test } from "bun:test";
import {
  identitiesFor,
  ownedByOthers,
  parseCodeowners,
  parseCodeownersDirective,
} from "./codeowners.ts";

const CODEOWNERS = `
# Default owners
*                 @Acme/platform
/apps/ios/        @amy @acme/mobile   # inline comment
*.md              @docs-team@example.com
/docs/generated/
!/apps/ios/README.md @nobody
`;

describe("parseCodeowners", () => {
  const c = parseCodeowners(CODEOWNERS);

  test("the last matching line decides, as on GitHub", () => {
    expect(c.ownersOf("server/main.go")).toEqual(["@acme/platform"]);
    expect(c.ownersOf("apps/ios/App.swift")).toEqual(["@amy", "@acme/mobile"]);
    expect(c.ownersOf("apps/ios/README.md")).toEqual(["@docs-team@example.com"]);
  });

  test("a line with no owners leaves its files unowned on purpose", () => {
    expect(c.ownersOf("docs/generated/api.html")).toEqual([]);
  });

  test("returns null when no line matches", () => {
    expect(parseCodeowners("/apps/ @amy").ownersOf("server/main.go")).toBeNull();
  });

  test("names the organizations whose teams own something", () => {
    expect(c.teamOrgs).toEqual(["acme"]);
  });
});

describe("ownedByOthers", () => {
  const c = parseCodeowners("/apps/ios/ @amy\n/apps/web/ @acme/web\n/docs/\n");
  const paths = ["apps/ios/A.swift", "apps/web/a.ts", "docs/x.md", "README.md"];

  test("hides what others own, keeps what is mine and what nobody owns", () => {
    expect(ownedByOthers(c, paths, identitiesFor("Amy"))).toEqual(["apps/web/a.ts"]);
  });

  test("counts ownership through a team", () => {
    const bob = identitiesFor("bob", [{ org: "Acme", slug: "web" }]);
    expect(ownedByOthers(c, paths, bob)).toEqual(["apps/ios/A.swift"]);
  });

  test("hides nothing from a reviewer who owns none of the files", () => {
    expect(ownedByOthers(c, paths, identitiesFor("carol"))).toBeNull();
  });
});

test("the directive is off unless a line says `# codeowners: on`", () => {
  expect(parseCodeownersDirective(null)).toBe(false);
  expect(parseCodeownersDirective("# preset: node\n*.lock\n")).toBe(false);
  expect(parseCodeownersDirective("# preset: node\n# Codeowners: on\n*.lock\n")).toBe(true);
  expect(parseCodeownersDirective("# codeowners: off\n")).toBe(false);
});
