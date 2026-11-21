// What Fleet Health checks on a compiled Meridian suite — the same code in three places: inside the compiler Lambda
// (Fleet Health's score), in the downloaded / synced project as `npm run quality`, and in that project's GitHub Action.
// It reads files, never runs them:
//
//   1. builds  — TypeScript over the specs and the files beside them (flows/, pages/, auth/, fixtures/). An error that
//                makes the code fail when it runs (an undefined name, a missing module or export, a syntax error) is
//                BUILD-WONT-RUN, a gate; any other type error is BUILD-TYPE-ERROR, a finding.
//   2. tests   — every spec declares a test (BUILD-NO-TESTS); no test at all is a gate.
//   3. lint    — ESLint's, typescript-eslint's and eslint-plugin-playwright's recommended presets (rules.json, written
//                from them by gen-rules.mjs), each finding under its standard rule id with that rule's own docs — plus
//                Meridian's own rules for a step's code (`meridian/…`, below), which no preset can know.
//
// The options are this checker's own, never the project's tsconfig / eslint config: a project cannot change its score by
// editing a config file. A step the test case keeps on purpose says so in the code — the compiler writes its note as a
// `// meridian-note: <code>: <why>` line above it — and a finding of the rule that code accepts is reported as accepted.
//
// Who fixes a finding (`fixedBy`, and `fixable` while it is open) is read off where it sits, not only off its rule: the
// body of an `m.step(…, page => …)` is one browser call of the test case — the Playwright code its author wrote
// (browser_expect / browser_run_code_unsafe) or the action on the locator they named — so ANY rule's finding there is
// the test case's to fix. Outside a step body the code is the compiler's, and only a rule marked `agent` in rules.json
// (a locator, a wait, a missing check: things the test case decides wherever they are written) is the test case's.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import playwright from 'eslint-plugin-playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const RULES_TEXT = readFileSync(path.join(here, 'rules.json'), 'utf8');
export const CATALOG = JSON.parse(RULES_TEXT);
export const RULES = Object.fromEntries(CATALOG.rules.map((r) => [r.id, r]));
export const VERSION = CATALOG.checker;
export const RULES_HASH = createHash('sha256').update(RULES_TEXT).digest('hex').slice(0, 12);

const STEP_WONT_RUN_FIX = 'This step\'s own code uses a name that does not exist (a variable from another step, a helper never defined) or does not parse. Fix the code of that call in the test case.';
// the directories a compiled project keeps its code in, beside the config
const CODE_DIRS = ['suite', 'flows', 'pages', 'auth', 'fixtures'];
const SEVERITIES = ['critical', 'major', 'warning', 'info'];
// Two rules that report ONE fault on the same line — `await expect(response.status).toBe(200)` is both "awaiting a
// value that is not a Thenable" and "an unnecessary await", and one edit clears both. Where the first is reported, the
// second is not charged again on that line (2026-11-15: 21 points for one await, most of a test case's loss).
const SAME_FAULT = [['@typescript-eslint/await-thenable', 'playwright/no-useless-await']];

// TypeScript errors after which the code cannot run as written: a name / module / export that does not exist, or code
// that does not parse. Everything else is a type error the runtime (which strips types) may tolerate.
const FATAL = new Set([2304, 2305, 2306, 2307, 2503, 2552, 2582, 2593, 2613, 2614, 2662, 2663, 2686, 2724, 2792, 18004]);
export const isFatal = (code) => FATAL.has(code) || (code >= 1000 && code < 2000);

export function toolchain() {
  const v = (name) => { try { return require(`${name}/package.json`).version; } catch { return null; } };
  return { checker: VERSION, rules: RULES_HASH, typescript: ts.version, eslint: ESLint.version,
    'typescript-eslint': v('typescript-eslint'), 'eslint-plugin-playwright': v('eslint-plugin-playwright') };
}

// ── settings: the employer's rules (meridian-quality.json in a project) ─────────────────────────────────────────────────
// { rules: {<id>: {enabled?, severity?}}, scoring: {perTest, minBudget, bands: {greenMin, amberMin}} } — every rule is one
//   of rules.json's (custom text rules were removed 2026-11-12). A rule's weight is rules.json's: a team sets whether a
//   rule is on and its severity, not its weight (2026-11-13), so a `weight` in the file is ignored.
export function ruleFor(id, settings) {
  const base = RULES[id];
  const own = settings?.rules?.[id] || {};
  if (!base) return null;
  const severity = SEVERITIES.includes(own.severity) ? own.severity : base.severity;
  // a gate is a fact about the code (it does not run / runs nothing), not a policy: it cannot be switched off
  return { ...base, severity, enabled: base.gate || own.enabled !== false };
}

// The warning codes a step's note names: "brittle_selector: why", "fixed_sleep, forced_action: why", or each with its own
// reason (shared/testcase_checks.py note_codes — the same reading).
export function noteCodes(note) {
  if (typeof note !== 'string') return new Set();
  const out = new Set();
  const lead = note.match(/^\s*((?:[a-z][a-z_]*\s*[:,]\s*)+)/);
  if (lead) for (const m of lead[1].matchAll(/[a-z][a-z_]*/g)) out.add(m[0]);
  for (const m of note.matchAll(/\b([a-z]+_[a-z_]+)\s*:/g)) out.add(m[1]);
  return out;
}

function listFiles(root) {
  const out = [];
  const walk = (d) => {
    let names;
    try { names = readdirSync(d); } catch { return; }
    for (const n of names.sort()) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p);
    }
  };
  for (const d of CODE_DIRS) walk(path.join(root, d));
  if (existsSync(path.join(root, 'playwright.config.ts'))) out.push(path.join(root, 'playwright.config.ts'));
  return out;
}

// A project checked where its packages are not installed (the compiler Lambda's temporary copy) resolves them from the
// checker's own: a link to the node_modules this module was loaded from.
function ensureModules(root) {
  if (existsSync(path.join(root, 'node_modules'))) return;
  const tsDir = path.dirname(require.resolve('typescript/package.json'));
  symlinkSync(path.dirname(tsDir), path.join(root, 'node_modules'), 'dir');
}

export const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true, strict: false, skipLibCheck: true, resolveJsonModule: true, allowJs: false, types: ['node'],
};

const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');

// Which test-case step a line sits in, and the note written above that step (`// meridian-note: …`).
function noteAt(lines, line) {
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const l = lines[i].trimStart();
    if (/^(await m\.(step|block)\(|(if|for|while) \(.*await m\.block\(|const \w+ = await m\.(step|block)\()/.test(l)) {
      const above = (lines[i - 1] || '').trim();
      const m = above.match(/^\/\/ meridian-note: (.*)$/);
      return m ? m[1] : null;
    }
    if (/^(test|setup)\(|^export (async )?function /.test(l)) return null;
  }
  return null;
}

// Is this line the test case's own step code — inside the body of an `m.step(<ref>, <browser>, page => …)`? The compiler
// writes a step on one line, or as a block that closes with `});` at the step's own indent. Anything else — an
// `m.block` (an API / DB / flow call, an if / loop head), the test's frame, a flow function's signature — is not.
export function inStepBody(lines, line) {
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const text = lines[i].trimEnd();
    const l = text.trimStart();
    if (/^(const \w+ = )?await m\.step\(/.test(l)) {
      if (i === line - 1) return true;
      if (!/=>\s*\{$/.test(l)) return false;  // a one-line step above: this line is past it
      const close = `${text.slice(0, text.length - l.length)}});`;
      for (let j = i + 1; j < line - 1; j++) if (lines[j].trimEnd() === close) return false;
      return true;
    }
    if (/\bm\.block\(/.test(l) || /^(test|setup)\(|^export (async )?function /.test(l)) return false;
  }
  return false;
}

function countTests(sf) {
  let n = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const c = node.expression;
      // test.skip('title', fn) declares a test; test.skip() / test.slow() / test.skip(condition, 'why') inside a test's
      // body annotate the one they are in
      const titled = node.arguments.length >= 2 && ts.isStringLiteralLike(node.arguments[0]);
      const name = ts.isIdentifier(c) ? c.text
        : ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === 'test'
          && ['only', 'fixme', 'fail', 'slow', 'skip'].includes(c.name.text) && titled ? 'test' : null;
      if (name === 'test') n++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

// A hit the rule's `exempt` list (rules.json) leaves out:
//   "frame": the raw locator only enters a frame (locator('#pay').contentFrame()), which has no user-facing form; what
//   the code then locates inside it is still checked.
//   "duplicate-prefix": valid-title's "should not have duplicate prefix" — it reads a title that starts with the word
//   "test" as repeating the `test(` it is passed to. A test case's title is its name in Meridian, and "Test Cases search
//   and filters work" names the page under test; the rule's other checks (an empty title, stray spaces) still apply.
function exempt(rule, m, lines) {
  if (rule?.exempt?.includes('duplicate-prefix') && m.messageId === 'duplicatePrefix') return true;
  if (!rule?.exempt?.includes('frame') || !lines || m.endLine == null) return false;
  const after = (lines[m.endLine - 1] || '').slice(m.endColumn - 1) + ' ' + (lines[m.endLine] || '');
  return /^\s*\.\s*contentFrame\(\s*\)/.test(after);
}

// ── Meridian's own rules ────────────────────────────────────────────────────────────────────────────────────────────────
// What the standard presets cannot see in a compiled suite: a step is ONE call of the test case, written as
// `m.step(<ref>, <browser>, page => …)`, and these rules read that callback — the code its author wrote. They are what
// makes a step hard to read back as "what a user does" (2026-11-16: a check that also ticked boxes, looped and read the
// DOM scored 100). Each is a normal ESLint rule; a step that keeps one on purpose says so in its note. Two more were
// removed in 1.2.0 (2026-11-19): no-logic-in-step (a branch is playwright/no-conditional-expect's, and its own fix — the
// test case's if call — was charged there instead; most of its findings were kept by a note) and no-short-timeout
// (never fired on QA).
const ACTIONS = new Set(['click', 'dblclick', 'check', 'uncheck', 'setChecked', 'fill', 'type', 'pressSequentially', 'press',
  'selectOption', 'setInputFiles', 'hover', 'tap', 'dragTo', 'clear', 'goto', 'reload', 'goBack', 'goForward']);
const DOM_READS = new Set(['evaluate', 'evaluateAll', 'evaluateHandle', 'waitForFunction', '$eval', '$$eval']);
const isFn = (n) => n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression');
const isStepCall = (n) => n?.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed
  && n.callee.property.name === 'step' && n.callee.object.type === 'Identifier' && n.callee.object.name === 'm';
// the m.step callback a node sits in (its own code, or a function inside it), or null
function stepFn(node) {
  for (let n = node.parent; n; n = n.parent)
    if (isFn(n) && isStepCall(n.parent) && n.parent.arguments.includes(n)) return n;
  return null;
}
// the nearest function around a node
function ownFn(node) {
  for (let n = node.parent; n; n = n.parent) if (isFn(n) || n.type === 'FunctionDeclaration') return n;
  return null;
}
const method = (call) => (call.callee.type === 'MemberExpression' && !call.callee.computed ? call.callee.property.name : null);
// expect(…), expect.soft(…), expect.poll(…) — the call that starts a check
function isExpect(call) {
  const c = call.callee;
  return (c.type === 'Identifier' && c.name === 'expect')
    || (c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.object.name === 'expect');
}
// Does `expr` come from the step's page — `page`, `page.getByRole(…).first()`, `page.keyboard`, or a variable the step
// set from one of those (`const row = page.getByRole('row')`)? Followed through a few variables, never across functions.
function fromPage(context, expr, fn, depth = 0) {
  const pageName = fn.params[0]?.type === 'Identifier' ? fn.params[0].name : 'page';
  let n = expr;
  for (;;) {
    if (!n) return false;
    if (n.type === 'MemberExpression') n = n.object;
    else if (n.type === 'CallExpression') n = n.callee;
    else if (n.type === 'AwaitExpression' || n.type === 'ChainExpression' || n.type === 'TSNonNullExpression'
      || n.type === 'TSAsExpression') n = n.expression;
    else break;
  }
  if (n.type !== 'Identifier') return false;
  if (n.name === pageName) return true;
  if (depth >= 4) return false;
  for (let scope = context.sourceCode.getScope(n); scope; scope = scope.upper) {
    const v = scope.set.get(n.name);
    if (!v) continue;
    const def = v.defs[0];
    return def?.type === 'Variable' && !!def.node.init && fromPage(context, def.node.init, fn, depth + 1);
  }
  return false;
}
const rule = (description, messages, create) => ({ meta: { type: 'suggestion', docs: { description }, schema: [], messages }, create });

// One finding per step and rule, at its first place: a step that loops is one thing to fix however long its code is
// (charged per line, a 40-line custom step alone took a test case to 0).
const oncePerStep = () => { const seen = new Set(); return (fn) => !seen.has(fn) && !!seen.add(fn); };
const more = (n) => (n > 1 ? ` (${n} places in this step)` : '');

export const meridian = { meta: { name: 'meridian' }, rules: {
  // An action counts when it acts on the page: the call goes through the step's `page` (page.goto, page.getBy…().click,
  // page.keyboard.press) or a variable holding a locator taken from it. Only the step's own code counts, for both sides:
  // `new Array(n).fill(…)`, `seen.clear()` and `localStorage.clear()` inside page.evaluate are not the page acting; an
  // expect inside a page.route handler checks a request, not the page; a reload inside expect.poll / toPass is the check
  // retrying (2026-11-19: each of these was charged as "checks and also acts").
  'no-action-in-check': rule('Disallow actions in a step that also checks',
    { action: 'This step checks with expect(…) and also acts on the page: .{{name}}(){{more}}. A step is one thing a user does or one thing they see.' },
    (context) => {
      const steps = new Map();  // step callback -> {expects, actions}
      return {
        CallExpression(node) {
          const fn = stepFn(node);
          if (!fn || ownFn(node) !== fn) return;
          const s = steps.get(fn) || steps.set(fn, { expects: 0, actions: [] }).get(fn);
          if (isExpect(node)) s.expects++;
          else if (ACTIONS.has(method(node)) && fromPage(context, node.callee.object, fn)) s.actions.push(node);
        },
        'Program:exit'() {
          for (const s of steps.values())
            if (s.expects && s.actions.length)
              context.report({ node: s.actions[0].callee.property, messageId: 'action', data: { name: method(s.actions[0]), more: more(s.actions.length) } });
        },
      };
    }),
  // it is code run inside the page, whatever it touches there: markup, local / session storage, performance entries —
  // the message said "reads its DOM", which an agent reading storage rightly disputed in its note (2026-11-19)
  'no-dom-read': rule('Disallow running code inside the page in a step',
    { dom: '.{{name}}() runs code inside the page instead of checking what it shows: no user sees what it reads or sets there. Check the page with a locator and expect(…).' },
    (context) => {
      const first = oncePerStep();
      return {
        CallExpression(node) {
          const fn = DOM_READS.has(method(node)) && stepFn(node);
          if (fn && first(fn)) context.report({ node: node.callee.property, messageId: 'dom', data: { name: method(node) } });
        },
      };
    }),
} };

// The ESLint config: every rules.json rule with an ESLint setting, at "warn" with its options (severity comes from
// rules.json and the settings, never from ESLint), off when the team switched it off.
function eslintConfig(settings) {
  const rules = {};
  for (const r of CATALOG.rules) {
    if (!r.eslint) continue;
    const opts = Array.isArray(r.eslint) ? r.eslint.slice(1) : [];
    rules[r.id] = ruleFor(r.id, settings).enabled ? ['warn', ...opts] : 'off';
  }
  return rules;
}

/**
 * Check the project at `root`. Returns the report: {toolchain, files, specs, tests, testsByFile, gates, findings, ms}.
 * `settings` — the employer's rules and scoring (meridian-quality.json).
 */
export async function check(root, settings = {}) {
  const t0 = performance.now();
  root = path.resolve(root);
  ensureModules(root);
  const files = listFiles(root);
  const specs = files.filter((f) => /^suite\/.*\.spec\.ts$/.test(rel(root, f)));
  const typesDir = path.dirname(path.dirname(require.resolve('@types/node/package.json')));
  const program = ts.createProgram(files, { ...COMPILER_OPTIONS, typeRoots: [typesDir] });
  const findings = [];
  const fatal = [];
  const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8').split('\n')]));

  // 1. builds
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (d.category !== ts.DiagnosticCategory.Error) continue;
    const file = d.file ? rel(root, d.file.fileName) : '';
    const pos = d.file && d.start != null ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
    const text = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    const row = { ruleId: isFatal(d.code) ? 'BUILD-WONT-RUN' : 'BUILD-TYPE-ERROR', file, line: pos.line + 1,
      column: pos.character + 1, message: `TS${d.code}: ${text}`.slice(0, 400), source: `ts${d.code}` };
    findings.push(row);
    if (row.ruleId === 'BUILD-WONT-RUN') fatal.push(row);
  }

  // 2. tests
  const testsByFile = {};
  for (const f of specs) {
    const sf = program.getSourceFile(f);
    const n = sf ? countTests(sf) : 0;
    testsByFile[rel(root, f)] = n;
    if (!n) findings.push({ ruleId: 'BUILD-NO-TESTS', file: rel(root, f), line: 1, column: 1,
      message: 'This spec declares no test, so it runs nothing.', source: 'meridian' });
  }
  const tests = Object.values(testsByFile).reduce((a, b) => a + b, 0);

  // 3. lint, on the same program (type-aware rules without a second parse)
  const eslint = new ESLint({
    cwd: root, overrideConfigFile: true, errorOnUnmatchedPattern: false,
    overrideConfig: [{
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser, parserOptions: { programs: [program] } },
      plugins: { '@typescript-eslint': tseslint.plugin, playwright, meridian },
      linterOptions: { reportUnusedDisableDirectives: 'off', noInlineConfig: true },
      rules: eslintConfig(settings),
    }, {
      // a setup project (auth/*.setup.ts) signs in and saves the session; it is not a test, so it asserts nothing itself
      files: ['auth/**/*.setup.ts'],
      rules: { 'playwright/expect-expect': 'off' },
    }],
  });
  const results = await eslint.lintFiles(files.map((f) => rel(root, f)));
  for (const r of results) {
    const file = rel(root, r.filePath);
    for (const m of r.messages) {
      if (!m.ruleId) continue;  // a parse error is already a BUILD-WONT-RUN from TypeScript
      const id = RULES[m.ruleId] ? m.ruleId : null;
      if (!id || exempt(RULES[id], m, sources.get(r.filePath))) continue;
      findings.push({ ruleId: id, file, line: m.line, column: m.column, message: m.message.slice(0, 400), source: m.ruleId });
    }
  }

  // what each finding costs, and whether its step keeps it on purpose
  const out = [];
  const seen = new Set();
  const on = (id) => ruleFor(id, settings)?.enabled;
  const at = new Set(findings.map((f) => `${f.ruleId}|${f.file}|${f.line}`));
  const again = (f) => SAME_FAULT.some(([first, second]) => f.ruleId === second && on(first) && at.has(`${first}|${f.file}|${f.line}`));
  for (const f of findings) {
    const key = `${f.ruleId}|${f.file}|${f.line}|${f.column}|${f.message}`;
    if (seen.has(key)) continue;  // two ESLint rules feeding one Fleet Health rule on the same spot
    seen.add(key);
    const rule = ruleFor(f.ruleId, settings);
    if (!rule || !rule.enabled || again(f)) continue;
    const lines = sources.get(path.join(root, f.file)) || [];
    const note = rule.acceptCode ? noteAt(lines, f.line) : null;
    const testLevel = f.ruleId === 'playwright/expect-expect';
    const accepted = !!rule.acceptCode && (noteCodes(note).has(rule.acceptCode)
      || (testLevel && lines.some((l) => { const m = l.trim().match(/^\/\/ meridian-note: (.*)$/); return m && noteCodes(m[1]).has(rule.acceptCode); })));
    // who fixes it: the test case (an agent) when the finding is in a step's own code or its rule is one the test case
    // decides; otherwise the compiler that wrote the line
    const inStep = inStepBody(lines, f.line);
    const byAgent = !!rule.agent || inStep;
    // code that won't run is a compiler bug where the compiler wrote it (rules.json says so) — not in a step's own code
    const fix = f.ruleId === 'BUILD-WONT-RUN' && inStep ? STEP_WONT_RUN_FIX : rule.fix || '';
    out.push({ ...f, severity: rule.severity, weight: rule.weight, gate: !!rule.gate, fix, docs: rule.docs || '',
      accepted, ...(accepted ? { note: (note || '').slice(0, 300) } : {}),
      fixedBy: byAgent ? 'agent' : 'compiler', fixable: !accepted && byAgent });
  }
  const order = (f) => [SEVERITIES.indexOf(f.severity), f.file, f.line];
  out.sort((a, b) => { const x = order(a), y = order(b); return x[0] - y[0] || x[1].localeCompare(y[1]) || x[2] - y[2]; });

  return {
    toolchain: toolchain(),
    files: files.map((f) => rel(root, f)),
    specs: specs.length,
    tests,
    testsByFile,
    gates: {
      runs: { ok: fatal.length === 0, errors: fatal.length },
      tests: { ok: tests > 0, count: tests },
    },
    findings: out,
    ms: Math.round(performance.now() - t0),
  };
}
