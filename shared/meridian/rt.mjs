// The runtime every recipe step runs on — the ONE implementation of what a step does. A test case
// compiles (compiler/compile.mjs) to plain Playwright code that calls this module: the compiled spec imports
// it (shipped into the project as shared/meridian/), and a live testcase_run checks db / api_call results
// with the same code (src/data.mjs), so a check reads the same live and compiled.
//
// A `Meridian` holds one run's browsers (one context per persona id), its captures (`v`), its step
// records (steps.json: {ref, id?, ok, error?, wall, ms}) and its phase verdict.
import { test, expect as baseExpect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runApiCall, sanitizeHeaders } from './api.mjs';
import { runDbAction } from './db.mjs';
import { guardContext, guardOptions } from './netguard.mjs';
import { READ_VALUE, asNumber, codeValue, fillTokens, fmtNum, newUid, parseNum } from './tokens.mjs';


export const ACTION_TIMEOUT_MS = 8000;
export const expect = baseExpect.configure({ timeout: ACTION_TIMEOUT_MS });
// a slow app's page can take its time (Playwright MCP allows 60 s too)
const NAV_TIMEOUT_MS = 60000;
// same as util.mjs siteOf (two-label public suffixes, IP hosts) — kept identical, see there
const siteOf = (u) => { try { const h = new URL(u).hostname; if (/^[\d.]+$|:/.test(h)) return h; const l = h.split('.'); const n = l.length > 2 && l.at(-1).length === 2 && /^(co|com|net|org|gov|edu|ac|ne|or|go|gob|mil|ltd|plc|sch|nic|biz|info)$/.test(l.at(-2)) ? 3 : 2; return l.slice(-n).join('.'); } catch { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => String((e && e.message) || e).replace(/\x1b\[[0-9;]*m/g, '');

// ── the app's own requests (a check right after an action must not read the old page) ──────────
const tracked = new WeakMap();  // page -> {pending: Map<request, startedAt>, nav: Set, last}
// the Authorization header a context's pages last sent to each origin (an app that keeps its token
// in memory sends it on every XHR, never as a cookie): api_call's auth "page" sends it too
const pageAuth = new WeakMap();  // context -> Map<origin, header>
export function trackPage(page) {
  if (tracked.has(page)) return tracked.get(page);
  const st = { pending: new Map(), nav: new Set(), last: 0 };
  tracked.set(page, st);
  page.on('request', (rq) => {
    if (['xhr', 'fetch'].includes(rq.resourceType())) {
      rq.allHeaders().then((h) => {
        if (!h.authorization) return;
        const ctx = page.context();
        if (!pageAuth.has(ctx)) pageAuth.set(ctx, new Map());
        pageAuth.get(ctx).set(new URL(rq.url()).origin, h.authorization);
      }).catch(() => {});
    }
  });
  page.on('request', (rq) => {
    try {
      if (rq.isNavigationRequest() && rq.frame() === page.mainFrame()) { st.nav.add(rq); st.navAt = Date.now(); }
      else if (['xhr', 'fetch'].includes(rq.resourceType()) && siteOf(rq.url()) === siteOf(page.url())) st.pending.set(rq, Date.now());
      else return;
      st.last = Date.now();
    } catch {}
  });
  const done = (rq) => { if (st.pending.delete(rq) || st.nav.delete(rq)) st.last = Date.now(); };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  page.on('domcontentloaded', () => {
    st.last = Date.now();
    // the old document's requests end with it, and no event says so: waiting for them cost every
    // sign-in that navigates (Toolshop's /users/me) the whole 5 s
    for (const [rq, t] of st.pending) if (t <= (st.navAt || 0)) st.pending.delete(rq);
  });
  attachDialogs(page);
  return st;
}

// Until the page's document has parsed and its own XHR/fetch have been quiet for 300 ms (at most
// `max` ms; a request older than 5 s is a long poll and doesn't count).
export async function settle(page, max = 1500) {
  if (!page || page.isClosed()) return;
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  const st = tracked.get(page);
  if (!st) return;
  const t0 = Date.now();
  for (;;) {
    const now = Date.now();
    const busy = st.nav.size > 0 || [...st.pending.values()].some((t) => now - t < 5000) || now - st.last < 300;
    if (!busy || now - t0 >= max) return;
    await sleep(50);
  }
}

// the page notes when its DOM last changed (Meridian.quickly)
const WATCH_DOM = () => {
  if (window.__bmMut !== undefined) return;
  window.__bmMut = 0;
  new MutationObserver(() => { window.__bmMut = Date.now(); })
    .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
};
// any of the pages navigating, requesting (not a long poll) or changing its DOM since `since`
async function busySince(pages, since) {
  for (const p of pages) {
    if (p.isClosed()) continue;
    const st = tracked.get(p);
    if (st && (st.nav.size || st.last >= since || [...st.pending.values()].some((t) => Date.now() - t < 5000))) return true;
    // no answer in 300 ms: its main thread is busy (a slow script)
    const mut = await Promise.race([p.evaluate(() => window.__bmMut ?? null).catch(() => null), sleep(300).then(() => 'busy')]);
    if (mut === null || mut === 'busy' || mut >= since) return true;  // null: a new document since the step began
  }
  return false;
}

// A loading indicator on screen ("Loading...", a spinner, aria-busy, a progressbar): the page is still busy although
// it makes no request and changes no DOM (the-internet.herokuapp.com's dynamic loading: a CSS-animated "Loading..." for 5 s)
async function loadingShown(pages) {
  for (const p of pages) {
    if (p.isClosed()) continue;
    const yes = await p.evaluate(() => {
      const shown = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
      const marked = [...document.querySelectorAll('[aria-busy=true], [role=progressbar], [class*=spinner], [class*=loader], [class*=loading], [id*=loading], [id*=spinner]')];
      if (marked.some(shown)) return true;
      const w = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(), k = 0; n && k < 5000; n = w.nextNode(), k += 1) {
        if (/^\s*(loading|please wait|fetching)\b[\s.…]*$/i.test(n.nodeValue) && n.parentElement && shown(n.parentElement)) return true;
      }
      return false;
    }).catch(() => false);
    if (yes) return true;
  }
  return false;
}

// Until the DOM stops changing (250 ms without a mutation, 3 s at most): what a run_code reads with
// (evaluateAll, allTextContents) never waits, and a client-side render makes no request to wait on.
export async function settleDom(page, max = 3000) {
  await Promise.race([
    page.evaluate((max) => new Promise((resolve) => {
      let timer = setTimeout(done, 250);
      const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, 250); });
      function done() { obs.disconnect(); resolve(); }
      obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      setTimeout(done, max);
    }), max).catch(() => {}),
    sleep(max + 500),
  ]);
}

// Where the page ends up once the app is done redirecting: settled, then the address unchanged for
// 300 ms (5 s at most) — goto returns at DOMContentLoaded, before an SPA's router moves on.
export async function settleUrl(page) {
  const t0 = Date.now();
  await settle(page);
  const st = tracked.get(page);
  let last = page.url(), since = Date.now();
  while (Date.now() - t0 < 5000 && !page.isClosed()) {
    await sleep(50);
    if (page.url() !== last || (st && st.nav.size)) { last = page.url(); since = Date.now(); continue; }
    if (Date.now() - since >= 300) break;
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
}

// After an action: whatever it set off — a navigation, the app's own requests — is waited for
// (the requests it started by 50 ms after it, up to 5 s), so the next step sees the page it caused.
async function afterAction(page, act) {
  const st = trackPage(page);
  const before = page.url();
  const t0 = Date.now();
  const out = await act();
  await sleep(50);
  const mine = () => [...st.pending.values()].some((t) => t >= t0 - 50) || st.nav.size > 0;
  const deadline = Date.now() + 5000;
  while (mine() && Date.now() < deadline) await sleep(50);
  if (page.url() !== before) await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  return out;
}

// A new browser's setup ("open" with locale / timezone / geolocation / cookies / localStorage): where it runs no longer
// decides what the site shows (booking.com answered in Hindi to the runner's IP), and a consent cookie or a seeded
// session no longer needs run_code.
export const SETUP_KEYS = ['locale', 'timezone', 'geolocation', 'cookies', 'localStorage'];
export function contextSetup(setup = {}) {
  const o = {};
  if (setup.locale) o.locale = String(setup.locale);
  if (setup.timezone) o.timezoneId = String(setup.timezone);
  if (setup.geolocation) {
    const { latitude, longitude } = setup.geolocation;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') throw new Error('open "geolocation" is {"latitude": 51.5, "longitude": -0.12}');
    o.geolocation = { latitude, longitude }; o.permissions = ['geolocation'];
  }
  if (setup.locale) o.extraHTTPHeaders = { 'Accept-Language': String(setup.locale) };
  return o;
}
export async function seedContext(context, setup = {}, url) {
  const origin = (() => { try { return new URL(url).origin; } catch { return null; } })();
  if (Array.isArray(setup.cookies) && setup.cookies.length) {
    if (setup.cookies.some((c) => !c.domain && !c.url) && !origin) throw new Error('open "cookies" need the url they are for: give "url" on the open, or "domain" on each cookie');
    await context.addCookies(setup.cookies.map((c) => ({ name: String(c.name), value: String(c.value),
      ...(c.domain ? { domain: c.domain, path: c.path || '/' } : { url: c.url || origin }) })));
  }
  if (setup.localStorage && typeof setup.localStorage === 'object') {
    if (!origin) throw new Error('open "localStorage" needs the url it is for: give "url" on the open');
    await context.addInitScript(([o, items]) => {
      if (location.origin !== o) return;
      try { for (const [k, v] of Object.entries(items)) if (localStorage.getItem(k) === null) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch {}
    }, [origin, setup.localStorage]);
  }
}

// ── native dialogs: one handler per page; a `dialog` step arms the answer to the next one ────────
const dialogs = new WeakMap();  // page -> {armed, log: [{type, message}], cursor, runCode, failed: [errors]}
// The test's own dialog handlers (page.once('dialog', async d => { expect(d.message())…; await d.accept(); })): one that
// throws — its check failed — is kept and fails the step it happened in (Meridian.step), instead of the error being
// lost (the dialog then answered by the default, and the step passing on a wrong message) or, thrown by a plain
// function, ending the process. Lab v3: the dialog checks of the saved tests could not fail.
// The step running now (Meridian.step's ref compiled, the call id live): a one-shot dialog handler names where it was set.
let dialogStepRef = null;
export const dialogStep = (ref) => { dialogStepRef = ref == null ? null : String(ref).split('/').pop(); };
export function guardDialogHandlers(page, report) {
  if (page.__dialogGuard) return;
  page.__dialogGuard = true;
  const add = page.on;
  // what dialog came last, for the messages below: a one-shot handler set right after the action that opened its
  // dialog never gets it — that dialog was dismissed unanswered (lab v4-s3 v4a: `click(); page.once('dialog', …)` passed,
  // so its check never ran and a broken validation alert went unnoticed). Not counted as the test's own listener.
  let last = null;
  const observe = (d) => { last = { d, type: d.type(), message: d.message() }; };
  observe.__meridianObserver = true;
  add.call(page, 'dialog', observe);
  const guarded = function (event, fn) {
    if (event !== 'dialog' || typeof fn !== 'function') return add.call(this, event, fn);
    const g = function (...args) {
      let out;
      try { out = Reflect.apply(fn, this, args); } catch (e) { report(e); return undefined; }
      return out && typeof out.then === 'function' ? out.then(undefined, (e) => report(e)) : out;
    };
    g.listener = fn;  // off(fn) / a once wrapper's own removal still find it
    return add.call(this, event, g);
  };
  page.on = guarded;
  page.addListener = guarded;
  // One-shot handlers (page.once('dialog', …)) take one dialog each, in the order the test set them, and a new one is
  // set only once the one before it has had its dialog: a dialog that comes after a server round trip (a form whose
  // error alert follows a fetch) still opens after the click has returned — the next check's handler, already set,
  // got it too and failed on the earlier message (lab v4c: replay 2/3). Its dialog never coming within
  // MERIDIAN_PW_DIALOG_WAIT_MS fails the step that sets the next one, instead of the earlier check never running.
  const once = page.once;
  const claimed = new WeakSet();
  let pending = null;  // {fired: Promise, done} of the last one-shot dialog handler not yet run
  page.once = function (event, fn) {
    if (event !== 'dialog' || typeof fn !== 'function') return once.call(this, event, fn);
    // the dialog that came since the previous one-shot handler and nothing claimed: this handler came after it
    const missed = last && !claimed.has(last.d) && last !== (pending && pending.lastAtSet) ? last : null;
    const set = () => {
      let done;
      const entry = { fired: new Promise((resolve) => { done = resolve; }), ran: false, step: dialogStepRef, missed, lastAtSet: last };
      const hint = (e) => {
        if (!missed) return e;
        const err = new Error(`${String(e?.message ?? e).split('\n').slice(0, 4).join('\n')}\n${missedNote(entry)}`);
        return err;
      };
      const w = function (d) {
        if (claimed.has(d)) return undefined;  // an earlier one-shot handler has this dialog
        claimed.add(d);
        entry.ran = true;
        done();
        this.off('dialog', w);
        let out;
        try { out = fn.call(this, d); } catch (e) { throw hint(e); }
        return out && typeof out.then === 'function' ? out.then(undefined, (e) => { throw hint(e); }) : out;
      };
      pending = entry;
      return guarded.call(this, 'dialog', w);
    };
    const before = pending;
    if (!before || before.ran) return set();
    const ms = Number(process.env.MERIDIAN_PW_DIALOG_WAIT_MS || 10000);
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
    const after = Promise.race([before.fired, late]).then(() => {
      clearTimeout(timer);
      if (!before.ran) {
        throw new Error(`the dialog the test's previous page.once('dialog', …) handler checks never opened (waited ${ms} ms `
          + 'after its action) — the action before it did not open a native dialog; or, if the dialog is not certain to '
          + 'appear, handle it with page.on, not a check');
      }
      set();
      return this;
    });
    after.catch(() => {});  // awaited, the step fails; an unawaited one must not end the process
    return after;
  };
  page.__dialogPending = () => (pending && !pending.ran ? pending : null);
}
const missedNote = (entry) => `This handler was set${entry.step ? ` at ${entry.step}` : ''} after the ${entry.missed.type} "${
  entry.missed.message.slice(0, 120)}" had already opened and been dismissed unanswered — a dialog handler goes right before `
  + 'the action that opens its dialog, never after it.';
// The one-shot dialog handlers whose dialog never came (each page's last; the ones before it are checked when the next
// is set): a check that never ran. Waits up to MERIDIAN_PW_DIALOG_WAIT_MS for one still due. -> [{page, step, message}]
export async function unfiredDialogChecks(pages) {
  const ms = Number(process.env.MERIDIAN_PW_DIALOG_WAIT_MS || 10000);
  const due = pages.map((page) => ({ page, entry: page && !page.isClosed() && page.__dialogPending?.() })).filter((x) => x.entry);
  if (!due.length) return [];
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  await Promise.race([Promise.all(due.map((x) => x.entry.fired)), late]);
  clearTimeout(timer);
  return due.filter((x) => !x.entry.ran).map(({ page, entry }) => ({ page, step: entry.step,
    message: `the dialog the page.once('dialog', …) handler${entry.step ? ` set at ${entry.step}` : ''} checks never opened `
      + `(waited ${ms} ms) — its check never ran. ${entry.missed ? missedNote(entry)
        : 'The action after it did not open a native dialog; if the dialog is not certain to appear, handle it with page.on, not a check.'}` }));
}
export const dialogFailure = (e) => new Error(`the test's own dialog handler failed: ${String(e?.message ?? e).split('\n').slice(0, 6).join('\n')}`);

// ── the test's own route handlers (page.route / context.route: a mock) ─────────────────────────────
// One that throws was handled differently by the two runners: compiled, Playwright Test ended the whole test at once and
// reported the step that happened to be waiting ("Lookup complete" not visible … Test ended.); live, upstream's context
// swallowed it as an unhandled rejection and the step passed — QA task 8041b789 (2026-11-16): MF-025's mock waited on the
// page inside its handler, live passed 6 times, every save failed, the test was lost as an "engine mismatch". Here, in
// both: the error is reported (it fails the step it happened in, or the one waiting on it) and the request is aborted —
// never fallen back, so a mock that failed can't let the call through to the real server (a paid Assistant LLM).
export const routeFailure = (e) => new Error(`the test's own route handler (page.route mock) failed: ${
  String(e?.message ?? e).replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(0, 6).join('\n')}\n`
  + 'A mock answers its request (route.fulfill / abort) without waiting on the page — record what you need to know '
  + '(a flag set with page.evaluate) and check it in a later step.');
export const isRouteFailure = (e) => /^the test's own route handler/.test(String(e?.message ?? ''));
// unrouteAll({ behavior: 'ignoreErrors' }) is the test saying "a handler still in flight may fail now: don't care" —
// upstream honours it only for an error that leaves the handler, and ours never does (caught above), so it is kept
// here: the handlers registered before that call stop reporting. QA run 753eb48e (2026-11-19): MF-108's /me mock was
// mid route.fetch() when the next step unrouted with ignoreErrors and reloaded — "Route is already handled!" failed
// that step 1 run in 3.
export function guardRouteHandlers(target, report) {
  if (!target || target.__routeGuard || typeof target.route !== 'function') return;
  target.__routeGuard = true;
  const route = target.route, unroute = target.unroute, unrouteAll = target.unrouteAll;
  const wrapped = new WeakMap();  // the test's handler -> ours, so unroute(url, handler) still finds it
  let registered = new Set();     // this target's handler states since the last unrouteAll
  target.route = function (url, handler, options) {
    if (typeof handler !== 'function') return route.call(this, url, handler, options);
    const state = { ignoreErrors: false };
    registered.add(state);
    const g = async function (r, req) {
      try {
        return await handler.call(this, r, req);
      } catch (e) {
        if (!state.ignoreErrors) report(e);
        await r.abort('failed').catch(() => {});  // answered already, or the page is gone: fine
        return undefined;
      }
    };
    wrapped.set(handler, g);
    return route.call(this, url, g, options);
  };
  if (typeof unroute === 'function')
    target.unroute = function (url, handler) { return unroute.call(this, url, (handler && wrapped.get(handler)) || handler); };
  if (typeof unrouteAll === 'function')
    target.unrouteAll = function (options) {
      if (options?.behavior === 'ignoreErrors') for (const state of registered) state.ignoreErrors = true;
      registered = new Set();
      return unrouteAll.call(this, options);
    };
}
function attachDialogs(page) {
  if (dialogs.has(page)) return dialogs.get(page);
  const st = { armed: null, log: [], cursor: 0, runCode: 0, failed: [] };
  dialogs.set(page, st);
  page.on('dialog', (d) => {
    const armed = st.armed;
    st.armed = null;
    st.log.push({ type: d.type(), message: d.message(), ts: Date.now() });
    if (st.log.length > 50) { st.log.shift(); st.cursor = Math.max(0, st.cursor - 1); }
    // unarmed: dismissed (a beforeunload accepted); a run_code waiting for it answers it first, and so does the test's
    // own handler — a meridian-playwright spec's page.once('dialog', d => d.accept()) set in an earlier step (lab v3 smoke
    // 2026-10-31: answered here first, the Bistro's cancel confirm was dismissed, "already handled!" — live passed,
    // compiled failed 6 times and the test was never saved)
    const accept = armed ? armed.mode !== 'dismiss' : d.type() === 'beforeunload';
    const theirs = !armed && page.listeners('dialog').filter((l) => !l.__meridianObserver).length > 1;
    st.log[st.log.length - 1].answer = theirs ? 'answered by the test' : `${accept ? 'accepted' : 'dismissed'}${armed ? '' : ' (no dialog step armed it)'}`;
    // accept(null) throws ("promptText: expected string"): the caught error left a beforeunload
    // open, so the navigation hung for its whole timeout and the page with it
    const go = () => (accept ? d.accept(armed?.promptText ?? undefined) : d.dismiss()).catch(() => {});
    if (!armed && (st.runCode > 0 || theirs)) setTimeout(go, 2000); else go();
  });
  guardDialogHandlers(page, (e) => st.failed.push(e));
  guardRouteHandlers(page, (e) => st.failed.push(routeFailure(e)));
  return st;
}
export const dialogLog = (page) => (dialogs.get(page) || { log: [] }).log;

// ── result_checks on a db / api_call / run_code result ───────────────────────────────────────────
// A path: dot-separated keys and list indexes (response_body.data.0.id), `length` (a list's size),
// and `[field=value]` — the first list item whose field is that value, e.g.
// response_body[name=QA-{{uid}}].id: the id of the record this test created.
const PATH_PART_RE = /\[[^\]]*\]|[^.[\]]+/g;
export function getPath(value, path) {
  let cur = value;
  for (const part of String(path).match(PATH_PART_RE) || []) {
    const where = /^\[([^=\]]+)=(.*)\]$/s.exec(part);
    if (where) {
      if (!Array.isArray(cur)) return null;
      cur = cur.find((x) => x !== null && typeof x === 'object' && sameValue(getPath(x, where[1]), where[2]));
    } else if ((Array.isArray(cur) || typeof cur === 'string') && part === 'length') {
      cur = cur.length; // response_body.length: a list's size
      continue;
    } else if (Array.isArray(cur)) {
      if (!/^-?\d+$/.test(part)) return null;
      const i = Number(part) < 0 ? cur.length + Number(part) : Number(part);
      cur = cur[i];
    } else if (cur && typeof cur === 'object') {
      const k = Object.hasOwn(cur, part) ? part : Object.keys(cur).find((x) => x.toLowerCase() === part.toLowerCase());
      cur = k === undefined ? undefined : cur[k];
    } else {
      return null;
    }
    if (cur === undefined) return null;
  }
  return cur;
}
// a capture path with a default: "rows.0.id ?? 0" -> ["rows.0.id", 0] (the default is JSON, else text); no "??" ->
// [path, undefined]
export function splitDefault(path) {
  const m = /^(.*?)\s*\?\?\s*(.*)$/s.exec(path);
  if (!m) return [path, undefined];
  let d;
  try { d = JSON.parse(m[2]); } catch { d = m[2]; }
  return [m[1], d];
}
const jsonText = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
// JSON as Python writes it ('"id": 2, "x": 3'): a stored contains check may use either spelling
const spacedJson = (v) => (Array.isArray(v) ? `[${v.map(spacedJson).join(', ')}]`
  : v !== null && typeof v === 'object' ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${spacedJson(x)}`).join(', ')}}` : JSON.stringify(v));
const containsText = (v, needle) => jsonText(v).includes(needle) || (v !== null && typeof v === 'object' && spacedJson(v).includes(needle));
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b) || (a != null && b != null && typeof a !== 'object'
  && typeof b !== 'object' && typeof a !== 'boolean' && typeof b !== 'boolean' && String(a) === String(b));
// A check's own {{tokens}} (captures, {{uid}}, a loop row's {{row.col}}) filled in: a whole
// "{{name}}" is the captured value as it is (an id stays a number), else the text with them in.
// Never $DS_ values: a check's expected value shows in its failure.
const fillCheck = (x, v) => (typeof x !== 'string' || !x.includes('{{') ? x
  : /^\{\{[\p{L}\p{N}_]+\}\}$/u.test(x) && Object.hasOwn(v, x.slice(2, -2)) ? v[x.slice(2, -2)] : fillTokens(x, v, {}));
function checkFailures(result, rawCheck, v) {
  const fail = [];
  const check = Object.fromEntries(Object.entries(rawCheck).map(([k, x]) => [k,
    Array.isArray(x) ? x.map((y) => fillCheck(y, v)) : k === 'path' ? (x.includes('{{') ? fillTokens(x, v, {}) : x) : fillCheck(x, v)]));
  const want = (op) => check[op];
  for (const needle of check.contains_all || []) if (!containsText(result, needle)) fail.push(`expected the result to contain ${JSON.stringify(needle)}`);
  if (!('path' in check)) return fail;
  const val = getPath(result, check.path);
  const shown = JSON.stringify(val) ?? 'null';
  const at = `${check.path} = ${shown.length > 300 ? `${shown.slice(0, 300)}… (${shown.length} chars)` : shown}`;
  if ('equals' in check && !sameValue(val, want('equals'))) fail.push(`${at}, expected ${JSON.stringify(want('equals'))}`);
  if ('not_equals' in check && sameValue(val, want('not_equals'))) fail.push(`${at}, expected anything else`);
  if ('in' in check && !check.in.some((x) => sameValue(val, x))) fail.push(`${at}, expected one of ${JSON.stringify(check.in)}`);
  if ('exists' in check && (val !== null) !== !!check.exists) fail.push(`${at}, expected it ${check.exists ? 'present' : 'absent'}`);
  if ('contains' in check && (val === null || !containsText(val, String(check.contains)))) fail.push(`${at}, expected it to contain ${JSON.stringify(check.contains)}`);
  if ('matches' in check) {
    const m = /^\(\?([ims]+)\)/.exec(check.matches);
    if (val === null || !new RegExp(m ? check.matches.slice(m[0].length) : check.matches, m ? m[1] : '').test(jsonText(val))) fail.push(`${at}, expected it to match /${check.matches}/`);
  }
  if ('length' in check) {
    const n = Array.isArray(val) || typeof val === 'string' ? val.length : val && typeof val === 'object' ? Object.keys(val).length : null;
    if (n !== check.length) fail.push(`${check.path} has length ${n}, expected ${check.length}`);
  }
  for (const [op, word, ok] of [['gt', 'more than', (a, b) => a > b], ['gte', 'at least', (a, b) => a >= b],
    ['lt', 'less than', (a, b) => a < b], ['lte', 'at most', (a, b) => a <= b]]) {
    if (!(op in check)) continue;
    let good = false;
    try { good = val !== null && typeof val !== 'boolean' && ok(asNumber(val), asNumber(want(op))); } catch {}
    if (!good) fail.push(`${at}, expected ${word} ${JSON.stringify(want(op))}`);
  }
  if ('type' in check) {
    const ok = { string: typeof val === 'string', number: typeof val === 'number', integer: Number.isInteger(val),
      boolean: typeof val === 'boolean', object: !!val && typeof val === 'object' && !Array.isArray(val),
      array: Array.isArray(val), null: val === null }[check.type];
    if (!ok) fail.push(`${at}, expected a ${check.type}`);
  }
  return fail;
}

// An element's text as a reader sees it (no <script>/<style> contents), spaces collapsed.
function elementText(el) {
  const skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  let out = '';
  const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) out += c.nodeValue; else if (c.nodeType === 1 && !skip[c.nodeName]) walk(c); } };
  walk(el);
  return out;
}

// persona secrets (not user names) in this process's env, longest first: blanked in evidence, refused in a URL
const personaSecrets = () => Object.entries(process.env).filter(([k, v]) => k.startsWith('DS_PERSONA_')
  && !/_(USERNAME|USER|EMAIL|LOGIN)$/.test(k) && v && v.length >= 3).map(([, v]) => v).sort((a, b) => b.length - a.length);
// an int64 api.mjs read exactly (a marked string) as its digits: a captured id goes back out whole
const unmarkInts = (v) => (typeof v === 'string' && v.startsWith('\u0000int:') ? v.slice(5)
  : Array.isArray(v) ? v.map(unmarkInts) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unmarkInts(x)])) : v);
// An api_call's request as its evidence row has it: a body's password/token-like fields and a
// header's credential (envVar) or auth value never shown.
// Mirrors shared/secret_names.py SECRET_KEY_PATTERN verbatim (tests/test_secret_names.py checks).
const SECRET_KEY = /pass|pwd|secret|token|api[_-]?key|authorization|(?:^|[^a-z0-9])(?:pin|otp)(?:[^a-z0-9]|$)/i;
const maskBody = (v) => (Array.isArray(v) ? v.map(maskBody) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) && (x === null || typeof x !== 'object') ? '[redacted]' : maskBody(x)])) : v);
function apiRequestRow(spec) {
  const request = { method: String(spec.method || 'GET').toUpperCase(), url: spec.url || spec.path || '' };
  if (spec.as) request.as = spec.as;
  if (spec.body !== undefined && spec.body !== null) request.body = maskBody(spec.body);
  if (spec.headers) request.headers = sanitizeHeaders(Object.fromEntries(Object.entries(spec.headers).map(([k, v]) => [k, v && typeof v === 'object' ? '[redacted]' : v])));
  return { request, ok: true, failures: [] };
}

// thrown after the step testcase_run(until) names: not a failure, the run just ends there
export const STOP = new Error('stopped where asked (until)');
const isStrictViolation = (e) => /strict mode violation/.test(errText(e));
const isPage = (x) => !!x && typeof x.keyboard === 'object' && typeof x.goto === 'function';
const pageOf = (x) => (isPage(x) ? x : x.page());

// ── one run ─────────────────────────────────────────────────────────────────────────────────────
export class Meridian {
  // compiled: {browser, info, slug, steps: {ref: [id, title]}}; live: {sessions} (engine.mjs) —
  // {open(id, {record}) -> {page, context}, close(id), adopt(id, page)}.
  // report: "call" — each step is a step of the report; "phase" — only each phase is (the output profile's steps).
  constructor({ browser = null, info = null, slug = 'test', steps = {}, sessions = null, timeout = ACTION_TIMEOUT_MS,
    record = process.env.MERIDIAN_RECORD !== '0', report = 'call' } = {}) {
    // live, a browser records only when opened with record:true
    Object.assign(this, { browser, info, slug, stepInfo: steps, sessions, timeout, recordAll: !sessions && record, report });
    this.pages = {};
    this.contexts = {};
    this.traced = new Set(); // the contexts whose tracing this run started (and so stops)
    this.v = { uid: newUid() };  // captures and loop rows, by name; uid: unique to the run
    this.records = [];
    this.apiCalls = [];  // one evidence row per api_call: what the run page shows (apiEvidence)
    this.failure = null;
    this.passed = null;
    this.stop = !!sessions;  // live: stop at the first failure, with the page as it is
  }

  // ── steps and phases ──
  // One recipe step: recorded (steps.json), a test.step in the report, and retried while its locator
  // matches several elements (a list still re-rendering) until its timeout.
  // Exploring (`quick` set by act) fails a guessed locator in `quick` ms, not the whole timeout, when
  // the pages had stopped changing — a miss cost 8 s, 2-3 times an authoring session. Nothing is ever
  // repeated: an action waits for its element first (present) and runs once with its full timeout; a
  // check (no side effects) tries for `quick` ms, then for the rest only while a page is still busy.
  async quickly(attempt) {
    const full = this.timeout, t0 = Date.now();
    const pages = await this.watched();
    this.full = full;  // what a browser opened meanwhile gets (open, runCode)
    this.timeout = this.quick;
    try { return await attempt(); } catch (e) {
      if (!/^expect\(|Expect "|never matched|page (URL|title)/m.test(errText(e)) || isStrictViolation(e)) throw e;
      if (!(await busySince(pages, Date.now() - 1500)) && !(await loadingShown(pages))) throw e;
      this.timeout = Math.max(1000, full - (Date.now() - t0));
      return await attempt();
    } finally { this.timeout = full; this.full = null; }
  }
  async watched() {
    const pages = Object.values(this.pages).filter((p) => p && !p.isClosed());
    await Promise.all(pages.map((p) => p.evaluate(WATCH_DOM).catch(() => {})));
    return pages;
  }
  // before an action, exploring: its element, or a fast miss on pages that stopped changing
  async present(one, verb) {
    if (!this.quick) return;
    const pages = await this.watched();
    const t0 = Date.now();
    while (Date.now() - t0 < this.quick) {
      if (await one.count().catch(() => 1)) return;
      await sleep(100);
    }
    if (await busySince(pages, Date.now() - 1500) || await loadingShown(pages)) return;  // the action waits its full timeout
    throw new Error(`locator.${verb}: nothing matched for ${this.quick} ms and the page had stopped changing\nCall log:\n  - waiting for ${one}`);
  }

  // A step on a browser: step(ref, '<browser id>', page => …) opens it (or takes it as it is) and hands its page to the
  // step — what every compiled browser call is. step(ref, fn) runs fn as it is.
  async step(ref, fn, timeout = this.timeout, retry = true) {
    if (typeof fn === 'string') {
      const id = fn, body = timeout;
      return this.step(ref, async () => body(await this.open(id, null)));
    }
    // live, carrying on from a failed step: the steps before it (not what holds it) are skipped
    if (this.resumeAt) {
      if (ref === this.resumeAt) { this.resumeAt = null; this.resumedHere = ref; }
      else if (!this.resumeAt.startsWith(`${ref}/`)) return undefined;
    }
    const [id, title] = this.stepInfo[ref] || [];
    if (ref.includes('/')) dialogStep(ref);
    const rec = { ref, wall: Date.now() };
    if (id) rec.id = id;
    // a list still re-rendering settles fast; exploring, a real ambiguity is reported after 1.5 s
    const deadline = Date.now() + (this.sessions && this.quick ? Math.min(timeout, 1500) : timeout);
    const attempt = async () => {
      for (;;) {
        try { return await fn(); } catch (e) {
          if (!retry || !isStrictViolation(e) || Date.now() > deadline) throw e;
          await sleep(150);
        }
      }
    };
    try {
      const run = this.quick && retry && timeout === this.timeout ? () => this.quickly(attempt) : attempt;
      const reported = this.info && (this.report !== 'phase' || /^\d+$/.test(ref));
      const out = reported ? await test.step(title || `step ${ref}`, run) : await run();
      for (const p of Object.values(this.pages)) {
        const failed = p && dialogs.get(p)?.failed;
        if (failed?.length) {
          const f = failed.splice(0)[0];
          throw isRouteFailure(f) ? f : dialogFailure(f);
        }
      }
      rec.ok = true;
      // live: what a read / run_code / api_call returned goes back to the agent
      if (this.sessions && out !== undefined && out !== null && typeof out !== 'function' && !(typeof out === 'object' && (isPage(out) || typeof out.page === 'function'))) rec.value = out;
      // a run keeps the page each step left, for testcase_view_state and edit-time checks
      if (this.afterStep) await this.afterStep(rec).catch(() => {});
      if (ref === this.stopAfter) throw STOP;  // testcase_run(until): the pages stay where this step left them
      return out;
    } catch (e) {
      if (e === STOP) { rec.ok = true; throw e; }
      rec.ok = false;
      // a mock that failed while this step waited is why it failed (its request was never answered): that is the error
      if (!isRouteFailure(e)) {
        for (const p of Object.values(this.pages)) {
          const failed = p && dialogs.get(p)?.failed;
          const i = failed ? failed.findIndex(isRouteFailure) : -1;
          if (i >= 0) {
            const [f] = failed.splice(i, 1);
            e = new Error(`${f.message}\n(the step then failed: ${errText(e).split('\n')[0]})`);
            break;
          }
        }
      }
      // a step on a browser the test hasn't opened yet: its variable is still undefined (QA task 016263b1: login fills
      // inserted before the browser's open read "Cannot read properties of undefined (reading 'getByPlaceholder')")
      if (e instanceof TypeError && /reading '(getBy\w+|locator|frameLocator|goto|url|title|waitForURL|keyboard|mouse)'/.test(e.message)) {
        e = new Error(`this step's browser${id ? ` "${id}"` : ''} isn't open at this point of the test — open it first `
          + `(an open / navigate to its page before this step), or it was closed earlier (${e.message})`);
      }
      rec.error = errText(e).split('\n').slice(0, 14).join('\n');
      throw e;
    } finally {
      if (this.resumedHere === ref) this.resumedHere = null;
      rec.ms = Date.now() - rec.wall;
      this.records.push(rec);
    }
  }

  // A step of several statements (an if / loop, a call with its checks): never retried as a whole.
  async block(ref, fn) { return this.step(ref, fn, 0, false); }

  // A phase runs unless an earlier one failed; an always_run one runs anyway, as cleanup: it stops at
  // its first failure (a failed check guards the delete after it) and that is reported, never the
  // verdict. The test passes when its pass phase ran and nothing outside the cleanup failed.
  async phase(i, name, fn, { always = false, pass = false } = {}) {
    if (this.failure && !always) return;
    // a phase is named in the report even when the spec carries no titles (ISS-1131)
    const info = this.stepInfo[String(i)];
    if (name && !(info && info[1])) this.stepInfo = { ...this.stepInfo, [String(i)]: [info ? info[0] : null, `Phase: ${name}`] };
    try {
      await this.block(String(i), fn);
      if (pass && !this.failure) {  // the test's dialog checks all ran: one whose dialog never came is a check never made
        const unfired = await unfiredDialogChecks(Object.values(this.pages));
        if (unfired.length) throw new Error(unfired[0].message);
      }
    } catch (e) {
      if (e === STOP) throw e;
      if (always && !pass) {
        console.warn(`cleanup phase ${name}: ${errText(e).split('\n')[0]}`);
      } else {
        if (!this.failure) { this.failure = e; await this.shoot('fail'); }
        if (this.stop) throw e;
      }
    }
    if (pass) this.passed = !this.failure;
    await this.shoot(`phase: ${name}`);
  }

  // Compiled: the run's end — steps.json written, every browser's trace saved and closed, and the
  // verdict thrown.
  // A test fails on any failure outside the cleanup phases, after its pass phase too.
  async end() {
    try { mkdirSync(`test-traces/${this.slug}`, { recursive: true }); writeFileSync(`test-traces/${this.slug}/steps.json`, JSON.stringify(this.records)); } catch {}
    for (const id of Object.keys(this.contexts)) await this.close(id).catch(() => {});
    if (this.failure) throw this.failure;
    if (!this.passed) throw new Error('the pass phase did not run');
  }

  // chains at the same time; all of them finish before the first failure is thrown
  async parallel(...chains) {
    const done = await Promise.allSettled(chains.map((c) => c()));
    const bad = done.find((d) => d.status === 'rejected');
    if (bad) throw bad.reason;
  }

  // evidence (compiled only): a JPEG of each page per phase, a full-page PNG at the first failure
  async shoot(label) {
    if (!this.info) return;
    for (const [id, page] of Object.entries(this.pages)) {
      if (page.isClosed()) continue;
      try {
        if (label === 'fail') {
          await page.screenshot({ path: `test-screenshots/${this.slug}/${id}.png`, fullPage: true });
          // the page as an agent reads it, for the verify's reply
          let tree = await page.locator('body').ariaSnapshot({ timeout: 3000 }).catch(() => '');
          // the iframes' pages too: a body snapshot shows each as a bare "- iframe" (lab v8par-s1)
          for (const f of page.frames().slice(1))
            tree += `\n# frame ${f.name() || f.url()}\n` + await f.locator('body').ariaSnapshot({ timeout: 2000 }).catch(() => '');
          if (tree) writeFileSync(`test-screenshots/${this.slug}/${id}.aria.yml`, `# ${page.url()}\n${tree}`);
        } else {
          const path = `test-shots/${this.slug}/${String(this.records.length).padStart(3, '0')}-${id}.jpg`;
          await page.screenshot({ path, type: 'jpeg', quality: 60 });
          await this.info.attach(`${label} · ${id}`, { path, contentType: 'image/jpeg' });
        }
      } catch {}
    }
  }

  // ── browsers ──
  async open(id, url, { record = this.recordAll, waitUntil, setup, fresh = false, state } = {}) {
    let page = this.pages[id];
    if (fresh && this.resumedHere && page && !page.isClosed()) { await this.close(id).catch(() => {}); page = null; }
    const target = url == null ? null : fillTokens(String(url), this.v);
    if (setup && page && !page.isClosed()) throw new Error(`browser "${id}" is open already: ${Object.keys(setup).join(', ')} set up a new one — close it first`);
    if (!page || page.isClosed()) {
      let context;
      if (this.sessions) {
        ({ page, context } = await this.sessions.open(id, { record, setup }));
      } else {
        context = await this.browser.newContext({ recordVideo: record ? { dir: `test-videos/${this.slug}/${id}` } : undefined, ...contextSetup(setup),
          ...(state ? { storageState: state } : {}), ...guardOptions() });
        await guardContext(context);
        // our own trace per browser (the run page's) — unless the test runner already traces it (a project's config
        // with trace on): then that one is kept, and ours is neither started nor stopped
        if (record && await context.tracing.start({ snapshots: true }).then(() => true, () => false)) this.traced.add(context);
        page = await context.newPage();
      }
      if (setup) await seedContext(context, setup, target && /^https?:/.test(target) ? target : null);
      context.setDefaultTimeout(this.full || this.timeout);
      // a context-wide mock (context.route) that throws: reported on the browser's page, as a page.route one is
      guardRouteHandlers(context, (e) => attachDialogs(this.pages[id] && !this.pages[id].isClosed() ? this.pages[id] : page)
        .failed.push(routeFailure(e)));
      context.on('page', trackPage);
      trackPage(page);
      this.pages[id] = page;
      this.contexts[id] = context;
    }
    if (url != null) await this.goto(page, url, waitUntil, true);
    return page;
  }

  async goto(page, url, waitUntil = 'domcontentloaded', settleAfter = false) {
    if (url === undefined || url === null || url === '') throw new Error('no URL to open (is its env var set?)');
    if (!page) throw new Error('navigate on a browser that isn\'t open: open it first ({"open": {"url": …}})');
    const dest = new URL(fillTokens(String(url), this.v), page.url() === 'about:blank' ? undefined : page.url()).href;
    let resp;
    try {
      resp = await page.goto(dest, { waitUntil, timeout: NAV_TIMEOUT_MS });
    } catch (e) {
      // the page sent itself to the same URL while ours was in flight (a waiting page that moves on
      // to /confirmed once the order is accepted, joopium 2026-10-21): ours is aborted, the page is there
      if (!/ERR_ABORTED|NS_BINDING_ABORTED|interrupted by another navigation/.test(String(e && e.message))) throw e;
      const bare = (u) => { const x = new URL(u); x.hash = ''; return x.href.replace(/\/$/, ''); };
      const there = await page.waitForURL((u) => bare(u.href) === bare(dest), { waitUntil: waitUntil === 'commit' ? 'domcontentloaded' : waitUntil, timeout: 10000 })
        .then(() => true, () => false);
      if (!there) throw e;
    }
    if (settleAfter) await settleUrl(page); else await settle(page);
    return resp ? resp.status() : null;
  }

  async close(id) {
    const page = this.pages[id], context = this.contexts[id];
    delete this.pages[id];
    delete this.contexts[id];
    if (this.sessions) return this.sessions.close(id);
    if (!context) return;
    if (Object.values(this.contexts).includes(context)) { await page.close().catch(() => {}); return; }  // a tab sharing it
    if (this.traced.delete(context)) await context.tracing.stop({ path: `test-traces/${this.slug}/${id}/trace.zip` }).catch(() => undefined);
    await context.close();
  }

  async closeAll() { for (const id of Object.keys(this.pages)) await this.close(id); }

  // A click that opens a tab: the tab becomes browser `id` (same context, same login). None within
  // 8 s is not an error: `id` is just not open then.
  async popup(id, opener, act) {
    const context = opener.context();
    const [tab] = await Promise.all([context.waitForEvent('page', { timeout: 8000 }).catch(() => null), act()]);
    if (!tab) return undefined;
    await tab.waitForLoadState('domcontentloaded').catch(() => {});
    trackPage(tab);
    this.pages[id] = tab;
    this.contexts[id] = context;
    if (this.sessions) this.sessions.adopt(id, tab);
    return tab;
  }

  // ── actions: each on exactly one visible element, then waits for what it set off ──
  one(loc) { return loc.filter({ visible: true }); }

  async guess(root, text, timeout = this.timeout) {
    const ways = [];
    try { await root.locator(text).count(); ways.push(root.locator(text)); } catch {}  // not css
    ways.push(root.getByRole('button', { name: text }), root.getByRole('link', { name: text }), root.getByText(text));
    const deadline = Date.now() + timeout;
    for (;;) {
      for (const loc of ways) if (await this.one(loc).count().catch(() => 0)) return loc;
      if (Date.now() > deadline) throw new Error(`click ${JSON.stringify(text)}: nothing visible matched it as a css selector, a button or link name, or text`);
      await sleep(100);
    }
  }

  // A bare string: a css selector, else a button, else a link with that name, else that text.
  async clickText(root, text, opts = {}) {
    let loc;
    try { loc = await this.guess(root, text, opts.optional ? 1500 : opts.timeout); } catch (e) { if (opts.optional) return false; throw e; }
    return await this.click(loc, opts);
  }

  async click(loc, { optional = false, force = false, timeout, button, clickCount, modifiers } = {}) {
    const one = this.one(loc);
    const page = one.page();
    const how = { force, ...(button ? { button } : {}), ...(clickCount ? { clickCount } : {}), ...(modifiers ? { modifiers } : {}) };
    if (optional) {
      try {
        await one.first().waitFor({ timeout: 1500 }).catch(() => {});
        if (await one.count() !== 1) return false;
        await afterAction(page, () => one.click({ timeout: 1500, ...how }));
        return true;
      } catch { return false; }
    }
    await this.present(one, 'click');
    // a styled radio / checkbox: its real <input> is hidden and its label is what a user clicks (Joopium "Collection" /
    // "Cash": an 8 s timeout in 4 of 4 QA tasks, 2026-10-25) — the label it has is clicked instead
    const label = !force && await one.evaluate((el) => {
      if (!(el instanceof HTMLInputElement) || !['radio', 'checkbox'].includes(el.type)) return false;
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      const hidden = r.width < 2 || r.height < 2 || cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none'
        || (cs.clipPath !== 'none' && cs.clipPath !== '') || document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) !== el;
      const lab = el.labels && el.labels[0];
      if (!hidden || !lab) return false;
      const lr = lab.getBoundingClientRect();
      return lr.width > 0 && lr.height > 0;
    }, null, { timeout: 1000 }).catch(() => false);
    if (label) {
      const lab = one.locator('xpath=(./ancestor::label[1])').or(one.page().locator(`label[for="${await one.getAttribute('id').catch(() => '')}"]`)).first();
      await afterAction(page, () => lab.click({ timeout, ...how }));
      return;
    }
    // a link's navigation starts within the click: afterAction waits for its document
    await afterAction(page, () => one.click({ timeout, ...how }));
  }

  // a persona credential not set in this session (sim 2026-10-23: the lead tried other names and selectors for 8 edits,
  // then typed the demo password): say which, and that it is configuration, not the recipe
  unset(name) {
    const renamed = '(your brief has a name differing only in the datasource/persona part: replace_env_var fixes every test using it)';
    if (!name.startsWith('DS_PERSONA_')) throw new Error(`${name} is not set in this session — its datasource was renamed ${renamed}, or it has no such field`);
    throw new Error(`${name} is not set in this session — the persona has no credentials configured, or it was renamed ${renamed}. `
      + 'Otherwise it is not the recipe: keep the envVar, tell the lead (a person adds the credentials on the datasource), and never type the value instead');
  }

  async fill(loc, value, { timeout } = {}) {
    if (value === undefined || value === null) throw new Error('fill has no value (is its env var set?)');
    const one = this.one(loc);
    await this.present(one, 'fill');
    await afterAction(one.page(), () => one.fill(String(value), { timeout }));
  }

  async type(target, text, { delay = 20, timeout } = {}) {
    if (text === undefined || text === null) throw new Error('type has no value (is its env var set?)');
    if (!isPage(target)) await this.one(target).click({ timeout });
    await pageOf(target).keyboard.type(String(text), { delay });
  }

  async press(target, key = 'Enter', { timeout } = {}) {
    const page = pageOf(target);
    await afterAction(page, () => (isPage(target) ? page.keyboard.press(key) : this.one(target).press(key, { timeout })));
  }

  async select(loc, value, { timeout } = {}) {
    const one = this.one(loc);
    await this.present(one, 'selectOption');
    try {
      // a multi-select takes a list ({"value": ["saab", "audi"]}); String() made it one option "saab,audi"
      const want = Array.isArray(value) ? value.map(String) : String(value);
      await afterAction(one.page(), () => one.selectOption(want, { timeout }));
    } catch (e) {
      if (/did not find some options|Timeout \d+ms exceeded/i.test(errText(e))) {
        const opts = await one.evaluate((n) => (n.options ? [...n.options].map((o) => (o.value === o.label ? o.value : `${o.value} (${o.label})`)) : null)).catch(() => null);
        if (opts) throw new Error(`no option ${JSON.stringify(value)} in this <select>: its options are ${opts.slice(0, 30).join(', ')} — "value" is an option's value or its label`);
      }
      if (!/not a <select> element/i.test(errText(e))) throw e;
      throw new Error('select works on a native <select> only, and this is a custom dropdown: click it open, then click '
        + `the option — {"click": <this locator>}, then {"click": {"role": "option", "name": ${JSON.stringify(String(value))}}}`);
    }
  }

  async hover(loc, { force = false, timeout } = {}) { await this.present(this.one(loc), 'hover'); await this.one(loc).hover({ force, timeout }); }

  async drag(from, to, { timeout } = {}) { await this.one(from).dragTo(this.one(to), { timeout }); }

  // file: {name, mimeType?, base64} — the content travels with the test case — or a path (live only)
  async upload(loc, file, { timeout } = {}) {
    const files = typeof file === 'string' ? file
      : { name: file.name || 'upload.dat', mimeType: file.mimeType || 'application/octet-stream', buffer: Buffer.from(file.base64 || '', 'base64') };
    await loc.first().setInputFiles(files, { timeout });
  }

  async scroll(target, dx = 0, dy = 500, { timeout } = {}) {
    if (isPage(target)) await target.mouse.wheel(dx, dy);
    else await this.one(target).first().scrollIntoViewIfNeeded({ timeout });
  }

  async waitFor(loc, state = 'visible', { timeout } = {}) { await this.one(loc).first().waitFor({ state, timeout }); }

  // ── checks ──
  // The page's address: a glob ("**/cart*"), an exact "/path" (path + query + hash), a whole URL,
  // or part of one (matcher "contains_text").
  async expectUrl(page, want, matcher = 'text', { timeout = this.timeout } = {}) {
    want = String(want);
    if (want.includes('*') && matcher !== 'contains_text') {
      await page.waitForURL(want, { timeout, waitUntil: 'commit' }).catch(() => {
        throw new Error(`the page is at ${page.url()}, which never matched ${JSON.stringify(want)} in ${timeout} ms ("*" = anything but "/", "**" = anything)`);
      });
      return;
    }
    const now = () => {
      const u = new URL(page.url());
      return matcher === 'contains_text' ? page.url() : want.startsWith('/') ? u.pathname + u.search + u.hash : page.url();
    };
    if (matcher === 'contains_text') await expect.poll(now, { timeout, message: 'page URL' }).toContain(want);
    else await expect.poll(now, { timeout, message: 'page URL' }).toBe(want);
  }

  async expectTitle(page, want, matcher = 'text', { timeout = this.timeout } = {}) {
    const poll = expect.poll(() => page.title(), { timeout, message: 'page title' });
    await (matcher === 'contains_text' ? poll.toContain(String(want)) : poll.toBe(String(want)));
  }

  // The first number in the element's text ("Total: $19.42") equals `want` (a number, or text holding one).
  async expectNumber(loc, want, { timeout = this.timeout } = {}) {
    const n = parseNum(want);
    if (!n) throw new Error(`"number" expects a number, not ${JSON.stringify(want)}`);
    const wanted = Number(fmtNum({ ...n, grouped: false }));
    let seen = '';
    await this.until(timeout, async () => {
      seen = await loc.innerText({ timeout: 1000 }).catch((e) => { throw isStrictViolation(e) ? e : new Error(`${loc} is not on the page`); });
      const p = parseNum(seen);
      return !!p && Number(fmtNum({ ...p, grouped: false })) === wanted;
    }, () => `${loc} shows ${JSON.stringify(seen.trim().slice(0, 80))}, expected the number ${wanted}`);
  }

  // Every element `loc` matches, in order: by their numbers when each has one, else by text.
  async expectSorted(loc, order = 'asc', { timeout = this.timeout } = {}) {
    let texts = [];
    let breakAt = -1;
    await settle(loc.page());
    await this.until(timeout, async () => {
      texts = (await loc.allInnerTexts()).map((t) => t.trim());
      if (texts.length < 2) return false;
      const nums = texts.map((t) => parseNum(t));
      const keys = nums.every(Boolean) ? nums.map((x) => Number(fmtNum({ ...x, grouped: false }))) : texts;
      breakAt = keys.findIndex((k, i) => i > 0 && (typeof k === 'number' ? k - keys[i - 1] : k.localeCompare(keys[i - 1])) * (order === 'desc' ? -1 : 1) < 0);
      return breakAt < 0;
    }, () => {
      if (texts.length < 2) return `${loc} matched ${texts.length} element(s) — "sorted" checks a list`;
      // where the order breaks, not the first 12: flipkart.com's broke at 25–27 (sponsored results), and the first 12 looked right
      const from = Math.max(0, breakAt - 3);
      return `not in ${order === 'desc' ? 'descending' : 'ascending'} order at item ${breakAt + 1} of ${texts.length}: `
        + `${from ? '… ' : ''}${texts.slice(from, breakAt + 3).map((t, i) => (from + i === breakAt ? `[${t}]` : t)).join(', ')}`;
    });
    return texts;  // exploring, the recording links later checks to these values (record.mjs)
  }

  // Polls `ok` until it is true or the time is up, then fails with `why()`.
  async until(timeout, ok, why) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await ok()) return;
      if (Date.now() > deadline) throw new Error(why());
      await sleep(150);
    }
  }

  // A check, then what it checked (a capture on a check): its text, value, count…
  async readAfter(check, loc, as) { await check; return await this.read(loc, as); }

  // A value off the page, for a capture: text (as rendered), value, count, checked, visible, enabled.
  async read(target, as = 'text', { timeout = this.timeout } = {}) {
    const page = pageOf(target);
    await settle(page);
    if (isPage(target)) return as === 'title' ? target.title() : target.url();
    const first = target.first();
    switch (as) {
      case 'count': return await target.count();
      case 'value': return await first.inputValue({ timeout });
      case 'checked': return await first.isChecked({ timeout });
      case 'visible': return await first.isVisible();
      case 'hidden': return !(await first.isVisible());
      case 'enabled': return await first.isEnabled({ timeout });
      case 'disabled': return !(await first.isEnabled({ timeout }));
      default: return ((await first.evaluate(elementText, undefined, { timeout })) ?? '').replace(/\s+/g, ' ').trim();
    }
  }

  // conditions (if / loop while): read the settled page, never wait for the element
  // — and its DOM stopped changing: an infinite list appends what an End press fetched after the request is done, and a
  // loop's next turn read it too early (the-internet's infinite scroll: 10 presses, 4 more items)
  async isVisible(loc) { await settle(pageOf(loc)); await settleDom(pageOf(loc)); return await loc.first().isVisible(); }
  async exists(loc) { await settle(pageOf(loc)); await settleDom(pageOf(loc)); return (await loc.count()) > 0; }
  compare(left, op, right) {
    if (op === 'eq') return String(left) === String(right);
    if (op === 'ne') return String(left) !== String(right);
    if (op === 'contains') return String(left).includes(String(right));
    if (op === 'gt') return asNumber(left) > asNumber(right);
    if (op === 'lt') return asNumber(left) < asNumber(right);
    throw new Error(`unknown condition op ${JSON.stringify(op)}`);
  }

  // The next native dialog's answer (until the act ends: disarm).
  dialog(page, mode = 'accept', promptText) { attachDialogs(page).armed = { mode, promptText }; }
  disarm(...pages) { for (const p of pages) if (p && dialogs.has(p)) dialogs.get(p).armed = null; }

  // The next dialog on this page not yet checked: its text contains (or is) `want`. Returns the text.
  async expectDialog(page, matcher = 'contains_text', want, { timeout = this.timeout } = {}) {
    const st = attachDialogs(page);
    const ok = (m) => (matcher === 'text' ? m.trim() === String(want ?? '').trim() : matcher === 'contains_text' ? m.includes(String(want ?? '')) : true);
    const deadline = Date.now() + timeout;
    for (;;) {
      const i = st.log.slice(st.cursor).findIndex((d) => ok(d.message));
      if (i >= 0) { const d = st.log[st.cursor + i]; st.cursor += i + 1; return d.message; }
      if (Date.now() > deadline) break;
      await sleep(100);
    }
    const seen = st.log.slice(st.cursor).map((d) => `${d.type} "${d.message.slice(0, 60)}"`);
    // QA task 69e08c2b: the check went in before the click that opens the alert (an open the recorder put first shifted refs)
    throw new Error(seen.length ? `no dialog matching ${JSON.stringify(want)}; dialogs since the last check: ${seen.join(', ')}`
      : `no dialog appeared within ${timeout} ms — a dialog check goes right after the step that opens it (the click), not before`);
  }

  // ── the rest ──
  // Mocks requests to `url` (a glob): {status, body, contentType, headers} or {abort}; once by default.
  async route(page, { url, status = 200, body, contentType, headers, abort, once = true }) {
    const json = body !== null && typeof body === 'object';
    const handler = async (r) => {
      try {
        if (abort) await r.abort(typeof abort === 'string' ? abort : 'failed');
        else await r.fulfill({ status, headers, contentType: contentType || (json ? 'application/json' : 'text/plain'), body: body == null ? undefined : json ? JSON.stringify(body) : String(body) });
      } finally { if (once) await page.unroute(url, handler).catch(() => {}); }
    };
    await page.route(url, handler);
  }

  async evaluate(page, expr) {
    const h = await page.evaluateHandle(expr);
    try { return await h.evaluate((x) => (typeof x === 'function' ? x() : x)); } finally { await h.dispose().catch(() => {}); }
  }

  // JavaScript with the Playwright API, `async (page, context) => {...}` — the escape hatch. A string
  // has its tokens filled in first. The page is settled before it reads anything.
  async runCode(page, code, { timeout = 30000 } = {}) {
    let fn = code;
    if (typeof code === 'string') {
      try { fn = new Function(`return (${fillTokens(code, this.v)})`)(); } catch (e) {
        throw new Error(`run_code: the code is not a function — ${errText(e)}`);
      }
    }
    if (typeof fn !== 'function') throw new Error('run_code: the code is not a function');
    const context = page ? page.context() : null;
    if (page) { await settle(page); await settleDom(page); }
    const st = page ? attachDialogs(page) : null;
    if (st) st.runCode += 1;
    if (context) context.setDefaultTimeout(Math.min(10000, timeout));
    let timer;
    try {
      return await Promise.race([fn(page, context),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`run_code timed out after ${timeout} ms`)), timeout); })]);
    } catch (e) {
      if (e instanceof ReferenceError && /\b(window|document)\b/.test(e.message)) e.message += ' — run_code runs in Node: use page.evaluate(() => …) for window/document';
      throw e;
    } finally {
      clearTimeout(timer);
      if (st) st.runCode -= 1;
      if (context) context.setDefaultTimeout(this.full || this.timeout);
    }
  }

  // The response to `url` (a glob) that `trigger` causes; returns its body text.
  async waitForResponse(page, url, trigger, { timeout = 15000 } = {}) {
    const [resp] = await Promise.all([page.waitForResponse(url, { timeout }), trigger ? trigger() : null]);
    return await resp.text().catch(() => '');
  }

  async db(spec) { return await runDbAction(spec); }

  async api(spec) {
    const ctx = spec.id ? this.contexts[spec.id] : null;
    if (spec.id && !ctx) throw new Error(`no open browser ${JSON.stringify(spec.id)} for this api_call`);
    const page = spec.id ? this.pages[spec.id] : null;
    const row = apiRequestRow(spec);
    this.apiCalls.push(row);
    if (this.apiCalls.length > 50) this.apiCalls.shift();
    try {
      const out = unmarkInts(await runApiCall(spec, ctx ? { context: ctx, pageUrl: page.url(), id: spec.id,
        pageAuth: (url) => { try { return (pageAuth.get(ctx) || new Map()).get(new URL(url).origin); } catch { return undefined; } } } : null));
      Object.assign(row.request, out.request || {});
      const body = typeof out.response_body === 'string' ? out.response_body : JSON.stringify(out.response_body ?? '');
      row.response = { status: out.status, latency_ms: out.latency_ms, headers: out.headers || {},
        body_excerpt: body.length > 2000 ? body.slice(0, 2000) + '…' : body, truncated: !!out.truncated };
      row.response_body = out.response_body;  // for its checks (m.check); dropped from the evidence
      return out;
    } catch (e) {
      row.response = { status: Number((/answered HTTP (\d{3})/.exec(errText(e)) || [])[1]) || null };
      row.ok = false;
      row.failures.push(errText(e).split('\n')[0]);
      throw e;
    }
  }

  // result_checks; a cleanup phase's checks still guard what follows them
  check(result, checks) {
    const fail = (checks || []).flatMap((c) => checkFailures(result, c, this.v));
    const row = this.apiCalls.find((r) => r.response_body === result.response_body && r.response && r.response.status === result.status);
    if (row && fail.length) { row.ok = false; row.failures.push(...fail); }
    if (fail.length) throw new Error(fail.join('; '));
  }

  // The api_calls' evidence as the run page stores it, persona secrets blanked wherever they landed.
  apiEvidence() {
    const secrets = personaSecrets();
    const blank = (x) => (typeof x === 'string' ? secrets.reduce((s, v) => s.split(v).join('[redacted]'), x)
      : Array.isArray(x) ? x.map(blank) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, blank(v)])) : x);
    return this.apiCalls.map(({ response_body, ...row }) => blank(row));
  }

  // a call-level capture: {name: "rows.0.id"}; "rows.0.id ?? 0" keeps 0 when there is nothing there — a table's newest
  // id read before the action, on a database that has no row yet (lab v3: the saved test replayed on a fresh database
  // failed at its first step, "nothing at rows.0.id", in 4 of 6 runs)
  capture(result, paths) {
    for (const [name, raw] of Object.entries(paths)) {
      const [path, fallback] = splitDefault(String(raw));
      let v = getPath(result, path.includes('{{') ? fillTokens(path, this.v, {}) : path);
      if (v === null && fallback !== undefined) v = fallback;
      if (v === null) throw new Error(`capture "${name}": nothing at "${path}" in the result`);
      this.v[name] = v;
    }
  }

  // a test id: data-testid, or data-test / data-qa / data-cy as many apps have it
  testId(root, id) {
    return root.locator(['data-testid', 'data-test', 'data-qa', 'data-cy'].map((a) => `[${a}=${JSON.stringify(String(id))}]`).join(', '));
  }

  // an exact accessible name, give or take icon-font glyphs (private-use characters) and spaces
  // around it: a link drawn as "<i class=fa-…></i> Hold" is named " Hold", so an exact "Hold"
  // matched nothing while a loose one also matched "On hold(0)" (joopium POS, 2026-10-21)
  exactName(name) {
    const esc = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`^[\\s\\uE000-\\uF8FF]*${esc}[\\s\\uE000-\\uF8FF]*$`);
  }

  t(text) { return fillTokens(text, this.v); }
  // browser_capture: the element's value or text, read as the live capture reads it (tokens.mjs READ_VALUE)
  async read(loc) { return loc.evaluate(new Function(`return (${READ_VALUE})`)()); }
  // a token outside quotes in code ({{tasks}}, {{n+1}}): the value its text is, as the live run pastes the text (tokens.mjs codeValue)
  lit(token) { return codeValue(this.t(token), token); }

  // A function the browser runs (page.evaluate(m.inPage(fn))) with its m.t('…') calls replaced by their values, written
  // into its source: the page has no `m`, and the live run fills a token's value into the code the same way.
  inPage(fn) {
    if (typeof fn !== 'function') return fn;
    // m.lit('{{x}}'): the text itself, as the live run writes it into the code (checked as m.lit checks it)
    const src = String(fn).replace(/\bm\.lit\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")\s*\)/g, (_, literal) => {
      const token = new Function(`return ${literal}`)();
      const text = this.t(token);
      codeValue(text, token);
      return `(${text})`;
    }).replace(/\bm\.t\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")\s*\)/g,
      (_, literal) => JSON.stringify(this.t(new Function(`return ${literal}`)())));
    return new Function(`return (${src})`)();
  }

  // ── shared flows and data (next-gen/mpw-output-policy) ──
  // The data a test reads, by name: its own ("data", {{data.key}}) and the shared sets ({{leave.start}}); the tokens in
  // their values ({{today+7}}, {{uid}}) filled once for the run — as the live run seeds them (runner.mjs).
  useData(sets) {
    const fill = (v) => (typeof v === 'string' ? (v.includes('{{') || v.includes('$DS_') ? this.t(v) : v)
      : Array.isArray(v) ? v.map(fill) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v);
    for (const [name, value] of Object.entries(sets || {})) this.v[name] = fill(value);
  }

  // The page settled after a navigation: its load event, for up to 5 s — a slow sub-resource is no failure (as the
  // live navigate goes, upstream Tab.navigate).
  async loaded(page) {
    await page.waitForLoadState('load', { timeout: 5000 }).catch(() => undefined);
  }

  // What the browsers just did reaches the server first: every open page settled before a db / api_call reads it.
  async settleAll() {
    for (const p of Object.values(this.pages)) if (p && !p.isClosed()) await settle(p);
  }

  // A shared login flow on browser `id`: the session a setup project (auth/<name>.setup.ts) or an earlier test of this
  // run saved, checked with the flow's own last check (`proof`) — or, without one or when it no longer holds (signed
  // out, expired), the whole flow, whose session is then saved for the tests after it.
  async signIn(id, name, full, proof) {
    const file = sessionFile(name);
    if (existsSync(file) && !this.pages[id]) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        const page = await this.open(id, null, { state: saved.state });
        await this.goto(page, saved.url);
        await proof(page);
        return;
      } catch (e) {
        console.warn(`signIn ${name}: the saved session no longer holds (${errText(e).split('\n')[0]}) — signing in again`);
        await this.close(id).catch(() => undefined);
      }
    }
    await full();
    await this.saveSession(id, name);
  }

  async saveSession(id, name) {
    const page = this.pages[id], context = this.contexts[id];
    if (!page || !context) throw new Error(`no browser "${id}" to save the session of`);
    mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(sessionFile(name), JSON.stringify({ url: page.url(), state: await context.storageState() }));
  }
}

const SESSION_DIR = process.env.MERIDIAN_SESSION_DIR || '.auth';
const sessionFile = (name) => `${SESSION_DIR}/${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
