# meridian-quality

The check Meridian's **Fleet Health** scores this suite with. It is the same code, at the same pinned versions:
Meridian runs these files, and so can you.

```bash
npm install
npm run quality                 # builds, tests found, lint, score
npx playwright test             # run the suite (fill in .env first, from .env.example)
```

`npm run quality` exits non-zero when the code can't run or declares no test. Add `-- --min-score 75` to fail below a
score too. The full report goes to `test-results/meridian-quality.json`. `.github/workflows/meridian-quality.yml` runs
the same check on every push.

## What is checked

The checker reads the code. It never runs it.

1. **Runs.** TypeScript checks every spec and the files beside it (`flows/`, `pages/`, `auth/`, `fixtures/`). Playwright
   strips types without checking them, so a name that doesn't exist, a missing import or a syntax error only shows up
   when that step runs. Any error of that kind is `BUILD-WONT-RUN` and means the code **won't run**. Other type errors
   are findings (`BUILD-TYPE-ERROR`).
2. **Tests found.** Every spec declares a test (`BUILD-NO-TESTS`). A suite with no test at all has no score.
3. **Lint.** ESLint with `typescript-eslint`, `eslint-plugin-playwright` and Meridian's own rules (`meridian/…`, in
   `check.mjs`). Each hit is reported under its Fleet Health rule. `rules.json` lists every rule with its severity, weight, why it matters
   and how to fix it. One hit is left out on purpose (`exempt` in `rules.json`): a raw locator that only enters a frame,
   `locator('#payment').contentFrame()` — a frame has no user-facing locator; what the code locates inside it is checked.

The checker uses its own TypeScript and ESLint options, never this project's `tsconfig.json` or an ESLint config. So
a config edit can't change the score. `meridian-quality.json` holds your team's rule settings from Governance → Rules
(a rule switched off or its severity changed) and is the only input besides the code. A rule's weight is fixed by
`rules.json`.

Each finding in the report says who fixes it (`fixedBy`). The code inside a step — `m.step('0/s6', 'admin', page => …)`
— is the test case's own, so a finding there is fixed in the test case (`agent`), whatever its rule. Code outside a step
is written by Meridian's compiler: a finding there is the compiler's, unless its rule is about something the test case
decides (a locator, a wait, a missing check).

Meridian's own rules read the code inside a step, which no preset knows is one step of a test case. Each reports once
per step, at the first place:

| Rule | A step that… |
| --- | --- |
| `meridian/no-action-in-check` | checks with `expect(…)` and also acts on the page — clicks, ticks, types or navigates through `page` or a locator taken from it, in the step's own code (not inside a route handler, `evaluate` or an `expect.poll` / `toPass` retry) |
| `meridian/no-dom-read` | runs code inside the page (`evaluate`, `evaluateAll`, `waitForFunction`) — markup, local / session storage — instead of checking what it shows |

A step kept on purpose says so in the code: the line above it reads `// meridian-note: fixed_sleep: <why>`. A finding of
the rule that code accepts is listed as **accepted** and costs nothing.

## The score

| | |
| --- | --- |
| **Gates** | the code runs and declares at least one test. If either fails, the suite is *broken* and gets no number. |
| **Code** | `100 − 100 × penalty ÷ budget`. Penalty = Σ weight × severity multiplier (info 1, warning 2, major 3, critical 4) over the charged findings. Budget = max(tests × 50, 100). Every finding is charged, however often its rule fires in a file. |
| **Overall** | the Code score. Green ≥ 75, amber ≥ 50, red below (or your team's bands). Whether the tests pass when run is not part of it. |
