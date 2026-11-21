// Types of the runtime compiled specs call (rt.mjs), so TypeScript checks a spec's Playwright code: a step's `page` is a
// Playwright Page, and a call on it that does not exist is an error before the test ever runs (Fleet Health's
// BUILD-WONT-RUN / BUILD-TYPE-ERROR — meridian-quality/check.mjs). Shipped beside rt.mjs as shared/meridian/rt.d.mts.
// Keep it in step with rt.mjs: a method added there and not here is "does not exist" in every spec that calls it.
import type { Browser, BrowserContext, Expect, Locator, Page, TestInfo } from '@playwright/test';

export declare const ACTION_TIMEOUT_MS: number;
export declare const expect: Expect<{}>;
export declare const STOP: Error;
export declare const SETUP_KEYS: string[];

export declare function trackPage(page: Page): Page;
export declare function settle(page: Page, max?: number): Promise<void>;
export declare function settleDom(page: Page, max?: number): Promise<void>;
export declare function settleUrl(page: Page): Promise<void>;
export declare function contextSetup(setup?: Record<string, unknown>): Record<string, unknown>;
export declare function seedContext(context: BrowserContext, setup?: Record<string, unknown>, url?: string): Promise<void>;
export declare function getPath(value: unknown, path: string): any;
export declare function splitDefault(path: string): [string, string | undefined];

type Maybe<T> = T | Promise<T>;
type Target = Locator | Page;
type Matcher = 'text' | 'contains_text' | 'regex' | 'equals' | string;
type Timeout = { timeout?: number };

export declare class Meridian {
  constructor(opts?: {
    browser?: Browser | null; info?: TestInfo | null; slug?: string; steps?: Record<string, [string | null, string | null]>;
    timeout?: number; record?: boolean; report?: 'call' | 'phase'; sessions?: unknown;
  });
  /** captures, loop rows and the run's uid, by name */
  v: Record<string, any>;
  pages: Record<string, Page>;
  contexts: Record<string, BrowserContext>;
  timeout: number;

  // steps and phases
  step<T>(ref: string, browser: string, fn: (page: Page) => Maybe<T>): Promise<T>;
  step<T>(ref: string, fn: () => Maybe<T>, timeout?: number, retry?: boolean): Promise<T>;
  block<T>(ref: string, fn: () => Maybe<T>): Promise<T>;
  phase(i: number, name: string, fn: () => Maybe<unknown>, opts?: { always?: boolean; pass?: boolean }): Promise<void>;
  end(): Promise<void>;
  parallel(...chains: Array<() => Promise<unknown>>): Promise<void>;
  shoot(label: string): Promise<void>;
  quickly<T>(attempt: () => Promise<T>): Promise<T>;
  watched(): Promise<Page[]>;
  present(one: Locator, verb: string): Promise<void>;

  // browsers and pages
  open(id: string, url: string | null, opts?: { record?: boolean; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
    setup?: Record<string, unknown>; fresh?: boolean; state?: unknown }): Promise<Page>;
  goto(page: Page, url: string, waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit', settleAfter?: boolean): Promise<void>;
  close(id: string): Promise<void>;
  closeAll(): Promise<void>;
  popup(id: string, opener: Page, act: () => Maybe<unknown>): Promise<Page>;
  loaded(page: Page): Promise<void>;
  settleAll(): Promise<void>;
  signIn(id: string, name: string, full: () => Maybe<unknown>, proof?: (page: Page) => Maybe<unknown>): Promise<void>;
  saveSession(id: string, name: string): Promise<void>;

  // actions
  one(loc: Locator): Locator;
  guess(root: Target, text: string, timeout?: number): Promise<Locator>;
  clickText(root: Target, text: string, opts?: Record<string, unknown>): Promise<void>;
  click(loc: Locator, opts?: { optional?: boolean; force?: boolean; timeout?: number; button?: 'left' | 'right' | 'middle';
    clickCount?: number; modifiers?: Array<'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift'> }): Promise<void>;
  unset(name: string): void;
  fill(loc: Locator, value: string, opts?: Timeout): Promise<void>;
  type(target: Target, text: string, opts?: { delay?: number; timeout?: number }): Promise<void>;
  press(target: Target, key?: string, opts?: Timeout): Promise<void>;
  select(loc: Locator, value: string | string[], opts?: Timeout): Promise<void>;
  hover(loc: Locator, opts?: { force?: boolean; timeout?: number }): Promise<void>;
  drag(from: Locator, to: Locator, opts?: Timeout): Promise<void>;
  upload(loc: Locator, file: string | string[], opts?: Timeout): Promise<void>;
  scroll(target: Target, dx?: number, dy?: number, opts?: Timeout): Promise<void>;
  waitFor(loc: Locator, state?: 'attached' | 'detached' | 'visible' | 'hidden', opts?: Timeout): Promise<void>;
  dialog(page: Page, mode?: 'accept' | 'dismiss', promptText?: string): void;
  disarm(...pages: Page[]): void;
  route(page: Page, opts: { url: string | RegExp; status?: number; body?: unknown; contentType?: string;
    headers?: Record<string, string>; abort?: boolean; once?: boolean }): Promise<void>;
  evaluate(page: Page, expr: string): Promise<any>;
  runCode(page: Page, code: string, opts?: Timeout): Promise<any>;
  waitForResponse(page: Page, url: string | RegExp, trigger?: () => Maybe<unknown>, opts?: Timeout): Promise<any>;

  // checks and reads
  expectUrl(page: Page, want: string | RegExp, matcher?: Matcher, opts?: Timeout): Promise<void>;
  expectTitle(page: Page, want: string | RegExp, matcher?: Matcher, opts?: Timeout): Promise<void>;
  expectNumber(loc: Locator, want: unknown, opts?: Timeout): Promise<void>;
  expectSorted(loc: Locator, order?: 'asc' | 'desc', opts?: Timeout): Promise<void>;
  expectDialog(page: Page, matcher?: Matcher, want?: string | RegExp, opts?: Timeout): Promise<void>;
  until(timeout: number, ok: () => Maybe<unknown>, why?: string): Promise<void>;
  readAfter(check: Promise<unknown>, loc: Locator, as?: string): Promise<any>;
  read(target: Target, as?: string, opts?: Timeout): Promise<any>;
  isVisible(loc: Locator): Promise<boolean>;
  exists(loc: Locator): Promise<boolean>;
  compare(left: unknown, op: string, right: unknown): boolean;

  // db / api_call, captures, tokens, data
  db(spec: Record<string, unknown>): Promise<any>;
  api(spec: Record<string, unknown>): Promise<any>;
  check(result: unknown, checks: unknown[]): void;
  apiEvidence(): unknown[];
  capture(result: unknown, paths: Record<string, string>): void;
  testId(root: Target, id: string): Locator;
  exactName(name: string): string | RegExp;
  /** a step's text with its {{tokens}} and $VARIABLES filled in */
  t(text: string): string;
  lit(token: string): any;
  read(loc: Locator): Promise<string>;
  inPage<T>(fn: T): T;
  useData(sets: Record<string, unknown>): void;
}
