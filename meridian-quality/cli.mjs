#!/usr/bin/env node
// npm run quality — the Fleet Health check of this suite, the same code Meridian scores it with.
//
//   node meridian-quality/cli.mjs [--json] [--min-score <n>] [--out <file>]
//
// Reads meridian-quality.json (the team's rules) when present. Exits 1 when the code cannot run, declares no test, or
// (with --min-score) scores below it. The full report is written to test-results/meridian-quality.json. The score is
// the code's alone: run results are not part of it (2026-11-13), so an older `--results <file>` is accepted and ignored.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { codeScore, overall } from './score.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const values = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const root = process.cwd();
const settingsPath = path.join(root, 'meridian-quality.json');
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};

const report = await check(root, settings);
const code = codeScore(report, settings);
const head = overall(code, settings);
const result = { overall: head, code: { ...code, findings: undefined }, report };

const out = values('--out')[0] || path.join('test-results', 'meridian-quality.json');
mkdirSync(path.dirname(path.resolve(root, out)), { recursive: true });
writeFileSync(path.resolve(root, out), JSON.stringify(result, null, 2) + '\n');

if (flag('--json')) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  const line = (s = '') => process.stdout.write(s + '\n');
  line(`Meridian quality — checker ${report.toolchain.checker}, rules ${report.toolchain.rules}, TypeScript ${report.toolchain.typescript}, ESLint ${report.toolchain.eslint}`);
  line(`${report.specs} spec${report.specs === 1 ? '' : 's'}, ${report.tests} test${report.tests === 1 ? '' : 's'}, ${report.files.length} files checked in ${report.ms} ms`);
  line();
  line(`  Runs:        ${report.gates.runs.ok ? 'yes' : `NO — ${report.gates.runs.errors} error(s) stop the code running`}`);
  line(`  Tests found: ${report.gates.tests.ok ? report.tests : 'NO'}`);
  line(`  Code:        ${code.score ?? '—'}${code.score != null ? ` (penalty ${code.penalty} of a ${code.budget} budget: ${report.tests} tests × ${code.perTest})` : ''}`);
  line(`  Overall:     ${head.score ?? 'broken'} ${head.band}${head.reasons.length ? ` — ${head.reasons.join('; ')}` : ''}`);
  const shown = code.findings.filter((f) => !f.accepted);
  if (shown.length) line();
  for (const f of shown.slice(0, 200))
    line(`  ${f.severity.padEnd(8)} ${f.ruleId.padEnd(28)} ${f.file}:${f.line}  ${f.message}${f.charged ? '' : f.gate ? '' : '  (not charged)'}`);
  const acc = code.findings.filter((f) => f.accepted);
  if (acc.length) line(`\n  ${acc.length} finding(s) accepted by a step's note (// meridian-note: …)`);
  line(`\nFull report: ${out}`);
}
const min = Number(values('--min-score')[0]);
process.exit(head.status === 'broken' || (Number.isFinite(min) && (head.score ?? 0) < min) ? 1 : 0);
