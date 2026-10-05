import { describe, expect, it } from "bun:test";
import { verifyAliasBatch } from "./github.ts";

const paths = (n: number) => Array.from({ length: n }, (_, i) => `Snapshots/case-${i}.txt`);

/**
 * The one failure mode that would make the App lie. A request carrying more
 * than 76 aliased mutations comes back **HTTP 200** and reports the overflow
 * only inside `errors[]`. If the client believes the status code
 * it records marks it never made, and undo can then never take them back.
 */
describe("mark batch verifier", () => {
  it("reports 4 failures when 80 aliases return 76 successes and 4 errors", () => {
    const slice = paths(80);
    const body = {
      data: Object.fromEntries(slice.slice(0, 76).map((_, i) => [`a${i}`, { clientMutationId: null }])),
      errors: [76, 77, 78, 79].map((i) => ({
        type: "RESOURCE_LIMITS_EXCEEDED",
        path: [`a${i}`, "clientMutationId"],
        message: "Resource limits for this query exceeded.",
      })),
    };

    const out = verifyAliasBatch(slice, 200, body);

    expect(out.failed).toHaveLength(4);
    expect(out.succeeded).toHaveLength(76);
    expect(out.failed.map((f) => f.path)).toEqual(slice.slice(76));
    expect(out.succeeded).toEqual(slice.slice(0, 76));
    expect(out.failed[0]!.message).toMatch(/Resource limits/);
  });

  it("counts every path as succeeded when there are no errors", () => {
    const slice = paths(50);
    const out = verifyAliasBatch(slice, 200, { data: {} });
    expect(out.succeeded).toHaveLength(50);
    expect(out.failed).toHaveLength(0);
  });

  it("fails every path when the response carries no data and no per-alias errors", () => {
    const slice = paths(50);
    const out = verifyAliasBatch(slice, 403, { message: "You have exceeded a secondary rate limit" });
    expect(out.succeeded).toHaveLength(0);
    expect(out.failed).toHaveLength(50);
    expect(out.failed[0]!.message).toMatch(/http 403/);
  });

  it("ignores errors that name no alias, so a top-level warning hides nothing", () => {
    const slice = paths(3);
    const out = verifyAliasBatch(slice, 200, {
      data: {},
      errors: [{ message: "something about the query as a whole" }],
    });
    expect(out.succeeded).toHaveLength(3);
    expect(out.failed).toHaveLength(0);
  });

  it("counts an alias only once when GitHub reports it twice", () => {
    const slice = paths(10);
    const out = verifyAliasBatch(slice, 200, {
      data: {},
      errors: [
        { path: ["a3", "clientMutationId"], message: "boom" },
        { path: ["a3"], message: "boom again" },
      ],
    });
    expect(out.failed).toHaveLength(1);
    expect(out.succeeded).toHaveLength(9);
  });
});
