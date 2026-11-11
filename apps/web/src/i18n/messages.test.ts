import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import { routing } from "./routing";

type Messages = Record<string, unknown>;

/** Flattens a nested message object into dotted key paths ("common.actions.save"). */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value as Messages).flatMap(([key, child]) =>
    keyPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("i18n message parity (KTD12)", () => {
  it("es.json and en.json expose identical nested key sets", () => {
    const esKeys = keyPaths(es).sort();
    const enKeys = keyPaths(en).sort();

    const missingInEn = esKeys.filter((k) => !enKeys.includes(k));
    const missingInEs = enKeys.filter((k) => !esKeys.includes(k));

    expect({ missingInEn, missingInEs }).toEqual({ missingInEn: [], missingInEs: [] });
    expect(enKeys).toEqual(esKeys);
  });

  it("every message value is a non-empty string", () => {
    for (const messages of [es, en]) {
      const leaves = keyPaths(messages);
      for (const path of leaves) {
        const value = path.split(".").reduce<unknown>(
          (node, key) => (node as Messages)[key],
          messages,
        );
        expect(typeof value, `${path} should be a string`).toBe("string");
        expect((value as string).trim(), `${path} should not be empty`).not.toBe("");
      }
    }
  });

  it("every routing locale has a messages file", () => {
    for (const locale of routing.locales) {
      const file = fileURLToPath(new URL(`../../messages/${locale}.json`, import.meta.url));
      expect(existsSync(file), `messages/${locale}.json should exist`).toBe(true);
    }
  });
});
