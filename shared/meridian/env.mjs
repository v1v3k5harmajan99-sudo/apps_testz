// What a call may read from this process's environment: a persona's credential (by env var name,
// never by value) and a datasource's non-secret connection facts. Pure — no Playwright.

export const PERSONA_PREFIX = 'DS_PERSONA_';

// The caller names WHICH env var holds a credential, never the credential itself, so a secret is
// never passed as an argument, logged in a step summary, or seen by whatever drives this tool.
// Allowlisted prefix only: this process also inherits its spawner's environment (PATH, but also
// secrets like MCP_KEY), which a prompt-injected agent could otherwise type into a visible field
// and screenshot. Used by fill/type, `db` (userEnvVar/passEnvVar) and `api_call` (a header's or a
// body value's `envVar`).
export function resolveCredEnvVar(envVar, env = process.env) {
  if (!envVar || !String(envVar).startsWith(PERSONA_PREFIX)) {
    throw new Error(`envVar must start with "${PERSONA_PREFIX}" (got ${JSON.stringify(envVar)})`);
  }
  const val = env[envVar];
  if (val === undefined) throw new Error(`envVar ${JSON.stringify(envVar)} is not set`);
  return val;
}


// A URL may name a datasource's NON-secret connection fact as `$DS_<SLUG>_<FIELD>` (e.g.
// "$DS_SAUCEDEMO_URL/inventory.html") — the exact form a recorded test case uses, and which
// a run resolves on replay (ws_agent_env.datasource_fact_env sets them), so
// live `open`/`navigate` calls accept it too.
// DS_PERSONA_* (credentials) is never expanded into a URL: it would end up in page history,
// traces and logs.
export function expandDsFacts(url, env = process.env) {
  if (typeof url !== 'string' || !url.includes('$DS_')) return url;
  return url.replace(/\$(DS_[A-Z0-9_]+)/g, (m, name) => {
    if (name.startsWith(PERSONA_PREFIX)) {
      throw new Error(`${m} is a credential — it can't go in a URL`);
    }
    const val = env[name];
    if (val === undefined) throw new Error(`${m} is not set — use the datasource's URL from your brief`);
    return val.replace(/\/+$/, '');
  });
}

// A value that names a datasource fact (`"$DS_SITE_COMPANY_CODE"`), filled in (discover.mjs's login
// body); a credential is refused — it goes by "envVar". A URL fact loses its trailing slash.
export function expandDsValue(value, env = process.env) {
  if (typeof value !== 'string' || !value.includes('$DS_')) return value;
  return value.replace(/\$(DS_[A-Z0-9_]+)/g, (m, name) => {
    if (name.startsWith(PERSONA_PREFIX)) throw new Error(`${m} is a credential — pass it as "envVar": "${name}" instead of "value"`);
    const val = env[name];
    if (val === undefined) throw new Error(`${m} is not set — use the datasource's value from your brief`);
    return /_(URL|ROOT)$/.test(name) ? val.replace(/\/+$/, '') : val;
  });
}
