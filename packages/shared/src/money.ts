// Money in minor units (KTD7, KTD14). The database stores `bigint` minor units
// plus an ISO 4217 code; this module converts at the UI edge only: parsing
// what a person typed into minor units, and formatting minor units with
// `Intl.NumberFormat`. No floating-point arithmetic touches stored amounts.

/** Currencies whose minor unit is not 1/100 (ISO 4217); every other code uses 2. */
const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

/** Largest amount the database accepts (`tour_prices_price_minor_range`); a safe integer in JavaScript. */
export const MAX_PRICE_MINOR = 999_999_999_999;

const CURRENCY_CODE = /^[A-Z]{3}$/;

export function isCurrencyCode(value: string): boolean {
  return CURRENCY_CODE.test(value);
}

/** Digits after the decimal separator for `currency` (2 unless listed). */
export function currencyExponent(currency: string): number {
  return Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, currency) ? CURRENCY_EXPONENTS[currency] : 2;
}

/** `12500, 'USD', 'es-CR'` -> `USD 125,00` (exactly the currency's digits). */
export function formatMinor(minor: number, currency: string, locale: string): string {
  const exponent = currencyExponent(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(minor / 10 ** exponent);
}

/**
 * Parses a typed amount into minor units: `'125.50', 'USD'` -> 12550. Accepts
 * digits with one optional decimal separator (`.` or `,`) and at most the
 * currency's minor digits; no thousands separators, signs or exponents.
 * Returns null for anything else, or above `MAX_PRICE_MINOR`.
 */
export function parseToMinor(input: string, currency: string): number | null {
  const match = /^(\d{1,15})(?:[.,](\d+))?$/.exec(input.trim());
  if (!match) return null;
  const exponent = currencyExponent(currency);
  const fraction = match[2] ?? "";
  if (fraction.length > exponent) return null;
  const minor = Number(match[1]) * 10 ** exponent + Number(fraction.padEnd(exponent, "0") || "0");
  return Number.isSafeInteger(minor) && minor <= MAX_PRICE_MINOR ? minor : null;
}

/** Minor units back to the plain form-input text: `12550, 'USD'` -> `125.50`. */
export function minorToInput(minor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  if (exponent === 0) return String(minor);
  const digits = String(minor).padStart(exponent + 1, "0");
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}
