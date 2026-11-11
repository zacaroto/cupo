import { describe, expect, it } from "vitest";
import { containsPattern, customerSearchFilter, escapeLikePattern, likeContains } from "./customer-search";

describe("customer search filter", () => {
  it("returns null for an empty term", () => {
    expect(customerSearchFilter("", ["name"])).toBeNull();
    expect(customerSearchFilter("  ", ["name"])).toBeNull();
    expect(customerSearchFilter("**", ["name"])).toBeNull();
  });

  it("matches the term in every column with a quoted contains pattern", () => {
    expect(customerSearchFilter("ana", ["name", "email", "phone"])).toBe(
      'name.ilike."*ana*",email.ilike."*ana*",phone.ilike."*ana*"',
    );
  });

  it("escapes LIKE wildcards so they match literally", () => {
    expect(escapeLikePattern("50%_off\\")).toBe("50\\%\\_off\\\\");
  });

  it("keeps filter syntax inside the quoted value", () => {
    // A comma or parenthesis cannot open a new condition: the value is quoted,
    // and quotes and backslashes inside it are escaped.
    expect(containsPattern('a,b)or(id.eq.1')).toBe('"*a,b)or(id.eq.1*"');
    expect(containsPattern('say "hi"')).toBe('"*say \\"hi\\"*"');
    expect(containsPattern("x\\y")).toBe('"*x\\\\\\\\y*"');
  });

  it("drops the PostgREST wildcard from the term", () => {
    expect(containsPattern("an*a")).toBe('"*ana*"');
    expect(likeContains("an*a_")).toBe("*ana\\_*");
  });
});
