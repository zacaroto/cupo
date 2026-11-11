import { describe, expect, it } from "vitest";
import { currencyExponent, formatMinor, MAX_PRICE_MINOR, minorToInput, parseToMinor } from "./money";

// ICU separates the code and the amount with a no-break space; compare with
// plain spaces so the assertion does not depend on the exact space character.
const plain = (value: string) => value.replace(/\s/g, " ");

describe("formatMinor", () => {
  it("renders USD for es-CR with two decimals", () => {
    expect(plain(formatMinor(12500, "USD", "es-CR"))).toBe("USD 125,00");
  });

  it("renders the minor digits exactly", () => {
    expect(formatMinor(12550, "USD", "en")).toBe("$125.50");
    expect(formatMinor(5, "USD", "en")).toBe("$0.05");
    expect(plain(formatMinor(1500, "JPY", "en"))).toMatch(/^¥1,500$/);
    expect(plain(formatMinor(12345, "KWD", "en"))).toBe("KWD 12.345");
  });
});

describe("currencyExponent", () => {
  it("is 0 for JPY, 3 for KWD and 2 by default", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("CRC")).toBe(2);
  });
});

describe("parseToMinor", () => {
  it("parses a decimal amount into minor units", () => {
    expect(parseToMinor("125.50", "USD")).toBe(12550);
    expect(parseToMinor("125,5", "USD")).toBe(12550);
    expect(parseToMinor(" 125 ", "USD")).toBe(12500);
    expect(parseToMinor("0", "USD")).toBe(0);
    expect(parseToMinor("0.07", "USD")).toBe(7);
  });

  it("uses the currency exponent", () => {
    expect(parseToMinor("1500", "JPY")).toBe(1500);
    expect(parseToMinor("1500.5", "JPY")).toBeNull();
    expect(parseToMinor("12.345", "KWD")).toBe(12345);
  });

  it("rejects more digits than the currency has, signs, separators and garbage", () => {
    for (const input of ["125.505", "-1", "+1", "1,234.50", "1e3", "", ".5", "5.", "abc", "12 50"]) {
      expect(parseToMinor(input, "USD"), input).toBeNull();
    }
  });

  it("rejects amounts above the database bound", () => {
    expect(parseToMinor("9999999999.99", "USD")).toBe(MAX_PRICE_MINOR);
    expect(parseToMinor("10000000000", "USD")).toBeNull();
  });
});

describe("minorToInput", () => {
  it("round-trips with parseToMinor", () => {
    expect(minorToInput(12550, "USD")).toBe("125.50");
    expect(minorToInput(5, "USD")).toBe("0.05");
    expect(minorToInput(1500, "JPY")).toBe("1500");
    expect(minorToInput(12345, "KWD")).toBe("12.345");
    for (const minor of [0, 1, 99, 100, 12550, MAX_PRICE_MINOR]) {
      expect(parseToMinor(minorToInput(minor, "USD"), "USD")).toBe(minor);
    }
  });
});
