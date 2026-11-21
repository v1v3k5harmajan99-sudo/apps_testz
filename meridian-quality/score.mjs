// The Fleet Health score of a compiled suite, from a check report (check.mjs). Pure: no file,
// no network — the same function scores in Fleet Health and in `npm run quality`, so the number a team gets on its own
// machine is the number Meridian shows.
//
//   gates        the code runs (no BUILD-WONT-RUN) and declares at least one test. A failed gate is "broken": no number.
//   code         100 − 100 × penalty ÷ budget. penalty = Σ weight × severity multiplier over the charged findings;
//                budget = max(tests × perTest (50), minBudget (100)). A finding a step keeps on purpose (its note in the code) is not charged;
//                every other finding is charged, however many times its rule fires in a file (no per-file cap since 2026-11-13).
//   headline     the code score, banded green / amber / red (run results — Reliability — are not part of it since 2026-11-13).

export const SEVERITY_MULTIPLIER = { info: 1, warning: 2, major: 3, critical: 4 };
export const DEFAULTS = { perTest: 50, minBudget: 100, bands: { greenMin: 75, amberMin: 50 } };

export function scoring(settings) {
  const s = settings?.scoring || {};
  const num = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  return {
    perTest: num(s.perTest, DEFAULTS.perTest),
    minBudget: num(s.minBudget, DEFAULTS.minBudget),
    bands: { greenMin: num(s.bands?.greenMin, DEFAULTS.bands.greenMin), amberMin: Number.isFinite(s.bands?.amberMin) ? s.bands.amberMin : DEFAULTS.bands.amberMin },
  };
}

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
export const penaltyOf = (f) => Math.max(0, Math.min(10, Number(f.weight) || 0)) * (SEVERITY_MULTIPLIER[f.severity] ?? 2);

export function band(score, bands = DEFAULTS.bands) {
  if (score == null) return 'unscored';
  return score >= bands.greenMin ? 'healthy' : score >= bands.amberMin ? 'watch' : 'attention';
}

/** Which findings are charged: every one that is not accepted, not a gate and costs something. Marks each `charged`. */
export function charge(findings) {
  return findings.map((f) => ({ ...f, charged: !f.accepted && !f.gate && penaltyOf(f) > 0 }));
}

/** The code score of a check report. */
export function codeScore(report, settings) {
  const cfg = scoring(settings);
  const reasons = [];
  if (!report.gates.runs.ok) reasons.push(`${report.gates.runs.errors} error${report.gates.runs.errors === 1 ? '' : 's'} that stop the code running`);
  if (!report.gates.tests.ok) reasons.push('no test is declared');
  const findings = charge(report.findings);
  const charged = findings.filter((f) => f.charged);
  const penalty = charged.reduce((a, f) => a + penaltyOf(f), 0);
  const budget = Math.max(cfg.minBudget, report.tests * cfg.perTest);
  const byRule = {};
  for (const f of findings) {
    const r = byRule[f.ruleId] ||= { ruleId: f.ruleId, severity: f.severity, occurrences: 0, charged: 0, accepted: 0, penalty: 0 };
    r.occurrences++;
    if (f.accepted) r.accepted++;
    if (f.charged) { r.charged++; r.penalty += penaltyOf(f); }
  }
  const rules = Object.values(byRule).map((r) => ({ ...r, points: Math.round((100 * r.penalty / budget) * 10) / 10 }))
    .sort((a, b) => b.points - a.points || a.ruleId.localeCompare(b.ruleId));
  // a spec on its own: its findings (and those in the flows / pages it imports are the suite's, not its) over its tests
  const perFile = {};
  for (const [file, tests] of Object.entries(report.testsByFile || {})) {
    const p = charged.filter((f) => f.file === file).reduce((a, f) => a + penaltyOf(f), 0);
    perFile[file] = tests ? clamp(100 - 100 * p / Math.max(cfg.minBudget, tests * cfg.perTest)) : null;
  }
  const broken = reasons.length > 0;
  const score = broken ? null : clamp(100 - 100 * penalty / budget);
  return {
    status: broken ? 'broken' : 'ok', reasons, score, band: broken ? 'broken' : band(score, cfg.bands),
    penalty, budget, perTest: cfg.perTest, tests: report.tests, findings,
    charged: charged.length, uncharged: findings.filter((f) => !f.charged && !f.accepted && !f.gate).length,
    accepted: findings.filter((f) => f.accepted).length, rules, perFile,
  };
}

/** The headline: the code score (no number when a gate failed). */
export function overall(code, settings) {
  const cfg = scoring(settings);
  if (code.status === 'broken')
    return { status: 'broken', score: null, band: 'broken', limitedBy: 'build', reasons: code.reasons };
  return { status: 'ok', score: code.score, band: band(code.score, cfg.bands), limitedBy: 'code', reasons: [] };
}
