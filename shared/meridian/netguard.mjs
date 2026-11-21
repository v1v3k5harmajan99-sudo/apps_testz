// Connect-time destination policy for everything the worker dials on a tenant's say-so — the
// `api_call` HTTP client, the `db` pools and the browser (Continuum run 3, f-656300da / f-03a3c6c0 /
// f-b29a4ad3). Loopback, link-local (ECS/EC2 metadata), private, CGNAT and other reserved
// addresses are refused, whatever name leads there; every address a name resolves to must be
// public. Mirrors shared/net_guard.py (the write-time check) — keep the two range lists identical.
// On only where WS_NET_GUARD=1 (the worker image sets it): this file also ships in the exported
// Playwright project (compiler RUNTIME_MODULES), which runs on the customer's machine where
// localhost is fine, and in local sims.
// An in-process check, not a boundary against agent-written run_code (that can open sockets itself);
// the sandbox (shared/core/agent_sandbox.py) is what keeps the task role out of that code's reach.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const on = () => process.env.WS_NET_GUARD === '1';
const NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'metadata.google.internal']);
const SUFFIXES = ['.localhost', '.internal', '.local', '.localdomain'];

function v4Blocked(a, b) {
  return a === 0 || a === 10 || a === 127 || a >= 224                        // this-net, private, loopback, multicast+reserved
    || (a === 100 && b >= 64 && b <= 127)                                     // CGNAT
    || (a === 169 && b === 254)                                               // link-local (metadata)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)         // private
    || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));      // IETF/benchmark
}
export function ipBlocked(ip) {
  ip = String(ip).toLowerCase().split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) ip = mapped[1];
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hexMapped) { const n = (parseInt(hexMapped[1], 16) << 16) | parseInt(hexMapped[2], 16); return v4Blocked((n >>> 24) & 255, (n >>> 16) & 255); }
  if (isIP(ip) === 4) { const [a, b] = ip.split('.').map(Number); return v4Blocked(a, b); }
  if (isIP(ip) === 6) return ip === '::' || ip === '::1' || /^f[cdef]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith('64:ff9b:');
  return true;
}

// resolved verdicts, briefly cached (a page makes many requests to one host)
const verdicts = new Map();
const TTL_MS = 30000;

export async function assertPublicHost(host) {
  if (!on()) return;
  const h = String(host || '').trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const refuse = (why) => { throw new Error(`blocked destination: ${why}`); };
  if (!h) refuse('no host');
  if (NAMES.has(h) || SUFFIXES.some((s) => h.endsWith(s))) refuse(`${h} is an internal name`);
  if (isIP(h)) { if (ipBlocked(h)) refuse(`${h} is a private or reserved address`); return; }
  const hit = verdicts.get(h);
  if (hit && hit.until > Date.now()) { if (hit.bad) refuse(hit.bad); return; }
  let addrs;
  try { addrs = await lookup(h, { all: true }); } catch { return; }          // unresolvable: nothing to reach
  const bad = addrs.find((a) => ipBlocked(a.address));
  const why = bad ? `${h} resolves to a private or reserved address (${bad.address})` : '';
  verdicts.set(h, { until: Date.now() + TTL_MS, bad: why });
  if (why) refuse(why);
}
export const assertPublicUrl = (url) => assertPublicHost(new URL(url).hostname);

// fetch() that checks the destination before every hop, redirects included (a public URL may 302 to
// the metadata address). DNS is checked just before the connect, so a rebind between the two is the
// one window left — the worker's task role is not reachable from the agent's uid anyway (sandbox).
export async function guardedFetch(url, init = {}, maxHops = 10) {
  let cur = url, opts = { ...init, redirect: 'manual' };
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(cur);
    const res = await fetch(cur, opts);
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc || init.redirect === 'manual') return res;
    if (hop >= maxHops) throw new Error('too many redirects');
    cur = new URL(loc, cur).href;
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && opts.method === 'POST')) {
      opts = { ...opts, method: 'GET', body: undefined };
    }
  }
}

// newContext options for a guarded browser: service workers blocked — their fetches never reach context.route, so a
// page could use one to reach a blocked address (pentest PRC-AI-003)
export const guardOptions = () => (on() ? { serviceWorkers: 'block' } : {});

// Browser: refuse every request to a blocked destination (navigation, redirect or subresource).
export async function guardContext(context) {
  if (!on()) return;
  await context.route(/^https?:/i, async (route) => {
    try { await assertPublicUrl(route.request().url()); } catch { return route.abort('blockedbyclient'); }
    return route.fallback();
  });
}
