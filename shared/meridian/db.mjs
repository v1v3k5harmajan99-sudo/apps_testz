// `db` action/tool — whitelisted, structured row access for one datasource per call, so a DB step
// can run inside an `act` chain alongside browser steps, in strict order — no raw-SQL path,
// table/column NAMES validated against a live INFORMATION_SCHEMA read before use (a value goes
// through the driver's own parameter binding; an identifier can't), and update/delete run inside a transaction and roll back if more than one row would be affected.
// Two engines: mssql (pure-JS `tedious` driver, no native ODBC install needed) and mysql (also
// MariaDB; pure-JS `mysql2`). Each driver is loaded lazily, so nothing pays for it unless `db` is
// used. The SQL differs only in identifier quoting, TOP vs LIMIT and the catalog queries (DIALECTS).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandDsFacts, resolveCredEnvVar } from './env.mjs';
import { assertPublicHost } from './netguard.mjs';

const DB_OPS = ['introspect', 'select', 'count', 'insert', 'update', 'delete'];
const DB_WRITE_OPS = ['insert', 'update', 'delete'];
const DB_READ_OPS = ['introspect', 'select', 'count'];
// Write protection: a mutating op runs only as a login listed in
// BM_DB_WRITABLE_PERSONAS — the username env vars of personas on db datasources whose "Write
// access" is on (shared/ws_agent_env.py). Absent or empty: every database is read-only.
export function dbWriteAllowed(userEnvVar, env = process.env) {  // exported for tests
  const allowed = String(env.BM_DB_WRITABLE_PERSONAS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return allowed.includes(String(userEnvVar || ''));
}
// Per-engine SQL. Each function below takes one (default mssql, so a caller written before mysql
// existed means the same thing). `bind` placeholders come from the caller: "@w0" for mssql, "?"
// for mysql (positional — every query binds in the order its text reads).
export const DIALECTS = {
  mssql: { name: 'mssql', port: 1433, quote: (n) => '[' + String(n).replace(/]/g, ']]') + ']',
    top: (n) => `TOP (${n}) `, limit: () => '' },
  mysql: { name: 'mysql', port: 3306, quote: (n) => '`' + String(n).replace(/`/g, '``') + '`',
    top: () => '', limit: (n) => ` LIMIT ${n}` },
};
// The engine a step runs on: its own `engine` (a value or "$DS_<SLUG>_ENGINE"), else the engine
// fact of the datasource its host names ("$DS_JOOPOS_DB_HOST" -> $DS_JOOPOS_DB_ENGINE), else
// mssql — so a step recorded without `engine` still runs on its datasource's engine.
export function dbEngine(spec, env = process.env) {  // exported for tests
  let e = spec.engine;
  if (e == null || e === '') {
    const m = [spec.host, spec.database].map((v) => /^\$\{?(DS_(?!PERSONA_)[A-Z0-9_]+)_(HOST|DATABASE)\b/.exec(String(v || ''))).find(Boolean);
    e = m ? env[`${m[1]}_ENGINE`] : '';
  } else {
    e = expandDsFacts(String(e), env);
  }
  e = String(e || 'mssql').trim().toLowerCase();
  if (e === 'mariadb') e = 'mysql';
  if (!DIALECTS[e]) throw new Error(`engine ${JSON.stringify(e)} is not supported (mssql or mysql)`);
  return e;
}
// mssql: 'schema.table' ('dbo.leaves'). mysql: a schema IS a database, so a plain 'leaves' means
// the connected database's table ('db.leaves' still works).
function dbSplitTable(table, d = DIALECTS.mssql, database = '') {
  const s = String(table || '');
  const i = s.indexOf('.');
  if (d.name === 'mysql' && i < 0 && s) return [database, s];
  if (i <= 0 || i === s.length - 1) {
    throw new Error(d.name === 'mysql' ? `table must be a table name ('print_jobs') or 'database.table', got ${JSON.stringify(table)}`
      : `table must be 'schema.table' (e.g. 'dbo.leaves'), got ${JSON.stringify(table)}`);
  }
  return [s.slice(0, i), s.slice(i + 1)];
}
// One open pool per exact connection — host, port, database, login AND password — kept open
// (a connect + login per call costs seconds). Never one process-global pool: mssql's sql.connect
// ignores the config once one exists, so a read-only login's write could run with another login's
// rights. A pool is never closed after a call, so a call still running after a timeout can't lose
// its connection to the next one.
const _pools = new Map();     // key -> Promise<ConnectionPool>
const _columns = new Map();   // key|schema.table -> column names (a schema doesn't change mid-run)
const CONN_ERROR_CODES = ['ESOCKET', 'ECONNCLOSED', 'ECONNRESET', 'ETIMEOUT', 'ENOTOPEN', 'ENOCONN'];
export function dbIsConnectionError(e) {  // exported for tests
  return !!e && (CONN_ERROR_CODES.includes(e.code) || MYSQL_CONN_ERROR_CODES.includes(e.code) || e.name === 'ConnectionError');
}
export function dbPoolKey(cfg) {  // exported for tests; hashed so no password sits in a map key
  const parts = [cfg.server, cfg.port, cfg.database, cfg.user, cfg.password];
  if (cfg.engine && cfg.engine !== 'mssql') parts.push(cfg.engine);  // an mssql key stays what it was
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
export async function dbPool(sql, cfg) {  // exported for tests (sql: the mssql module)
  const key = dbPoolKey(cfg);
  let pending = _pools.get(key);
  if (!pending) {
    await assertPublicHost(cfg.server);
    const pool = new sql.ConnectionPool({
      ...cfg, options: { encrypt: true, trustServerCertificate: true }, connectionTimeout: 10000,
      // a socket check, not mssql's default SELECT 1 round trip before every query
      validateConnection: 'socket',
      pool: { max: 10, min: 0, idleTimeoutMillis: 300000 },
    });
    pending = pool.connect().then(() => pool);
    _pools.set(key, pending);
    pending.catch(() => { if (_pools.get(key) === pending) _pools.delete(key); });  // retry on the next call
    if (typeof pool.on === 'function') pool.on('error', () => dbEvict(key, pending));
  }
  return { key, pool: await pending };
}
// mysql: the same one-pool-per-connection rule, as {mysql: <mysql2 promise pool>} so the rest of
// this module can tell the two apart. Types read back like tedious's: DECIMAL a number, a BIGINT
// past 2^53 a string (never a rounded number), DATETIME as UTC.
async function dbMysqlPool(cfg) {
  const key = dbPoolKey(cfg);
  let pending = _pools.get(key);
  if (!pending) {
    await assertPublicHost(cfg.server);
    pending = import('mysql2/promise').then(async ({ default: mysql }) => {
      const pool = mysql.createPool({
        host: cfg.server, port: cfg.port, database: cfg.database, user: cfg.user, password: cfg.password,
        connectTimeout: 10000, connectionLimit: 10, maxIdle: 2, idleTimeout: 300000, enableKeepAlive: true,
        supportBigNumbers: true, bigNumberStrings: false, decimalNumbers: true, timezone: 'Z',
        // a DATE is its YYYY-MM-DD, as the app and a test write it — not a midnight-UTC timestamp (lab v22par6:
        // three failed runs on rows.0.date "2027-04-05T00:00:00.000Z", expected "2027-04-05")
        dateStrings: ['DATE'],
      });
      const conn = await pool.getConnection();  // fail here, like mssql's connect(), not on the first query
      conn.release();
      return { mysql: pool, close: () => pool.end() };
    });
    _pools.set(key, pending);
    pending.catch(() => { if (_pools.get(key) === pending) _pools.delete(key); });
  }
  return { key, pool: await pending };
}
const MYSQL_CONN_ERROR_CODES = ['PROTOCOL_CONNECTION_LOST', 'ECONNREFUSED', 'EPIPE', 'ER_CON_COUNT_ERROR'];
function dbEvict(key, pending) {
  if (_pools.get(key) !== pending) return;
  _pools.delete(key);
  for (const k of [..._columns.keys()]) if (k.startsWith(key + '|')) _columns.delete(k);
  pending.then((p) => p.close()).catch(() => {});
}
export async function closeDbPools() {  // tests; the process's own exit closes the sockets otherwise
  const all = [..._pools.values()];
  _pools.clear();
  _columns.clear();
  await Promise.all(all.map((p) => p.then((pool) => pool.close()).catch(() => {})));
}
async function dbRealColumns(pool, schema, table, key) {
  const cacheKey = key ? `${key}|${schema}.${table}` : null;
  if (cacheKey && _columns.has(cacheKey)) return _columns.get(cacheKey);
  const cols = await dbReadColumns(pool, schema, table);
  if (cacheKey) _columns.set(cacheKey, cols);
  return cols;
}
async function dbReadColumns(pool, schema, table) {
  if (pool.mysql) {
    const [rows] = await pool.mysql.query(
      'SELECT COLUMN_NAME AS COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [schema, table]);
    if (!rows.length) throw new Error(`Table not found: ${schema}.${table}`);
    return rows.map((row) => row.COLUMN_NAME);
  }
  const r = pool.request();
  r.input('schema', schema);
  r.input('table', table);
  const result = await r.query(
    'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@schema AND TABLE_NAME=@table ORDER BY ORDINAL_POSITION');
  const cols = result.recordset.map((row) => row.COLUMN_NAME);
  if (!cols.length) throw new Error(`Table not found: ${schema}.${table}`);
  return cols;
}
// select's "order_by": [{column, direction}] (or one object), up to 3. Without it TOP (n) returns
// whatever order the server picks. Columns are checked against the table's real ones and quoted.
// dbOrderBySql, dbWhereSql, dbReadSql and dbReadResult are also the compiled spec's (it ships this
// module as shared/meridian/db.mjs).
export function dbOrderBySql(orderBy, realColumns, d = DIALECTS.mssql) {  // exported for tests
  if (orderBy == null) return '';
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  if (!list.length) return '';
  if (list.length > 3) throw new Error('order_by takes at most 3 columns');
  const parts = list.map((o) => {
    if (!o || typeof o !== 'object' || typeof o.column !== 'string' || !o.column) {
      throw new Error('order_by is [{"column": "id", "direction": "desc"}] — got ' + JSON.stringify(o));
    }
    const dir = String(o.direction || 'asc').toLowerCase();
    if (dir !== 'asc' && dir !== 'desc') throw new Error(`order_by direction must be "asc" or "desc", not ${JSON.stringify(o.direction)}`);
    return { column: o.column, dir };
  });
  dbValidateColumns(parts.map((p) => p.column), realColumns, 'order_by');
  return ' ORDER BY ' + parts.map((p) => `${d.quote(p.column)} ${p.dir.toUpperCase()}`).join(', ');
}
function dbValidateColumns(requested, real, context) {
  if (!real) return;  // dbShapeProblem: no table to check against
  const unknown = requested.filter((c) => !real.includes(c));
  if (unknown.length) throw new Error(`Unknown column(s) in ${context}: ${unknown.join(', ')}`);
}
// `where`: {column: value} is an exact match, ANDed. On a read
// (select/count) a value may instead be an object of operators, ANDed too: {"gte": "2026-10-01",
// "lt": "2026-11-01"}, {"like": "E2E%"}, {"in": [1, 2]}, {"not": "done"} or {"not": [..]} (NULL
// counts as "not" it), {"is_null": true|false}. A write (update/delete) takes exact values,
// `gt`/`gte`/`in`/`like`, and must be pinned by one of: an exact column, `in` on the table's own
// key (`{"id": {"in": [62, 63]}}` — the rows a run captured or a diff found), or a `like` with at
// least WRITE_LIKE_MIN literal characters (a run's marker: `{"name": {"like": "QA {{uid}}%"}}`).
// `gt`/`gte` alone pin nothing: `{"order_number": "pos_order:7", "stock_id": {"gt": "{{stock_before}}"}}`,
// where ids get reused (2026-10-21). The max_rows guard still bounds what a write touches; an `in`
// on the key defaults it to the list's length (dbWriteMaxRows). `bind(value)` binds a parameter
// and returns its "@name": a value never reaches the SQL text, and an operator is only ever one of
// these fixed words. `table` names the key a write's `in` may pin (without `real`: `id` or `<singular>_id`).
const WRITE_LIKE_MIN = 6;
// literal characters a like pattern pins: not %, _ or an mssql [a-z] / [^0-9] class
const literalChars = (pattern) => String(pattern).replace(/\[[^\]]*\]/g, '').replace(/[%_]/g, '').length;
function writeKeys(table, real) {
  const bare = String(table || '').split('.').pop().toLowerCase();
  if (real) { const k = bare ? keyColumn(bare, real.map((c) => String(c).toLowerCase())) : null; return k ? [k] : []; }
  return bare ? ['id', `${singular(bare)}_id`] : ['id'];
}
export function dbWhereSql(where, real, bind, read, d = DIALECTS.mssql, table = '') {  // exported for tests
  if (where == null) return '';
  if (typeof where !== 'object' || Array.isArray(where)) throw new Error('where is {"column": value, ...}, not ' + JSON.stringify(where));
  const keys = Object.keys(where);
  // QA task ad67a3e3: a spec's finally-cleanup ran with an id its failed run never set — a TypeError deep in here
  const unset = keys.find((k) => where[k] === undefined);
  if (unset) throw new Error(`where "${unset}" is undefined — the value was never set (did the run fail before it was read?); pin the rows by the run's marker instead ("like": "QA {{uid}}%")`);
  dbValidateColumns(keys, real, 'where');
  const cmp = { lt: '<', lte: '<=', gt: '>', gte: '>=', like: 'LIKE' };
  const scalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
  if (!read) {
    const key = writeKeys(table, real);
    const pins = (k) => {
      const v = where[k];
      if (scalar(v)) return true;
      if (!v || Array.isArray(v)) return false;
      return (Array.isArray(v.in) && key.includes(String(k).toLowerCase()))
        || (typeof v.like === 'string' && literalChars(v.like) >= WRITE_LIKE_MIN);
    };
    for (const k of keys) {
      const v = where[k];
      if (!scalar(v) && (Array.isArray(v) || !v || Object.keys(v).some((op) => !['gt', 'gte', 'in', 'like'].includes(op)))) {
        throw new Error(`where "${k}": update/delete take exact values, gt / gte / in / like — not ${JSON.stringify(v)}`);
      }
    }
    if (!keys.some(pins)) {
      throw new Error(`update/delete need a where that pins the rows: an exact column, "${key[0] || 'id'}": {"in": [...]} (the table's key), `
        + `or a like with at least ${WRITE_LIKE_MIN} literal characters (a run's marker: "QA {{uid}}%") — not ${JSON.stringify(where)}`);
    }
  }
  const parts = [];
  for (const k of keys) {
    const col = d.quote(k), v = where[k];
    if (scalar(v)) { parts.push(`${col} = ${bind(v)}`); continue; }
    const ops = Array.isArray(v) ? [] : Object.keys(v);
    if (!ops.length) throw new Error(`where "${k}" is a value or an object of operators (lt, lte, gt, gte, like, in, not, is_null), not ${JSON.stringify(v)}`);
    for (const op of ops) {
      const x = v[op];
      if (op in cmp) {
        if (x === null || !scalar(x) || (op === 'like' && typeof x !== 'string')) throw new Error(`where "${k}": ${op} takes ${op === 'like' ? 'a string pattern ("E2E%")' : 'one value'}, not ${JSON.stringify(x)}`);
        parts.push(`${col} ${cmp[op]} ${bind(x)}`);
      } else if (op === 'in' || (op === 'not' && Array.isArray(x))) {
        if (!Array.isArray(x) || !x.length || x.length > 100 || !x.every((e) => e !== null && scalar(e))) throw new Error(`where "${k}": ${op} takes a list of 1 to 100 values, not ${JSON.stringify(x)}`);
        const list = x.map(bind).join(', ');
        parts.push(op === 'in' ? `${col} IN (${list})` : `(${col} NOT IN (${list}) OR ${col} IS NULL)`);
      } else if (op === 'not') {
        if (!scalar(x)) throw new Error(`where "${k}": not takes one value or a list, not ${JSON.stringify(x)}`);
        parts.push(x === null ? `${col} IS NOT NULL` : `(${col} <> ${bind(x)} OR ${col} IS NULL)`);
      } else if (op === 'is_null') {
        if (typeof x !== 'boolean') throw new Error(`where "${k}": is_null takes true or false, not ${JSON.stringify(x)}`);
        parts.push(`${col} IS ${x ? '' : 'NOT '}NULL`);
      } else {
        throw new Error(`where "${k}": unknown operator ${JSON.stringify(op)} (lt, lte, gt, gte, like, in, not, is_null)`);
      }
    }
  }
  return parts.length ? ' WHERE ' + parts.join(' AND ') : '';
}
// select/count's SQL. `count` is COUNT(*) as "count": one row, or one per distinct group_by (up
// to 3 columns), most first unless order_by (a group_by column or "count") says otherwise. Both
// read one row past `limit` so dbReadResult can say has_more.
export function dbReadSql(spec, real, bind, fq, d = DIALECTS.mssql) {  // exported for tests
  const limit = Math.min(Number(spec.limit) || 25, 100);
  const where = dbWhereSql(spec.where, real, bind, true, d);
  const cnt = d.quote('count');
  if (spec.op === 'count') {
    if (spec.columns != null) throw new Error('count takes group_by, not columns');
    const groupBy = spec.group_by == null ? [] : Array.isArray(spec.group_by) ? spec.group_by : [spec.group_by];
    if (groupBy.length > 3 || !groupBy.every((c) => typeof c === 'string' && c)) throw new Error(`group_by is up to 3 column names, not ${JSON.stringify(spec.group_by)}`);
    dbValidateColumns(groupBy, real, 'group_by');
    if (groupBy.includes('count')) throw new Error('group_by can\'t use a column named "count": the count comes back under that name');
    if (!groupBy.length) {
      if (spec.order_by != null) throw new Error('order_by on a count needs group_by');
      return { text: `SELECT COUNT(*) AS ${cnt} FROM ${fq}${where}`, limit: null };
    }
    const cols = groupBy.map(d.quote).join(', ');
    const order = spec.order_by == null ? ` ORDER BY ${cnt} DESC` : dbOrderBySql(spec.order_by, [...groupBy, 'count'], d);
    return { text: `SELECT ${d.top(limit + 1)}${cols}, COUNT(*) AS ${cnt} FROM ${fq}${where} GROUP BY ${cols}${order}${d.limit(limit + 1)}`, limit };
  }
  if (spec.group_by != null) throw new Error('group_by works on count only');
  const columns = (spec.columns && spec.columns.length) ? spec.columns : real || [];
  dbValidateColumns(columns, real, 'columns');
  return { text: `SELECT ${d.top(limit + 1)}${columns.map(d.quote).join(', ')} FROM ${fq}${where}${dbOrderBySql(spec.order_by, real, d)}${d.limit(limit + 1)}`, limit };
}
// What a db step's shape gets wrong (its op, where, order_by, group_by), or null — the compiler's
// check when a test case is written; whether its columns exist is known only against the table.
export function dbShapeProblem(spec) {
  if (!DB_OPS.includes(spec.op)) return `op is one of ${DB_OPS.join(', ')}, not ${JSON.stringify(spec.op)}`;
  const read = spec.op === 'select' || spec.op === 'count';
  if (spec.order_by != null && !read) return `order_by works on select and count only, not ${spec.op}`;
  try {
    if (read) dbReadSql(spec, null, () => '?', 't');
    else dbWhereSql(spec.where, null, () => '?', false, DIALECTS.mssql, spec.table);
  } catch (e) {
    return e.message;
  }
  return null;
}
export function dbReadResult(rows, limit) {  // exported for tests
  if (limit === null) return { ok: true, rows };
  return rows.length > limit ? { ok: true, rows: rows.slice(0, limit), has_more: true } : { ok: true, rows, has_more: false };
}
// `introspect` — schema + catalog row counts + REAL foreign key constraints only, never row data
// (a structural summary, capped at MAX_TABLES). Past the cap the omitted names come back, and
// `table` (a name or a list, "dbo.users" or "users") introspects just those.
const DB_INTROSPECT_MAX_TABLES = 40;
export async function dbIntrospect(pool, database, only) {  // exported for tests (a fake pool)
  // mysql: only the connected database (its schema), and catalog row counts are InnoDB estimates
  const my = pool.mysql;
  const tablesResult = my
    ? { recordset: (await my.query("SELECT TABLE_SCHEMA AS TABLE_SCHEMA, TABLE_NAME AS TABLE_NAME, TABLE_ROWS AS TABLE_ROWS FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' AND TABLE_SCHEMA=? ORDER BY TABLE_NAME", [database]))[0] }
    : await pool.request().query(
      "SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME");
  let all = tablesResult.recordset.map((r) => ({ schema: r.TABLE_SCHEMA, name: r.TABLE_NAME, rows: r.TABLE_ROWS }));
  if (only) {
    // An MCP client may send the list as a JSON string ('["users","shifts"]') or "users, shifts".
    let names = only;
    if (typeof names === 'string') {
      try { names = names.trim().startsWith('[') ? JSON.parse(names) : names.split(','); } catch { names = [names]; }
    }
    const want = new Set((Array.isArray(names) ? names : [names]).map((t) => String(t).trim().toLowerCase()).filter(Boolean));
    all = all.filter((t) => want.has(t.name.toLowerCase()) || want.has(`${t.schema}.${t.name}`.toLowerCase()));
    if (!all.length) throw new Error(`no table named ${JSON.stringify(only)} — introspect without "table" lists them`);
  }
  const tables = all.slice(0, DB_INTROSPECT_MAX_TABLES);
  const omitted = all.slice(DB_INTROSPECT_MAX_TABLES).map((t) => `${t.schema}.${t.name}`);
  // Two catalog queries for every table at once (not a COUNT(*) scan per table). row_count is the
  // catalog's count (sys.partitions, heap or clustered index): exact once writes settle, and null
  // where the login can't see the table's metadata.
  const key = (schema, name) => `${schema}.${name}`.toLowerCase();
  const byKey = new Map(tables.map((t) => [key(t.schema, t.name), t]));
  for (const t of tables) { t.columns = []; t.row_count = my && t.rows != null ? Number(t.rows) : null; delete t.rows; }
  for (const t of all.slice(DB_INTROSPECT_MAX_TABLES)) delete t.rows;
  if (my) return await dbIntrospectMysql(my, database, all, tables, omitted, byKey);
  const colsResult = await pool.request().query(
    'SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION');
  for (const r of colsResult.recordset) {
    const t = byKey.get(key(r.TABLE_SCHEMA, r.TABLE_NAME));
    if (t) t.columns.push({ name: r.COLUMN_NAME, type: r.DATA_TYPE });
  }
  try {
    const rowsResult = await pool.request().query(`
      SELECT s.name AS table_schema, t.name AS table_name, SUM(p.rows) AS row_count
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
      GROUP BY s.name, t.name`);
    for (const r of rowsResult.recordset) {
      const t = byKey.get(key(r.table_schema, r.table_name));
      if (t) t.row_count = Number(r.row_count);
    }
  } catch { /* no catalog access: counts stay null, the rest still comes back (as the Python original) */ }
  const fkResult = await pool.request().query(`
    SELECT sp.name AS parent_schema, tp.name AS parent_table, cp.name AS parent_column,
           sr.name AS ref_schema, tr.name AS ref_table, cr.name AS ref_column
    FROM sys.foreign_keys fk
    JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id
    JOIN sys.schemas sp ON sp.schema_id = tp.schema_id
    JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
    JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id
    JOIN sys.schemas sr ON sr.schema_id = tr.schema_id
    JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id`);
  const wanted = new Set(tables.map((t) => `${t.schema}.${t.name}`));
  const foreign_keys = fkResult.recordset
    .filter((r) => wanted.has(`${r.parent_schema}.${r.parent_table}`))
    .map((r) => ({ table: `${r.parent_schema}.${r.parent_table}`, column: r.parent_column,
                   ref_table: `${r.ref_schema}.${r.ref_table}`, ref_column: r.ref_column }));
  const out = { engine: 'mssql', database, table_count: all.length, tables, foreign_keys };
  if (omitted.length) {
    out.truncated = true;
    out.omitted_tables = omitted;
    out.note = `showing the first ${tables.length} of ${all.length} tables; pass "table" (a name or a list) to introspect the omitted ones`;
  }
  return out;
}
async function dbIntrospectMysql(my, database, all, tables, omitted, byKey) {
  const key = (schema, name) => `${schema}.${name}`.toLowerCase();
  const [cols] = await my.query(
    'SELECT TABLE_SCHEMA AS TABLE_SCHEMA, TABLE_NAME AS TABLE_NAME, COLUMN_NAME AS COLUMN_NAME, DATA_TYPE AS DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME, ORDINAL_POSITION', [database]);
  for (const r of cols) {
    const t = byKey.get(key(r.TABLE_SCHEMA, r.TABLE_NAME));
    if (t) t.columns.push({ name: r.COLUMN_NAME, type: r.DATA_TYPE });
  }
  const [fks] = await my.query(`
    SELECT TABLE_SCHEMA AS parent_schema, TABLE_NAME AS parent_table, COLUMN_NAME AS parent_column,
           REFERENCED_TABLE_SCHEMA AS ref_schema, REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME IS NOT NULL`, [database]);
  const wanted = new Set(tables.map((t) => `${t.schema}.${t.name}`));
  const foreign_keys = fks
    .filter((r) => wanted.has(`${r.parent_schema}.${r.parent_table}`))
    .map((r) => ({ table: `${r.parent_schema}.${r.parent_table}`, column: r.parent_column,
                   ref_table: `${r.ref_schema}.${r.ref_table}`, ref_column: r.ref_column }));
  const out = { engine: 'mysql', database, table_count: all.length, tables, foreign_keys,
                note: `a table can be named without its database ('${tables[0] ? tables[0].name : 'users'}'); row_count is MySQL's estimate` };
  if (omitted.length) {
    out.truncated = true;
    out.omitted_tables = omitted;
    out.note += `; showing the first ${tables.length} of ${all.length} tables — pass "table" (a name or a list) to introspect the omitted ones`;
  }
  return out;
}
// "datasource": "DS_LAB_DB" (+ "as": a login's DS_PERSONA_… prefix, optional when the datasource has
// one) -> its $DS_…_HOST/PORT/DATABASE facts and the login's userEnvVar/passEnvVar; with no host and
// one database datasource in the run, that one. The recorder writes the full form.
export function expandDbShorthand(spec, env = process.env) {
  if (!spec || typeof spec !== 'object' || spec.host) return spec;
  const dbs = [...new Set(Object.keys(env).map((k) => /^(DS_(?!PERSONA_)[A-Z0-9_]+)_DATABASE$/.exec(k)?.[1]).filter(Boolean))].sort();
  const { datasource, as, ...rest } = spec;
  const pre = datasource ?? (dbs.length === 1 ? dbs[0] : null);
  if (!pre) return spec;
  if (!dbs.includes(pre)) throw new Error(`no database datasource ${JSON.stringify(pre)} in this run (they are: ${dbs.join(', ') || 'none'})`);
  const logins = Object.keys(env).filter((k) => k.startsWith(`DS_PERSONA_${pre.slice(3)}_`) && k.endsWith('_USERNAME'))
    .map((k) => k.slice(0, -'_USERNAME'.length)).sort();
  const who = as ?? (logins.length === 1 ? logins[0] : null);
  if (!who || (!logins.includes(who) && !rest.userEnvVar)) {
    throw new Error(`${pre}: "as" must be one of its logins: ${logins.join(', ') || 'none'}`);
  }
  return { host: `$${pre}_HOST`, ...(env[`${pre}_PORT`] != null ? { port: `$${pre}_PORT` } : {}), database: `$${pre}_DATABASE`,
           userEnvVar: `${who}_USERNAME`, passEnvVar: `${who}_PASSWORD`, ...rest };
}

export async function runDbAction(spec) {
  spec = expandDbShorthand(spec);
  if (!DB_OPS.includes(spec.op)) {
    throw new Error('unknown db op: ' + JSON.stringify(spec.op));
  }
  const engine = dbEngine(spec);
  const d = DIALECTS[engine];
  // the facts to use, named in the error: a guessed "$DS_DATABASE_NAME" ended in a hardcoded host
  const facts = () => Object.keys(process.env).filter((k) => /^DS_(?!PERSONA_)[A-Z0-9_]+_(HOST|PORT|DATABASE)$/.test(k)).sort()
    .map((k) => '$' + k).join(', ') || 'none — the workspace has no database datasource';
  if (!spec.host || !spec.database) throw new Error(`db step needs host and database — this run's database facts: ${facts()}. A $DS_… it names that isn't one of these was renamed: replace_env_var(old, new) fixes every test using it`);
  if (spec.op !== 'introspect' && !spec.table) throw new Error('db step needs table');
  if (spec.order_by != null && spec.op !== 'select' && spec.op !== 'count') throw new Error(`order_by works on select and count only, not ${spec.op}`);
  if (DB_WRITE_OPS.includes(spec.op) && !dbWriteAllowed(spec.userEnvVar)) {
    throw new Error(`db ${spec.op} refused: this database is write-protected (read-only). Only introspect/select/count ` +
      'are allowed — a user can switch on "Write access" on the datasource in the Datasources tab.');
  }
  // "$DS_MSSQL_HOST" etc. — the same datasource facts navigate/open expand
  try {
    spec = { ...spec, host: expandDsFacts(spec.host), database: expandDsFacts(spec.database),
             port: expandDsFacts(spec.port == null ? spec.port : String(spec.port)) };
  } catch (e) {
    throw new Error(`${String(e.message).split(' — ')[0]} — this run's database facts: ${facts()}`);
  }
  // the logins to use, named in the error: a guessed "DS_PERSONA_<persona>_USERNAME" dropped the datasource part
  const logins = () => Object.keys(process.env).filter((k) => /^DS_PERSONA_[A-Z0-9_]+_USERNAME$/.test(k)).sort()
    .map((k) => k.replace(/_USERNAME$/, '_{USERNAME,PASSWORD}')).join(', ') || 'none';
  let user, password;
  try {
    user = resolveCredEnvVar(spec.userEnvVar);
    password = resolveCredEnvVar(spec.passEnvVar);
  } catch (e) {
    throw new Error(`${e.message} — this run's logins: ${logins()}`);
  }
  const cfg = { server: spec.host, port: Number(spec.port || d.port), database: spec.database, user, password };
  // lazy: nothing else here pays for a driver if `db` is unused
  const sql = engine === 'mssql' ? (await import('mssql')).default : null;
  const connect = () => (sql ? dbPool(sql, cfg) : dbMysqlPool({ ...cfg, engine }));
  const { key, pool } = await connect();
  let out;
  try {
    out = await dbRunOn(sql, pool, key, spec, d);
  } catch (e) {
    if (!dbIsConnectionError(e)) throw e;
    // the cached connection died (server restart, network drop): drop it, and reconnect once for a
    // read. A write isn't retried — it may have reached the server before the connection broke.
    dbEvict(key, _pools.get(key));
    if (!DB_READ_OPS.includes(spec.op)) throw e;
    const fresh = await connect();
    out = await dbRunOn(sql, fresh.pool, fresh.key, spec, d);
  }
  // a plain count is a number: check {"path": "count", ...} (rows.0.count still works)
  if (spec.op === 'count' && spec.group_by == null && out.rows && out.rows[0]) out.count = Number(out.rows[0].count);
  return out;
}


async function dbRunOn(sql, pool, key, spec, d = DIALECTS.mssql) {
  if (spec.op === 'introspect') {
    return await dbIntrospect(pool, spec.database, spec.table);
  }
  const [schema, table] = dbSplitTable(spec.table, d, spec.database);
  const realColumns = await dbRealColumns(pool, schema, table, key);
  const fq = `${d.quote(schema)}.${d.quote(table)}`;
  const db = pool.mysql ? mysqlRunner(pool.mysql) : mssqlRunner(sql, pool);
  if (spec.op === 'select' || spec.op === 'count') {
    let q;
    const r = await db.query((bind) => (q = dbReadSql(spec, realColumns, bind, fq, d)).text);
    return dbReadResult(r.rows, q.limit);
  }
  if (spec.op === 'insert') {
    const values = spec.values || {};
    const cols = Object.keys(values);
    if (!cols.length) throw new Error('values is required');
    dbValidateColumns(cols, realColumns, 'values');
    const r = await db.query((bind) => `INSERT INTO ${fq} (${cols.map((c) => d.quote(c)).join(', ')}) `
      + `VALUES (${cols.map((k) => bind(values[k])).join(', ')})`);
    return { ok: true, rows_affected: r.affected, ...(r.insertId ? { insert_id: r.insertId } : {}) };
  }
  if (spec.op === 'update' || spec.op === 'delete') {
    const max = spec.max_rows == null ? dbWriteMaxRows(spec, realColumns) : Number(spec.max_rows);
    if (!Number.isInteger(max) || max < 1) throw new Error(`max_rows is a whole number of rows (1 or more), not ${JSON.stringify(spec.max_rows)}`);
    const r = await db.tx((bind, output) => dbWriteSql(spec, realColumns, fq, d, bind, output), max);
    return { ok: true, rows_affected: r.affected };
  }
}
// A write's default row cap: 1, or the length of an `in` list on the table's own key — deleting
// the ids a run captured is exactly that many rows.
export function dbWriteMaxRows(spec, real) {  // exported for tests
  const key = writeKeys(spec.table, real);
  const lists = Object.entries(spec.where || {}).filter(([k, v]) => key.includes(String(k).toLowerCase()) && v && Array.isArray(v.in));
  return lists.length ? Math.max(1, Math.min(...lists.map(([, v]) => v.in.length))) : 1;
}
function dbTooManyRows(n, max = 1) {
  return `This would have affected ${n} rows — refusing and rolling back. Narrow "where" to match ${max === 1 ? 'exactly one row'
    : `at most ${max} rows`}, or say how many it may touch: "max_rows": ${n}. A test's own rows: pin the run's {{uid}} marker, `
    + 'or the id of its own record read by that marker (an order\'s lines by order_id) — then up to 50 by default.';
}
// update/delete's SQL (both engines): exact-match where, required and non-empty. `output` goes
// right before WHERE (mssql's OUTPUT … INTO clause, see mssqlRunner).
function dbWriteSql(spec, realColumns, fq, d, bind, output = '') {
  if (!spec.where || !Object.keys(spec.where).length) throw new Error('where is required and must be non-empty');
  if (spec.op === 'delete') return `DELETE FROM ${fq}${output}${dbWhereSql(spec.where, realColumns, bind, false, d, spec.table)}`;
  const set = spec.set || {};
  const setKeys = Object.keys(set);
  if (!setKeys.length) throw new Error('set is required');
  dbValidateColumns(setKeys, realColumns, 'set');
  const setSql = setKeys.map((k) => `${d.quote(k)} = ${bind(set[k])}`).join(', ');
  return `UPDATE ${fq} SET ${setSql}${output}${dbWhereSql(spec.where, realColumns, bind, false, d, spec.table)}`;
}
// One query per engine: build(bind) writes the SQL, bind(value) a placeholder for that value —
// "@p0" bound by name (mssql), "?" in the order the text reads (mysql). tx runs it in a
// transaction that rolls back when it touched more than one row.
async function inTx(begin, run, commit, rollback, max = 1) {
  await begin();
  try {
    const r = await run();
    if (r.affected > max) throw new Error(dbTooManyRows(r.affected, max));
    await commit();
    return r;
  } catch (e) {
    try { await rollback(); } catch {}
    throw e;
  }
}
// mssql's DATE columns as YYYY-MM-DD, like mysql's dateStrings (tedious reads a DATE as a Date at midnight UTC)
function dateColumnsAsText(rows) {
  const cols = Object.values(rows?.columns ?? {}).filter((c) => String(c?.type?.declaration ?? '').toLowerCase() === 'date')
    .map((c) => c.name);
  if (!cols.length) return rows;
  for (const row of rows) for (const c of cols) if (row[c] instanceof Date) row[c] = row[c].toISOString().slice(0, 10);
  return rows;
}
function mssqlRunner(sql, pool) {
  const run = async (req, build) => {
    let n = 0;
    const r = await req.query(build((v) => { req.input(`p${n}`, v); return `@p${n++}`; }));
    return { rows: dateColumnsAsText(r.recordset), affected: r.rowsAffected[0] };
  };
  // A write's own row count: rowsAffected also counts every statement a trigger runs (its
  // first entry can be the trigger's), so the one-row guard read 1 for a delete that removed 5
  // (R6-TC-1). OUTPUT … INTO a table variable (allowed on tables with triggers, unlike a bare
  // OUTPUT) counts exactly the rows this statement touched.
  const runWrite = async (req, build) => {
    let n = 0;
    const stmt = build((v) => { req.input(`p${n}`, v); return `@p${n++}`; }, ' OUTPUT 1 INTO @meridian_rows');
    const r = await req.query(`DECLARE @meridian_rows TABLE (x int); ${stmt}; SELECT COUNT(*) AS n FROM @meridian_rows;`);
    const sets = r.recordsets || [];
    return { rows: [], affected: Number(sets[sets.length - 1][0].n) };
  };
  return {
    query: (build) => run(pool.request(), build),
    tx: (build, max) => {
      const tx = new sql.Transaction(pool);
      return inTx(() => tx.begin(), () => runWrite(new sql.Request(tx), build), () => tx.commit(), () => tx.rollback(), max);
    },
  };
}
function mysqlRunner(my) {
  const run = async (conn, build) => {
    const params = [];
    const [res] = await conn.query(build((v) => { params.push(v); return '?'; }), params);
    return Array.isArray(res) ? { rows: res.map((r) => ({ ...r })) } : { affected: res.affectedRows, insertId: res.insertId };
  };
  return {
    query: (build) => run(my, build),
    tx: async (build, max) => {
      const conn = await my.getConnection();
      try {
        return await inTx(() => conn.beginTransaction(), () => run(conn, build), () => conn.commit(), () => conn.rollback(), max);
      } finally {
        conn.release();
      }
    },
  };
}

// ── rows a run leaves behind (testcase_run's evidence for a test case that writes data) ──
// The tables of a recipe that writes data (a creates_data phase or a db write): every db spec's
// connection + table. Python's testcases_mcp._leftover_targets reads a recipe the same way.
const CONN_KEYS = ['engine', 'host', 'port', 'database', 'userEnvVar', 'passEnvVar'];
export function leftoverTargets(tc) {
  const specs = [];
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    if (x.tool === 'db' && x.args) specs.push(x.args);
    else if (!x.tool && x.db && typeof x.db === 'object') specs.push(x.db);
    Object.values(x).forEach(walk);
  };
  walk(tc.phases || []);
  const writes = (tc.phases || []).some((p) => p && p.creates_data) || specs.some((s) => DB_WRITE_OPS.includes(s.op));
  const bare = (t) => String(t || '').split('.').pop().toLowerCase();
  const written = new Set(specs.filter((s) => DB_WRITE_OPS.includes(s.op)).map((s) => bare(s.table)));
  const out = new Map();
  for (const s of writes ? specs : []) {
    if (!s.table || s.op === 'introspect' || /\$\{/.test(JSON.stringify(s))) continue;
    if (!written.has(bare(s.table)) && appendOnly(s).has(bare(s.table))) continue;
    const t = { conn: Object.fromEntries(CONN_KEYS.filter((k) => s[k] != null).map((k) => [k, s[k]])), table: s.table };
    out.set(JSON.stringify(t), t);
  }
  return [...out.values()];
}
// the tables a db spec's datasource lists as append-only (an audit log, catalog.py
// append_only_tables): their new rows are the app's record of the run. ws_agent_env.append_only_tables.
// One marked this session (testcases mark_append_only_table) is in .meta/append-only.json.
export function appendOnly(spec) {  // exported for testcase_run's weak-check notes
  const m = /^\$(DS_(?!PERSONA_)[A-Z0-9_]+)_HOST$/.exec(String(spec.host || ''));
  let marked = {};
  try { marked = JSON.parse(readFileSync(join(process.env.WS_TESTCASE_DIR || '', '.meta', 'append-only.json'), 'utf8')); } catch { /* none marked */ }
  const name = m ? `${m[1]}_APPEND_ONLY_TABLES` : '';
  const text = m ? marked[name] ?? process.env[name] ?? '' : '';
  return new Set([...text.matchAll(/(?:^|,)\s*([\w.]+)/g)].map((x) => x[1].split('.').pop().toLowerCase()));
}
// A table's key: `id`, else `<singular>_id` (stocks.stock_id). A child table links to a parent by
// a `<singular parent>_id` column (table_orders.order_id → orders). testcases_mcp mirrors these.
export const singular = (n) => (n.endsWith('ies') ? `${n.slice(0, -3)}y` : n.endsWith('s') ? n.slice(0, -1) : n);
export const keyColumn = (table, cols) => (cols.includes('id') ? 'id' : cols.includes(`${singular(table)}_id`) ? `${singular(table)}_id` : null);
// {bare table name: {name to query, columns}} for one connection. introspect caps a call at 40 tables,
// so it asks again for what each call left out (Joopium POS has 86 — one follow-up missed some).
async function schemaColumns(conn) {
  const first = await runDbAction({ ...conn, op: 'introspect' });
  const tables = [...(first.tables || [])];
  let left = [...(first.omitted_tables || [])];
  for (let i = 0; i < 10 && left.length; i++) {
    const more = await runDbAction({ ...conn, op: 'introspect', table: left.slice(0, 40) });
    if (!(more.tables || []).length) break;
    tables.push(...more.tables);
    const seen = new Set(tables.map((t) => t.name.toLowerCase()));
    left = [...left.slice(40), ...(more.omitted_tables || [])].filter((t) => !seen.has(String(t).split('.').pop().toLowerCase()));
  }
  return new Map(tables.map((t) => [t.name.toLowerCase(), {
    name: first.engine === 'mssql' ? `${t.schema}.${t.name}` : t.name, columns: (t.columns || []).map((c) => c.name.toLowerCase()) }]));
}
const newestKey = async (conn, table, key) => {
  const r = await runDbAction({ ...conn, op: 'select', table, columns: [key], order_by: [{ column: key, direction: 'desc' }], limit: 1 });
  return r.rows && r.rows[0] ? r.rows[0][key] : 0;
};
// Each target's key and newest key value, plus the child tables that link to a target. A target
// whose table has no key column is left out. A child is only checked for rows its parent lost:
// the app writes them for this flow (a table booking, a loyalty row) and a parallel run's still
// have their parent.
export async function newestIds(targets) {
  const out = new Map();
  const schemas = new Map();
  for (const t of targets) {
    const ck = JSON.stringify(t.conn);
    if (!schemas.has(ck)) schemas.set(ck, await schemaColumns(t.conn).catch(() => null));
    const cols = schemas.get(ck)?.get(t.table.split('.').pop().toLowerCase())?.columns;
    const key = cols ? keyColumn(t.table.split('.').pop().toLowerCase(), cols) : 'id';
    if (!key) continue;
    try { out.set({ ...t, key }, await newestKey(t.conn, t.table, key)); } catch { /* no access: nothing to compare */ }
  }
  const parents = [...out.keys()];
  for (const [ck, schema] of schemas) {
    if (!schema) continue;
    const named = new Set(targets.filter((t) => JSON.stringify(t.conn) === ck).map((t) => t.table.split('.').pop().toLowerCase()));
    for (const [bare, { name, columns }] of schema) {
      const key = keyColumn(bare, columns);
      if (!key || named.has(bare)) continue;
      for (const p of parents.filter((x) => JSON.stringify(x.conn) === ck)) {
        if (appendOnly(p.conn).has(bare)) continue;  // an audit log links to what it records: the app's, not the test's
        const link = `${singular(p.table.split('.').pop().toLowerCase())}_id`;
        if (link === key || !columns.includes(link)) continue;
        try { out.set({ conn: p.conn, table: name, key, link, parent: p }, await newestKey(p.conn, name, key)); } catch { /* skip */ }
      }
    }
  }
  return out;
}
// leftoverRows' rows split by whose they are: `mine` hold this run's {{uid}}, or link to a row that
// does (`<singular table>_id` = its key: an order's items, their add-ons); `other` hold neither — an
// audit/child row this run wrote without its marker, or another user's row written meanwhile
// (2026-10-21: a failed run dropped its own order items; a passing one would flag a teammate's rows).
// {table, row} each, as leftoverRows' callers show them.
export function splitByRun(rows, uid) {
  const bare = (t) => String(t).split('.').pop().toLowerCase();
  const mine = new Set(uid ? rows.filter((r) => r.row.includes(uid)) : []);
  for (let grew = true; grew;) {
    grew = false;
    // (a whole-name link like `order_id` may in theory meet another system's new row with the same
    // number during the run: these are only rows the run's window added)
    // a parent `online_orders` links a child by `online_order_id`, or by a shorter tail of its name
    // (`order_id`, `order_items_id` — plural too) from a table sharing the cut prefix
    // (`online_order_items.order_id`) — never another table's `order_id`
    const links = [...mine].map((r) => {
      const cols = [];
      for (const v of new Set([bare(r.table), singular(bare(r.table))])) {
        const w = v.split('_');
        for (let i = 0; i < w.length; i++) cols.push({ col: `${w.slice(i).join('_')}_id`, prefix: i ? `${w.slice(0, i).join('_')}_` : '' });
      }
      return { id: String(r.data ? r.data[r.key] : ''), cols };
    });
    for (const r of rows) {
      if (mine.has(r) || !r.data) continue;
      const links_to = (l) => l.id !== '' && l.cols.some(({ col, prefix }) => bare(r.table).startsWith(prefix)
        && Object.hasOwn(r.data, col) && String(r.data[col]) === l.id);
      if (links.some(links_to)) { mine.add(r); grew = true; }
    }
  }
  const shown = (r) => ({ table: r.table, row: r.row });
  return { mine: rows.filter((r) => mine.has(r)).map(shown), other: rows.filter((r) => !mine.has(r)).map(shown) };
}
export async function leftoverRows(before) {
  const left = [];
  for (const [t, start] of before) {
    try {
      if (!t.parent) {
        const r = await runDbAction({ ...t.conn, op: 'select', table: t.table, where: { [t.key || 'id']: { gt: start } }, limit: 50 });
        for (const row of r.rows || []) left.push({ table: t.table, row: JSON.stringify(row).slice(0, 300), data: row, key: t.key || 'id' });
        continue;
      }
      const r = await runDbAction({ ...t.conn, op: 'select', table: t.table, where: { [t.key]: { gt: start }, [t.link]: { gt: before.get(t.parent) } }, limit: 50 });
      const ids = [...new Set((r.rows || []).map((row) => row[t.link]))];
      if (!ids.length) continue;
      const alive = await runDbAction({ ...t.conn, op: 'select', table: t.parent.table, columns: [t.parent.key], where: { [t.parent.key]: { in: ids } }, limit: 50 });
      const kept = new Set((alive.rows || []).map((row) => String(row[t.parent.key])));
      for (const row of r.rows || []) if (!kept.has(String(row[t.link]))) left.push({ table: t.table, row: JSON.stringify(row).slice(0, 300), data: row, key: t.key });
    } catch { /* as above */ }
  }
  return left;
}
