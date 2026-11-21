// Values in a recipe: exact numbers and the tokens a step's text holds — no imports, so the compiler
// (the compiler) and rt (the runtime, shipped with every spec) share one reading of them.
// ── captured values: exact numbers ("1,570.35" + "2.10" = "1,572.45") ────────────────────────────
const NUMBER_RE = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/;
export function parseNum(raw) {
  const m = NUMBER_RE.exec(String(raw ?? ''));
  if (!m) return null;
  const plain = m[0].replace(/,/g, '');
  const dot = plain.indexOf('.');
  return { n: BigInt(plain.replace('.', '')), scale: dot < 0 ? 0 : plain.length - dot - 1, grouped: m[0].includes(',') };
}
export function fmtNum({ n, scale, grouped }) {
  const digits = (n < 0n ? -n : n).toString().padStart(scale + 1, '0');
  let int = digits.slice(0, digits.length - scale);
  if (grouped) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0n ? '-' : '') + int + (scale ? '.' + digits.slice(digits.length - scale) : '');
}
function addNum(a, sign, b) {
  const scale = Math.max(a.scale, b.scale);
  const bn = sign === '-' ? -b.n : b.n;
  return { n: a.n * 10n ** BigInt(scale - a.scale) + bn * 10n ** BigInt(scale - b.scale), scale, grouped: a.grouped };
}
export function asNumber(v) {
  const s = String(v).replace(/,/g, '').trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) throw new Error(`${JSON.stringify(v)} is not a number`);
  return Number(s);
}

// $DS_ENV_VAR | {{capture}} (as read) | {{row.col}} | {{a+b-c+1}} (exact arithmetic over the numbers in
// captures and literals) | {{uid}} (unique to the run) | {{today+7}} / {{day.d_mon_y}} (dates, below) — `${fixed_data}` is filled in when the recipe
// compiles. Only a datasource's env vars: any other "$NAME" is literal text.
const NAME = String.raw`[\p{L}\p{N}_]+`;
const TERM = String.raw`(?:\p{N}+(?:\.\p{N}+)?|${NAME})`;
// a date moved and written another way: {{today+16.d_dow_month_y}} (the format after the days, group 5)
// …or with a date pattern after ":" — {{day:EEE d MMM yyyy}} (group 6, datePattern)
export const TOKEN_RE = new RegExp(String.raw`\$(DS_[A-Z0-9_]*)(?![\p{L}\p{N}_])|\{\{\s*(${NAME})(?:\.(${NAME})|((?:\s*[+-]\s*${TERM})+)(?:\.(${NAME}))?)?(?::([^{}]*[^{}\s]))?\s*\}\}`, 'gu');
// the capture names a token reads (the compiler checks each is captured before it is used)
export const tokenNames = (text) => [...String(text).matchAll(TOKEN_RE)].filter((m) => m[2])
  .flatMap((m) => [m[2], ...(m[4] || '').split(/[+-]/).map((t) => t.trim()).filter((t) => t && !/^\p{N}/u.test(t))]);
export const newUid = () => Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 5);

// Built-in dates (2026-10-25): {{today}} / {{today+7}} — the run's date ± days — and {{day}}, a Monday of this run's own
// 60–432 days ahead ({{day+5}} its Saturday): never stale, and not the slot an earlier run left booked (a fixed "2034-01-04" booking was refused
// as "Booking already exists!" on the next run — Joopium task 4c7d8c9b). YYYY-MM-DD, or another way the page writes it:
// {{day.d_mon_y}} "04 Jan 2034", {{day.dmy}} "04/01/2034" (DATE_FORMATS). UTC dates.
// Any other way: a date pattern after ":" in the letters date-fns / Java / .NET use — {{day:d MMM yyyy}} "4 Jan 2034",
// {{day+1:EEE d MMM}} "Tue 5 Jan" (d dd M MM MMM MMMM yy yyyy EEE EEEE; '…' is literal text). English names only.
export const BUILTIN_TOKENS = new Set(['uid', 'today', 'day']);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const p2 = (n) => String(n).padStart(2, '0');
export const DATE_FORMATS = {
  iso: (d) => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
  dmy: (d) => `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`,
  mdy: (d) => `${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}/${d.getUTCFullYear()}`,
  d_mon_y: (d) => `${p2(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
  mon_d_y: (d) => `${MON[d.getUTCMonth()]} ${p2(d.getUTCDate())}, ${d.getUTCFullYear()}`,
  d_month_y: (d) => `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
  // a calendar day's accessible name: airbnb.com's "10, Tuesday, November 2026" / "Tuesday, November 10, 2026"
  d_dow_month_y: (d) => `${d.getUTCDate()}, ${DOW[d.getUTCDay()]}, ${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
  dow_month_d_y: (d) => `${DOW[d.getUTCDay()]}, ${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`,
};
const PATTERN = /'[^']*'|EEEE|EEE|MMMM|MMM|MM|M|yyyy|yy|dd|d/g;
export function datePattern(d, pattern) {
  const day = d.getUTCDate(), mon = d.getUTCMonth(), year = d.getUTCFullYear();
  const parts = { d: day, dd: p2(day), M: mon + 1, MM: p2(mon + 1), MMM: MON[mon], MMMM: MONTH[mon], yy: String(year).slice(-2),
    yyyy: year, EEE: DOW[d.getUTCDay()].slice(0, 3), EEEE: DOW[d.getUTCDay()] };
  return pattern.replace(PATTERN, (t) => t.startsWith("'") ? t.slice(1, -1) : String(parts[t]));
}
function runDate(name, uid, terms, fmt, m, pattern) {
  const now = new Date();
  let days = 0;
  if (name === 'day') {
    let h = 0;
    for (const c of String(uid || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    days = 60 + (h % 365);
    // a Monday (lab v2: a weekday 2026-10-30, a Monday since round 3): a booking form that takes Monday–Friday only
    // refused a {{day}} on a weekend, so agents typed fixed dates instead; on a weekday of its own, {{day+1}} was a
    // Saturday for some runs and a test of the refused weekend had no date to use (recorder v2b: never saved). Now
    // {{day+1}}..{{day+4}} are the same week's other weekdays, {{day+5}} its Saturday, {{day+7}} the next Monday.
    const dow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days)).getUTCDay();
    days += (8 - dow) % 7;
  }
  for (const [, sign, t] of (terms || '').matchAll(/([+-])\s*([^\s+-]+)/g)) {
    if (!/^\d+$/.test(t)) throw new Error(`${m}: {{${name}}} takes whole days only, e.g. {{${name}+7}}`);
    days += (sign === '-' ? -1 : 1) * Number(t);
  }
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
  if (pattern) return datePattern(date, pattern);
  const f = DATE_FORMATS[fmt || 'iso'];
  if (!f) throw new Error(`${m}: no date format "${fmt}" — write the pattern instead: {{${name}:d MMM yyyy}}`);
  return f(date);
}
// {{uid.digits}}: 9 digits of this run's own, for a field that takes only numbers ("07{{uid.digits}}", a unique phone —
// QA task 741cd7b9: "0712345{{uid}}" put letters in a phone, the booking was refused, then a run_code hash made digits)
export function uidDigits(uid) {
  let h = 0n;
  for (const c of String(uid || '')) h = (h * 131n + BigInt(c.charCodeAt(0))) % 1000000000n;
  return String(h).padStart(9, '0');
}
// browser_capture's read of an element, live (src/capture.mjs, upstream's browser_evaluate) and compiled (rt.mjs m.read):
// a form field's value as it is — its innerText is "" (QA task 327ef17c: a textarea captured "", and the test then
// restored a real QA config to empty) — any other element's text, trimmed. By tag name: an iframe's element is no
// instance of the top page's HTMLInputElement.
export const READ_VALUE = "(element) => (/^(INPUT|TEXTAREA)$/.test(element.tagName) ? String(element.value ?? '') "
  + ": (element.innerText ?? element.textContent ?? '').trim())";
// A token outside quotes in code ("const T = {{tasks}};", "toHaveCount({{n+1}})"): the live run writes its text into the
// code as it is (src/tokens.mjs fillCode) — a captured list as JSON is a list, a number a number — and the compiled
// spec reads that same text as the same value (rt.mjs m.lit). Text that is no JS value ("abc", a hex id "5f3a…", a
// date) is refused alike in both, with how to write it: before, the spec made it Number(…) — a captured list became
// NaN ("tasks.filter is not a function", QA task 3d540d3a) while the live run passed.
const JS_NUMBER = /^[+-]?(?:0[xX][\da-fA-F]+|0[oO][0-7]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/;
export function codeValue(text, token) {
  const s = String(text).trim();
  try { return JSON.parse(s); } catch { /* not JSON */ }
  if (JS_NUMBER.test(s)) return Number(s);
  throw new Error(`${token} outside quotes is written into the code as it is, and ${JSON.stringify(String(text).slice(0, 80))} `
    + `is no JavaScript value — quote it ('${token}') to use it as text`);
}
export function fillTokens(text, v, env = process.env) {
  return String(text).replace(TOKEN_RE, (m, envName, name, col, terms, fmt, pattern) => {
    if (pattern && name !== 'today' && name !== 'day') throw new Error(`${m}: a date pattern after ":" is for {{today…}} / {{day…}} only`);
    if (fmt) {
      if (name !== 'today' && name !== 'day') throw new Error(`${m}: a format after the days is for {{today+N.<format>}} / {{day+N.<format>}} only`);
      col = fmt;
    }
    if (envName) {
      const val = env[envName];
      if (val === undefined) throw new Error(`env var ${envName} is not set (a renamed datasource or persona? replace_env_var)`);
      return /^DS_(?!PERSONA_)[A-Z0-9_]+_(?:URL|ROOT)$/.test(envName) ? val.replace(/\/+$/, '') : val;
    }
    const get = (n) => {
      if (!Object.hasOwn(v, n)) {
        const have = Object.keys(v).filter((k) => k !== 'uid');
        throw new Error(`no captured value named "${n}": capture it in a step before this one — on a page read, "capture": "${n}" `
          + `beside its "assert"; on a db / api_call step, "capture": {"${n}": "rows.0.id"} — captured so far: ${have.join(', ') || 'none'}`);
      }
      return v[n];
    };
    if ((name === 'today' || name === 'day') && !Object.hasOwn(v, name)) return runDate(name, v.uid, terms, col, m, pattern);
    if (name === 'uid' && col === 'digits') return uidDigits(v.uid);
    const val = get(name);
    if (col !== undefined) {
      if (val === null || typeof val !== 'object' || !Object.hasOwn(val, col)) throw new Error(`loop row "${name}" has no column "${col}"`);
      return String(val[col]);
    }
    if (!terms) return typeof val === 'string' ? val : JSON.stringify(val);
    const num = (n, x) => { const p = parseNum(x); if (!p) throw new Error(`${m}: ${n} is ${JSON.stringify(x)}, which has no number`); return p; };
    let acc = num(name, val);
    for (const [, sign, t] of terms.matchAll(/([+-])\s*([^\s+-]+)/g)) acc = addNum(acc, sign, /^\p{N}/u.test(t) ? parseNum(t) : num(t, get(t)));
    return fmtNum(acc);
  });
}
