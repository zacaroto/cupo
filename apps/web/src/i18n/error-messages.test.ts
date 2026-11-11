import { describe, expect, it } from "vitest";
import { ACTION_ERRORS } from "@cupo/shared/errors";
import { ROLES } from "@cupo/shared/permissions";
import es from "../../messages/es.json";

// Every state the result mapper can produce, and every role, has copy
// (message parity with en.json is checked by messages.test.ts).
describe("error and role messages", () => {
  it("has errors.<code> for every action error code", () => {
    const missing = ACTION_ERRORS.filter((code) => !(code in es.errors));
    expect(missing).toEqual([]);
  });

  it("has a label for every role", () => {
    const missing = ROLES.filter((role) => !(role in es.common.roles));
    expect(missing).toEqual([]);
  });
});
