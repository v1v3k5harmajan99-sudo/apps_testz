// `api_call` — a pure HTTP request/response check, no browser, no page, no cookies (unless `id`
// names an open browser — see runApiCall) — for the "api"-kind testcase surface. Uses Node's
// global `fetch`, no new dependency. Same secret discipline as `db`: a header value may be
// {"envVar": "DS_PERSONA_..."} instead of a literal, resolved server-side via env.mjs
// resolveCredEnvVar so the caller never sees or passes the actual token/credential.
//
// API datasources and auth profiles: `datasource` ("DS_BOOKER") gives the base URL
// (`path`/relative `url` join onto $DS_BOOKER_URL) and the auth profile; `as`
// ("DS_PERSONA_BOOKER_ADMIN") applies it for that persona — api_key / basic / bearer / login
// (POST the login path once per persona, cache the token, re-login once on a 401). `query` adds a
// query string; `$DS_<SLUG>_<FIELD>` facts in the URL are expanded; {"envVar"} objects inside a JSON
// body are replaced by the secret. The one implementation: live calls, compiled specs and API test
// case runs (compiler/run-api.mjs, the Lambda fast lane's too) all use it.
import { expandDsFacts, PERSONA_PREFIX, resolveCredEnvVar } from './env.mjs';
import { assertPublicUrl, guardedFetch } from './netguard.mjs';

const errText = (e) => (e && e.message) || String(e);
// A cookie, bearer token or password never goes back to the caller: header names stay, values go.
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'proxy-authorization']);
export function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[redacted]' : v;
  return out;
}

const API_CALL_BODY_CAP = 20000; // chars of a body shown to the agent — checks and captures read all of it
const API_CALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const API_AUTH_MODES = ['none', 'api_key', 'basic', 'bearer', 'login'];
const API_DEFAULT_ACCEPT = '*/*'; // both engines (fetch's own default); some APIs 4xx without one
const API_DEFAULT_USER_AGENT = 'Meridian-API-Test/1.0';
const API_DEFAULT_LOGIN_BODY = '{"username": "{{username}}", "password": "{{password}}"}';
const MAX_429_RETRIES = 2; // a 429 means the request was rejected (rate-limited), never processed —
// so re-issuing after a wait is safe for any method, POST included (nothing happened the first time).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How long to wait before a 429 retry: the server's Retry-After (seconds, or an HTTP-date) when it
// gives one (capped at 10 s so a hostile value can't hang a run), else exponential backoff.
function retryAfterMs(header, attempt) {
  const base = Math.min(4000, 500 * 2 ** attempt);
  if (header === undefined || header === null || header === '') return base;
  const secs = Number(String(header).trim());
  if (Number.isFinite(secs)) return Math.min(10000, Math.max(0, secs * 1000));
  const when = Date.parse(String(header));
  if (!Number.isNaN(when)) return Math.min(10000, Math.max(0, when - Date.now()));
  return base;
}
const apiTokens = new Map(); // `${ds}|${persona}` -> token, for this process's lifetime
// Integers past 2^53 (int64 ids) lose digits in a plain JSON.parse, so a captured id sent back
// would point at a different record. Such literals are parsed as marked strings here and written
// back out as the same bare digits by main.mjs's toContent, via stringifyExact — Node 20 (the
// worker image) has no JSON.rawJSON.
const EXACT_INT_MARK = '\u0000int:';
function parseJsonExact(text) {
  if (!/\d{16}/.test(text)) return JSON.parse(text);
  return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|(?<![\d.eE+-])(-?\d{16,})(?![\d.eE])/g,
    (m, n) => (n !== undefined && !Number.isSafeInteger(Number(n)) ? `"\\u0000int:${n}"` : m))); // JSON-escaped: parses to EXACT_INT_MARK + digits
}
export function stringifyExact(value) {
  const s = JSON.stringify(value);
  return s && s.includes('\\u0000int:') ? s.replace(/"\\u0000int:(-?\d+)"/g, '$1') : s;
}
function normDs(ds) {
  ds = String(ds || '').trim();
  return !ds ? '' : (ds.startsWith('DS_') ? ds : `DS_${ds}`);
}
function apiCred(persona, field, env = process.env) {
  if (!persona.startsWith(PERSONA_PREFIX)) throw new Error(`as must name a persona env prefix starting with "DS_PERSONA_" (got ${JSON.stringify(persona)})`);
  return env[`${persona}_${field}`] || '';
}
function apiGetPath(value, path) {
  let cur = value;
  for (const part of String(path).split('.')) {
    if (Array.isArray(cur)) {
      if (!/^-?\d+$/.test(part)) return undefined;
      let i = Number(part);
      if (i < 0) i += cur.length;
      if (i < 0 || i >= cur.length) return undefined;
      cur = cur[i];
    } else if (cur && typeof cur === 'object') {
      if (Object.prototype.hasOwnProperty.call(cur, part)) { cur = cur[part]; continue; }
      const k = Object.keys(cur).find((x) => x.toLowerCase() === part.toLowerCase());
      if (k === undefined) return undefined;
      cur = cur[k];
    } else return undefined;
  }
  return cur;
}
// pageUrl: the page of the browser named by `id` — a relative path with no datasource is on that
// page's origin, where its cookies belong.
export function buildApiUrl(spec, env = process.env, pageUrl = '') {
  const ds = normDs(spec.datasource);
  let target = expandDsFacts(String(spec.url || spec.path || ''), env);
  if (!/^https?:\/\//i.test(target)) {
    if (!ds && /^https?:/i.test(pageUrl)) return withQuery(new URL(target || '/', pageUrl).href, spec.query);
    if (!ds) throw new Error('url must be absolute, or give `datasource` with a relative `path`'
      + (spec.id ? ` (browser "${spec.id}" is on ${pageUrl || 'no page'}, so its origin can't be used)` : ''));
    const base = env[`${ds}_URL`];
    if (!base) throw new Error(`${ds}_URL is not set — is ${ds} an api/website datasource in this workspace?`);
    target = base.replace(/\/+$/, '') + (target ? '/' + target.replace(/^\/+/, '') : '');
  }
  return withQuery(target, spec.query);
}
function withQuery(target, query) {
  if (!query) return target;
  if (typeof query !== 'object' || Array.isArray(query)) throw new Error('query must be an object');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
    else qs.append(k, v === null || v === undefined ? '' : String(v));
  }
  return target + (target.includes('?') ? '&' : '?') + qs.toString();
}
function resolveBodySecrets(body, env = process.env) {
  if (Array.isArray(body)) return body.map((v) => resolveBodySecrets(v, env));
  if (body && typeof body === 'object') {
    const keys = Object.keys(body);
    if (keys.length === 1 && keys[0] === 'envVar') return resolveCredEnvVar(String(body.envVar), env);
    return Object.fromEntries(keys.map((k) => [k, resolveBodySecrets(body[k], env)]));
  }
  return body;
}
function joinTokenPrefix(prefix, token) {
  prefix = String(prefix ?? '').trim();
  if (!prefix) return token;
  return /[=:]$/.test(prefix) ? `${prefix}${token}` : `${prefix} ${token}`;
}
function apiAuthMode(ds, env = process.env) {
  const mode = ds ? String(env[`${ds}_AUTH_MODE`] || 'none').trim().toLowerCase() : 'none';
  if (!API_AUTH_MODES.includes(mode)) throw new Error(`${ds}_AUTH_MODE ${JSON.stringify(mode)} is not one of ${API_AUTH_MODES.join(', ')}`);
  return mode;
}
async function apiLoginToken(ds, persona, fresh, env = process.env) {
  const key = `${ds}|${persona}`;
  if (apiTokens.has(key) && !fresh) return apiTokens.get(key);
  const path = env[`${ds}_LOGIN_PATH`] || '';
  if (!path) throw new Error(`${ds}_LOGIN_PATH is not set (auth mode login)`);
  const esc = (v) => JSON.stringify(v).slice(1, -1);
  const body = (env[`${ds}_LOGIN_BODY`] || API_DEFAULT_LOGIN_BODY)
    .split('{{username}}').join(esc(apiCred(persona, 'USERNAME', env)))
    .split('{{password}}').join(esc(apiCred(persona, 'PASSWORD', env)));
  const headers = { 'Content-Type': 'application/json', Accept: API_DEFAULT_ACCEPT, 'User-Agent': API_DEFAULT_USER_AGENT };
  const apiKey = apiCred(persona, 'API_KEY', env);
  if (apiKey) headers[env[`${ds}_API_KEY_HEADER`] || 'x-api-key'] = apiKey;
  const url = buildApiUrl({ datasource: ds, path }, env);
  let res;
  try {
    res = await guardedFetch(url, { method: 'POST', headers, body });
  } catch (e) {
    throw new Error(`login as ${persona} failed: ${errText(e).slice(0, 200)}`);
  }
  const tokenPath = env[`${ds}_TOKEN_PATH`] || 'token';
  let token;
  if (res.status < 400) {
    if (tokenPath.startsWith('cookie:')) {
      const name = tokenPath.slice('cookie:'.length);
      const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
      for (const c of cookies) {
        const m = String(c).match(new RegExp(`(?:^|,)\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`));
        if (m) { token = m[1]; break; }
      }
    } else {
      try { token = apiGetPath(JSON.parse(await res.text()), tokenPath); } catch { token = undefined; }
    }
  }
  if (token === undefined || token === null || token === '' || typeof token === 'object') {
    throw new Error(`login as ${persona} failed: POST ${path} returned ${res.status} with no token at ${JSON.stringify(tokenPath)}`);
  }
  apiTokens.set(key, String(token));
  return String(token);
}
async function apiAuthHeaders(spec, fresh = false, env = process.env) {
  const ds = normDs(spec.datasource);
  const persona = String(spec.as || '').trim();
  if (!persona) return {};
  if (!ds) throw new Error('`as` needs `datasource` too — the persona\'s auth profile lives on the datasource');
  const mode = apiAuthMode(ds, env);
  const out = {};
  const apiKey = apiCred(persona, 'API_KEY', env);
  if (apiKey) out[env[`${ds}_API_KEY_HEADER`] || 'x-api-key'] = apiKey;
  if (mode === 'api_key' && !apiKey) throw new Error(`${persona}_API_KEY is not set (auth mode api_key)`);
  if (mode === 'basic') {
    const user = apiCred(persona, 'USERNAME', env);
    if (!user) throw new Error(`${persona}_USERNAME is not set (auth mode basic)`);
    out.Authorization = 'Basic ' + Buffer.from(`${user}:${apiCred(persona, 'PASSWORD', env)}`).toString('base64');
  } else if (mode === 'bearer' || mode === 'login') {
    const token = mode === 'bearer' ? apiCred(persona, 'TOKEN', env) : await apiLoginToken(ds, persona, fresh, env);
    if (!token) throw new Error(`${persona}_TOKEN is not set (auth mode bearer)`);
    const prefix = env[`${ds}_TOKEN_PREFIX`] === undefined ? 'Bearer' : env[`${ds}_TOKEN_PREFIX`];
    out[env[`${ds}_TOKEN_HEADER`] || 'Authorization'] = joinTokenPrefix(prefix, token);
  }
  return out;
}
export function formBody(obj) {
  const p = new URLSearchParams();
  const str = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
  for (const [k, v] of Object.entries(obj || {})) {
    for (const item of Array.isArray(v) ? v : [v]) p.append(k, str(item));
  }
  return p.toString();
}

// A body that isn't text (an image, a PDF, a zip) is summarised, not decoded as mojibake.
const BINARY_TYPE = /^(image|audio|video|font)\/|application\/(octet-stream|pdf|zip|gzip|x-tar|vnd\.|msword)/i;
async function bodyText(res, method, contentType, read) {
  if (method === 'HEAD') return '';
  if (BINARY_TYPE.test(contentType || '') && !/svg|json|xml/i.test(contentType)) {
    const n = await read.bytes().then((b) => b.byteLength).catch(() => 0);
    return `(binary ${String(contentType).split(';')[0]}, ${n} bytes)`;
  }
  return await read.text().catch(() => '');
}

// `auth: "page"`: with `id`, and not with `as` — that's the API datasource's own login.
export function apiPageAuthProblem(spec) {
  if (spec.auth === undefined || spec.auth === null) return null;
  if (spec.auth !== 'page') return `api_call auth takes "page" (send the Authorization header the browser's page sends), not ${JSON.stringify(spec.auth)}`;
  if (!spec.id) return 'api_call auth "page" needs id, the browser whose page sends that header';
  if (spec.as) return 'api_call takes auth "page" or as, not both';
  return null;
}

// `session` (an api_call with `id`): {context, pageUrl, id, pageAuth(url)?, apiOrigins()?} — that
// browser's context sends the request with its cookies.
export async function runApiCall(spec, session = null, retried = false) {
  const method = String(spec.method || 'GET').toUpperCase();
  if (!API_CALL_METHODS.includes(method)) throw new Error('unknown method: ' + JSON.stringify(spec.method));
  if (!spec.url && !spec.path && !spec.datasource) throw new Error('url (or datasource + path) is required');
  const url = buildApiUrl(spec, process.env, session ? session.pageUrl : '');

  const headers = {};
  for (const [k, v] of Object.entries(spec.headers || {})) {
    headers[k] = (v && typeof v === 'object' && v.envVar !== undefined) ? resolveCredEnvVar(v.envVar) : String(v);
  }
  for (const [k, v] of Object.entries(await apiAuthHeaders(spec, retried))) {
    if (!Object.keys(headers).some((h) => h.toLowerCase() === k.toLowerCase())) headers[k] = v;
  }
  const authProblem = apiPageAuthProblem(spec);
  if (authProblem) throw new Error(authProblem);
  if (spec.auth === 'page' && !Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')) {
    const value = session && session.pageAuth ? session.pageAuth(url) : undefined;
    if (!value) {
      throw new Error(`auth "page": browser ${JSON.stringify(spec.id)}'s page hasn't sent an Authorization header to `
        + `${new URL(url).origin} yet. Take a step that makes it call that API (open a screen that loads data), then call again`);
    }
    headers.Authorization = value;
  }
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) headers.Accept = API_DEFAULT_ACCEPT;
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'user-agent')) headers['User-Agent'] = API_DEFAULT_USER_AGENT;
  let body;
  // Multipart parts, when the body is a form upload: field -> a string, or {filename, mimeType,
  // buffer} for a file. Built once here, sent the engine's own way below (fetch FormData / Playwright
  // multipart), each of which sets its own boundary — so any content-type header is dropped.
  let multipartParts = null;
  const isFilePart = (v) => v && typeof v === 'object' && !Array.isArray(v) && v.file && typeof v.file === 'object';
  // fetch can't send a body on GET/HEAD: refuse rather than drop it silently.
  if (spec.body !== undefined && spec.body !== null && (method === 'GET' || method === 'HEAD')) {
    throw new Error(`a ${method} request can't carry a body: put the fields in "query", or use POST`);
  }
  if (spec.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    const type = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type');
    // multipart/form-data: either the content type says so, or a field is a file part
    // {"field": {"file": {"base64": "...", "filename"?: "x.sql.gz", "mimeType"?: "..."}}}.
    const wantsMultipart = spec.body && typeof spec.body === 'object' && !Array.isArray(spec.body)
      && ((type && /multipart\/form-data/i.test(type[1])) || Object.values(spec.body).some(isFilePart));
    if (typeof spec.body === 'string') {
      body = spec.body;
    } else if (wantsMultipart) {
      multipartParts = {};
      for (const [k, v] of Object.entries(spec.body)) {
        if (isFilePart(v)) {
          multipartParts[k] = { filename: String(v.file.filename || 'upload.dat'),
            mimeType: String(v.file.mimeType || 'application/octet-stream'),
            buffer: Buffer.from(String(v.file.base64 || ''), 'base64') };
        } else {
          const resolved = resolveBodySecrets(v); // a field value may still be an {"envVar"} secret
          multipartParts[k] = (resolved !== null && typeof resolved === 'object') ? JSON.stringify(resolved) : String(resolved);
        }
      }
      if (type) delete headers[type[0]]; // let the engine set the boundary
    } else if (type && /application\/x-www-form-urlencoded/i.test(type[1])) {
      // An object with a form content type is encoded as a form (so it can hold an {"envVar"},
      // e.g. an OAuth /token login); a list repeats its key.
      body = formBody(resolveBodySecrets(spec.body));
    } else {
      body = JSON.stringify(resolveBodySecrets(spec.body));
      if (!type) headers['Content-Type'] = 'application/json';
    }
  }

  const timeoutMs = Number(spec.timeout_ms) || 15000;
  const startedAt = Date.now();

  // `id` reuses an already-open browser's cookies/session instead of a header-carried credential —
  // via Playwright's own `context.request` (an APIRequestContext bound to that browsing context),
  // so a call can hit an internal API as whoever this browser is logged in as. Without `id`: no
  // browser, no page, no cookies.
  // One request attempt, both engines — a function so a 429 can re-issue it after a wait. Multipart
  // is sent each engine's own way: Playwright's `multipart` option, or a global FormData for fetch.
  const issue = async () => {
    if (session) {
      const opts = { method, headers, timeout: timeoutMs };
      if (multipartParts) {
        const mp = {};
        for (const [k, v] of Object.entries(multipartParts)) mp[k] = (v && v.buffer) ? { name: v.filename, mimeType: v.mimeType, buffer: v.buffer } : String(v);
        opts.multipart = mp;
      } else if (body !== undefined) {
        opts.data = body;
      }
      let res;
      try {
        await assertPublicUrl(url);
        res = await session.context.request.fetch(url, opts);
      } catch (e) {
        throw new Error('request failed: ' + errText(e).slice(0, 200));
      }
      const h = res.headers();
      return { status: res.status(), responseHeaders: h, finalUrl: res.url(),
        rawText: await bodyText(res, method, h['content-type'], { text: () => res.text(), bytes: () => res.body() }) };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      let sendBody = body;
      if (multipartParts) {
        sendBody = new FormData();
        for (const [k, v] of Object.entries(multipartParts)) {
          if (v && v.buffer) sendBody.append(k, new Blob([v.buffer], { type: v.mimeType }), v.filename);
          else sendBody.append(k, String(v));
        }
      }
      res = await guardedFetch(url, { method, headers, body: sendBody, signal: controller.signal });
    } catch (e) {
      // the abort is our timeout; fetch only says "This operation was aborted"
      if (controller.signal.aborted) {
        throw new Error(`request failed: no response within ${timeoutMs} ms (${method} ${url}); `
          + 'the server may just be slow: retry, or raise timeout_ms');
      }
      throw new Error('request failed: ' + errText(e).slice(0, 200));
    } finally {
      clearTimeout(timer);
    }
    const rh = {};
    res.headers.forEach((v, k) => { rh[k.toLowerCase()] = v; });
    return { status: res.status, responseHeaders: rh, finalUrl: res.url,
      rawText: await bodyText(res, method, rh['content-type'], { text: () => res.text(), bytes: () => res.arrayBuffer() }) };
  };

  let { status, rawText, responseHeaders, finalUrl } = await issue();
  // Rate limited: wait (the server's Retry-After, or a backoff) and re-issue, a bounded few times.
  for (let rl = 0; status === 429 && rl < MAX_429_RETRIES; rl++) {
    await sleep(retryAfterMs(responseHeaders['retry-after'], rl));
    ({ status, rawText, responseHeaders, finalUrl } = await issue());
  }
  if (status === 401 && !retried && spec.as && apiAuthMode(normDs(spec.datasource)) === 'login') {
    return runApiCall(spec, session, true); // the cached login token expired — re-login once
  }

  const latency_ms = Date.now() - startedAt;
  const { response_body, truncated } = responseBody(rawText, responseHeaders['content-type'] || responseHeaders['Content-Type']);
  checkExpectStatus(spec.expect_status, status, method, url, rawText);
  const out = { status, latency_ms, headers: sanitizeHeaders(responseHeaders), response_body, truncated, request: { method, url } };
  if (status === 401 && session && spec.auth !== 'page' && session.pageAuth && session.pageAuth(url)) {
    out.note = `this browser's page sends its own Authorization header to ${new URL(url).origin}: add auth: "page" to send it too`;
  }
  // a followed redirect: say where it ended
  if (finalUrl && finalUrl !== url) out.final_url = finalUrl;
  // A relative path on a browser's site: a single-page app answers every unknown path with its own
  // index.html and a 200. Say so (the body is kept: a check may read the page on purpose).
  const relative = session && !normDs(spec.datasource) && !/^https?:\/\//i.test(expandDsFacts(String(spec.url || spec.path || ''), process.env));
  if (relative && status < 400 && /text\/html/i.test(responseHeaders['content-type'] || '')) {
    const apis = session.apiOrigins ? session.apiOrigins() : [];
    out.note = 'this answered with an HTML page, not an API response (a single-page app serves its index for any path)'
      + (apis.length ? `; this browser's page calls its API on ${apis.join(', ')}: use that as url (e.g. url: "${apis[0]}${new URL(url).pathname}")` : '; check the path')
      + '. A token the page keeps in localStorage is sent only with auth: "page".';
  }
  return out;
}


// `expect_status` (a code or a list): the call fails unless the response has it — the only check
// an api_call step inside `act` has. Same rule in the compiled spec (testcase_playwright_compiler)
// and the Lambda runner (api_testcase_runner).
export function checkExpectStatus(expect, status, method, url, rawText = '') {
  if (expect === undefined || expect === null) return;
  const want = (Array.isArray(expect) ? expect : [expect]).map(Number);
  if (want.some((n) => !Number.isInteger(n))) throw new Error('expect_status: an HTTP status code or a list of them, e.g. 200 or [200, 201]');
  if (want.includes(status)) return;
  const err = new Error(`${method} ${url} answered HTTP ${status}, expected ${want.join(' or ')}`
    + (rawText ? ` — body: ${rawText.slice(0, 300)}` : ''));
  Object.assign(err, { matcher: 'status', expected: want.length === 1 ? want[0] : want, actual: status });
  throw err;
}

// A response body as a step result: JSON parsed (int64-exact), whole — a check or a capture reads
// all of it (a 500 KB list was cut to text, so no check could reach its items).
export function responseBody(rawText, contentType = '') {
  // A JSON body labelled text/html or text/plain is still JSON.
  if (String(contentType).includes('json') || /^\s*[[{]/.test(rawText)) {
    try { return { response_body: parseJsonExact(rawText), truncated: false }; } catch { /* keep as text */ }
  }
  return { response_body: rawText, truncated: false };
}

// The api_call tool's reply: a body over `cap` chars shown shortened, still JSON (lists cut to their
// first items), with what was cut. Only what the agent reads — a run's checks get the whole body.
export function shortenForReply(out, cap = API_CALL_BODY_CAP) {
  const body = out.response_body;
  const size = typeof body === 'string' ? body.length : (stringifyExact(body) || '').length;
  if (size <= cap) return out;
  if (typeof body === 'string') {
    return { ...out, response_body: body.slice(0, cap), truncated: `${size} chars, the first ${cap} shown — checks read the whole body` };
  }
  const lists = [];
  const cut = (v, keep, at) => {
    if (Array.isArray(v)) {
      if (v.length > keep) lists.push(`${at || 'response_body'}: ${v.length} items`);
      return v.slice(0, keep).map((x, i) => cut(x, keep, `${at || 'response_body'}.${i}`));
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x, keep, at ? `${at}.${k}` : `response_body.${k}`)]));
    return typeof v === 'string' && v.length > 500 ? v.slice(0, 500) + '…' : v;
  };
  let shown;
  for (const keep of [5, 3, 2, 1]) {
    lists.length = 0;
    shown = cut(body, keep, '');
    if ((stringifyExact(shown) || '').length <= cap) break;
  }
  const text = stringifyExact(shown) || '';
  if (text.length > cap) shown = text.slice(0, cap);
  return { ...out, response_body: shown,
    truncated: `${size} chars, shortened here${lists.length ? ` (${lists.slice(0, 5).join('; ')}; only the first items shown)` : ''}`
      + ' — checks and captures read the whole body; e.g. {"path": "response_body.length", "gt": 0} for a non-empty list' };
}
