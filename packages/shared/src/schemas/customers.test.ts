import { describe, expect, it } from "vitest";
import { customerInputSchema, customerSearchSchema, customerUpdateSchema } from "./customers";

const valid = { name: "Ana López", email: "Ana@Example.com", phone: "+506 8888-1234", preferredLocale: "en" };

function fieldError(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }, field: string) {
  return result.error?.issues.find((issue) => issue.path[0] === field)?.message;
}

describe("customerInputSchema", () => {
  it("accepts a full customer, trims and lowercases the email", () => {
    const parsed = customerInputSchema.parse({ ...valid, name: "  Ana López ", email: " Ana@Example.com " });
    expect(parsed).toEqual({ name: "Ana López", email: "ana@example.com", phone: "+506 8888-1234", preferredLocale: "en" });
  });

  it("accepts a customer with only a name (R26) and turns blank fields into null", () => {
    expect(customerInputSchema.parse({ name: "Ana", email: "", phone: "   ", preferredLocale: "" })).toEqual({
      name: "Ana",
      email: null,
      phone: null,
      preferredLocale: null,
    });
    expect(customerInputSchema.parse({ name: "Ana" })).toEqual({ name: "Ana", email: null, phone: null, preferredLocale: null });
  });

  it("requires a name", () => {
    expect(fieldError(customerInputSchema.safeParse({ ...valid, name: "   " }), "name")).toBe("validation.nameRequired");
    expect(fieldError(customerInputSchema.safeParse({ ...valid, name: undefined }), "name")).toBe("validation.nameRequired");
    expect(fieldError(customerInputSchema.safeParse({ ...valid, name: "x".repeat(201) }), "name")).toBe("validation.nameTooLong");
  });

  it("rejects a malformed email", () => {
    for (const email of ["ana", "ana@", "@x.com", "ana x@x.com"]) {
      expect(fieldError(customerInputSchema.safeParse({ ...valid, email }), "email"), email).toBe("validation.emailInvalid");
    }
  });

  it("rejects phones with letters, too short or too long, or without digits", () => {
    for (const phone of ["abc1234", "12", "1".repeat(41), "+() -."]) {
      expect(fieldError(customerInputSchema.safeParse({ ...valid, phone }), "phone"), phone).toBe("validation.phoneInvalid");
    }
    expect(customerInputSchema.parse({ ...valid, phone: "(506) 2222.3333" }).phone).toBe("(506) 2222.3333");
  });

  it("only accepts the supported locales", () => {
    expect(fieldError(customerInputSchema.safeParse({ ...valid, preferredLocale: "fr" }), "preferredLocale")).toBe(
      "validation.localeInvalid",
    );
  });

  it("never carries operator_id or other server-owned fields", () => {
    const parsed = customerInputSchema.parse({ ...valid, operator_id: "0b000000-0000-4000-8000-00000000000b", id: "x" });
    expect(Object.keys(parsed).sort()).toEqual(["email", "name", "phone", "preferredLocale"]);
  });
});

describe("customerUpdateSchema", () => {
  it("validates the id as a uuid", () => {
    expect(fieldError(customerUpdateSchema.safeParse({ ...valid, id: "1 or 1=1" }), "id")).toBe("validation.customerInvalid");
    expect(customerUpdateSchema.parse({ ...valid, id: "0a000000-0000-4000-8000-00000000000a" }).id).toBe(
      "0a000000-0000-4000-8000-00000000000a",
    );
  });
});

describe("customerSearchSchema", () => {
  it("trims, collapses whitespace and cuts long input", () => {
    expect(customerSearchSchema.parse({ q: "  ana   lópez " }).q).toBe("ana lópez");
    expect(customerSearchSchema.parse({}).q).toBe("");
    expect(customerSearchSchema.parse({ q: "a".repeat(150) }).q).toHaveLength(100);
  });
});
