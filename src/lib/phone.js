// Phone-number parsing, validation and formatting. Fully offline: Google libphonenumber metadata as packaged by
// libphonenumber-js ("max" metadata, which carries the per-type number patterns needed for line type), bundled into
// the Worker. No subrequests, no carrier / HLR / live-line lookups: a "valid" number matches a number range that is
// allocated in the metadata; it says nothing about whether the line is connected, reachable, or who holds it.
// Pure functions, no I/O, nothing logged.
import { parsePhoneNumberWithError, ParseError, isSupportedCountry, getExampleNumber, validatePhoneNumberLength } from 'libphonenumber-js/max';
import examples from 'libphonenumber-js/examples.mobile.json';
import { COUNTRIES, METADATA_VERSION } from '../data/countries.js';

export { COUNTRIES, METADATA_VERSION };
export const MAX_NUMBER_LENGTH = 64;

// libphonenumber getType() values -> API values. Unknown / undeterminable -> null.
export const LINE_TYPES = {
  MOBILE: 'mobile',
  FIXED_LINE: 'fixed_line',
  FIXED_LINE_OR_MOBILE: 'fixed_line_or_mobile', // e.g. US/CA: the numbering plan doesn't separate them
  TOLL_FREE: 'toll_free',
  PREMIUM_RATE: 'premium_rate',
  SHARED_COST: 'shared_cost',
  VOIP: 'voip',
  PERSONAL_NUMBER: 'personal_number',
  PAGER: 'pager',
  UAN: 'uan',
  VOICEMAIL: 'voicemail',
};

const REASONS = {
  not_a_number: 'No phone number found in the input.',
  invalid_country: 'The number has no valid country calling code. Use international format (+44 20 7946 0018) or pass defaultCountry.',
  too_short: 'Too short to be a phone number for this country.',
  too_long: 'Too long to be a phone number for this country.',
  invalid_length: 'The length does not match any phone number length for this country.',
  not_valid_number: 'The length is possible, but the digits do not match any number range allocated for this country in the metadata.',
  input_too_long: `Inputs are at most ${MAX_NUMBER_LENGTH} characters.`,
};
export const reasonMessage = (code) => REASONS[code] || code;

/** Normalise a defaultCountry value: returns { ok, country } (country null when absent). */
export function normalizeCountry(value) {
  if (value === undefined || value === null || value === '') return { ok: true, country: null };
  if (typeof value !== 'string') return { ok: false };
  const c = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || !isSupportedCountry(c)) return { ok: false };
  return { ok: true, country: c };
}

/** Example (mobile) number for a region from the libphonenumber example set, or null. */
export function exampleFor(country) {
  const c = typeof country === 'string' ? country.toUpperCase() : '';
  if (!COUNTRIES[c]) return null;
  const p = getExampleNumber(c, examples);
  if (!p) return null;
  return {
    country: c,
    country_name: COUNTRIES[c].name,
    calling_code: p.countryCallingCode,
    line_type: 'mobile',
    e164: p.number,
    international: p.formatInternational(),
    national: p.formatNational(),
    rfc3966: p.getURI(),
  };
}

function failed(input, defaultCountry, code, extra = {}) {
  return {
    input, default_country: defaultCountry, valid: false, possible: false, reason: code, message: reasonMessage(code),
    e164: null, international: null, national: null, rfc3966: null,
    country: null, country_name: null, calling_code: null, national_number: null, extension: null,
    line_type: null, ...extra,
  };
}

/**
 * Parse + validate + format one number. defaultCountry must already be normalised (normalizeCountry) or null.
 * opts.example (default true): include a mobile example number for the resolved (or default) country.
 */
export function parseNumber(input, defaultCountry = null, opts = {}) {
  const withExample = opts.example !== false;
  const str = typeof input === 'string' ? input : '';
  if (str.length > MAX_NUMBER_LENGTH) return failed(str.slice(0, MAX_NUMBER_LENGTH) + '…', defaultCountry, 'input_too_long');
  let p;
  try {
    p = parsePhoneNumberWithError(str, defaultCountry ? { defaultCountry } : undefined);
  } catch (e) {
    const code = e instanceof ParseError ? String(e.message).toLowerCase() : 'not_a_number';
    const out = failed(str, defaultCountry, REASONS[code] ? code : 'not_a_number');
    if (withExample && defaultCountry) out.example = exampleFor(defaultCountry);
    return out;
  }
  const valid = p.isValid();
  // getType() is a separate metadata walk; skip it for invalid numbers (saves CPU on junk bulk inputs).
  const type = valid ? p.getType() : undefined;
  const possible = valid || p.isPossible();
  const country = p.country || null;
  const out = {
    input: str,
    default_country: defaultCountry,
    valid,
    possible,
  };
  if (!valid) {
    let code = 'not_valid_number';
    if (!possible) {
      const len = validatePhoneNumberLength(str, defaultCountry ? { defaultCountry } : undefined);
      code = len ? String(len).toLowerCase() : 'invalid_length';
      if (!REASONS[code]) code = 'invalid_length';
    }
    out.reason = code;
    out.message = reasonMessage(code);
  }
  Object.assign(out, {
    e164: possible ? p.number : null,
    international: possible ? p.formatInternational() : null,
    national: possible ? p.formatNational() : null,
    rfc3966: possible ? p.getURI() : null,
    country,
    country_name: country && COUNTRIES[country] ? COUNTRIES[country].name : null,
    calling_code: p.countryCallingCode,
    national_number: p.nationalNumber,
    extension: p.ext || null,
    line_type: valid ? (LINE_TYPES[type] || null) : null,
  });
  if (!country) {
    const candidates = p.getPossibleCountries();
    if (valid) out.non_geographic = true; // e.g. +800 international freephone, +882/+883 networks
    else if (candidates.length) out.possible_countries = candidates;
  }
  if (withExample) {
    const ex = exampleFor(country || defaultCountry);
    if (ex) out.example = ex;
  }
  return out;
}
