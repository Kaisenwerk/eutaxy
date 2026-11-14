/**
 * Why Vitest failed the run a check started, from what that run left: its
 * JSON report (a test file that could not run, a failed test) and the
 * errors nothing handled, which fail a run without being in that report,
 * so the generated config's own reporter writes them beside it
 * (`unhandledErrorsFile`). Without this the command could only say that
 * Vitest exited non-zero: the run's only reporter is the JSON one, and its
 * files are deleted after the run.
 */

/** Where the run's errors nothing handled are written: beside its report, under its stamp. */
export function unhandledErrorsFile(reportFile: string): string {
  return reportFile.replace(/\.json$/, ".unhandled.json");
}

/** Lines of an error kept in the explanation; a stack's first frames say where. */
const keptLines = 8;

/** What the JSON report holds, as far as it is read; fields are checked, not trusted. */
interface Report {
  readonly testResults?: readonly {
    readonly status?: unknown;
    readonly message?: unknown;
    readonly assertionResults?: readonly {
      readonly status?: unknown;
      readonly failureMessages?: readonly unknown[];
    }[];
  }[];
}

/** An error nothing handled as the reporter wrote it: whatever was thrown, so any field may be data. */
interface Unhandled {
  readonly type?: unknown;
  readonly message?: unknown;
  readonly stack?: unknown;
}

function parsed<T>(text: string | undefined): T | undefined {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** A field as text: a string as it is, anything else as JSON (a thrown value need not be an error). */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** What an error says: its stack or message when either is text, else whatever was thrown, as data. */
function said(e: Unhandled): string {
  for (const v of [e.stack, e.message]) if (typeof v === "string" && v !== "") return v;
  const thrown = e.message ?? e.stack;
  return thrown === undefined || thrown === null ? "(no message)" : asText(thrown);
}

/** An error's first lines, each without its indent; a line at the end says how many were cut. */
function firstLines(text: string): string[] {
  const lines = text
    .trimEnd()
    .split("\n")
    .map((l) => l.trimStart());
  const kept = lines.slice(0, keptLines);
  if (lines.length > keptLines) kept.push(`… ${lines.length - keptLines} more lines`);
  return kept;
}

/** An error's text, cut to its first lines and indented under its heading. */
function cut(text: string): string {
  return firstLines(text).join("\n      ");
}

/** An error nothing handled, told once however often it came: its type, its first lines, how often. */
export interface StrayError {
  readonly type: string;
  readonly message: string;
  readonly times: number;
}

/** The errors nothing handled, the same type and text told once with how often it came, in first-seen order. */
function distinct(unhandled: readonly Unhandled[]): StrayError[] {
  const seen = new Map<string, { type: string; message: string; times: number }>();
  for (const e of unhandled) {
    const type = typeof e.type === "string" && e.type !== "" ? e.type : "Error";
    const whole = said(e);
    // Told apart by the whole text: two errors may differ only past the lines that are shown.
    const key = `${type}\n${whole}`;
    const found = seen.get(key);
    if (found) found.times++;
    else seen.set(key, { type, message: firstLines(whole).join("\n"), times: 1 });
  }
  return [...seen.values()];
}

/** The distinct errors, one a line under the count, each error's own lines indented under it. */
function told(errors: readonly StrayError[]): string {
  return errors
    .map(
      ({ type, message, times }) =>
        `\n    ${type}${times > 1 ? ` (${times} times)` : ""}: ${message.split("\n").join("\n      ")}`,
    )
    .join("");
}

/** How many errors came, and how many distinct when more than one. */
function counted(errors: readonly StrayError[]): string {
  const all = errors.reduce((n, e) => n + e.times, 0);
  return all === 1
    ? "1 error nothing handled"
    : `${all} errors nothing handled, ${errors.length} distinct`;
}

/** Why each test file failed and each failed test's first error, and how many tests passed. */
function reportCauses(report: Report | undefined): { causes: string[]; passed: number } {
  const causes: string[] = [];
  let passed = 0;
  for (const file of report?.testResults ?? []) {
    const tests = file.assertionResults ?? [];
    // The reporter gives a file the first error outside its tests: its import, a hook, a teardown.
    if (file.status === "failed" && file.message !== undefined && file.message !== "")
      causes.push(
        `the check's test file ${tests.length === 0 ? "could not run" : "failed outside its test"}: ${cut(asText(file.message))}`,
      );
    for (const t of tests) {
      if (t.status === "passed") passed++;
      else if (t.status === "failed") {
        const [first] = t.failureMessages ?? [];
        causes.push(
          `the check's test failed${first === undefined ? "" : `: ${cut(asText(first))}`}`,
        );
      }
    }
  }
  return { causes, passed };
}

/**
 * The kinds of error nothing handled that Vitest's error catcher in the
 * test's own runtime records (`listenForErrors`): what code that ran
 * inside the test left behind, the Worker's or the simulation's. The
 * runner, its pool and the reporters record their own failures through the
 * same channel (`Teardown Error`, `Unhandled Error`, `Unhandled Reporter
 * Error`, `Restart Error`, …); those mean the run broke.
 */
const fromTheTest = new Set(["Unhandled Rejection", "Uncaught Exception"]);

/**
 * The errors nothing handled, when they are the run's only fault: every
 * test in the report passed, at least one did, no file failed outside its
 * tests, and there was at least one such error, every one recorded by the
 * test's own runtime (`fromTheTest`). Cloudflare's runtime only
 * logs an error nothing handled (a promise a Worker leaves rejected, say),
 * while Vitest fails the whole run on one, so then the verdict the test
 * left stands and these are told beside it. Otherwise undefined: the run
 * failed, and `vitestFailure` says why.
 */
export function strayErrors(left: {
  readonly report?: string | undefined;
  readonly unhandled?: string | undefined;
}): readonly StrayError[] | undefined {
  const report = parsed<Report>(left.report);
  const unhandled = parsed<Unhandled[]>(left.unhandled);
  if (report === undefined || !Array.isArray(unhandled) || unhandled.length === 0) return undefined;
  if (!unhandled.every((e) => typeof e?.type === "string" && fromTheTest.has(e.type)))
    return undefined;
  const { causes, passed } = reportCauses(report);
  const allPassed = (report.testResults ?? []).every(
    (f) => f.status === "passed" && (f.assertionResults ?? []).every((t) => t.status === "passed"),
  );
  return passed > 0 && causes.length === 0 && allPassed ? distinct(unhandled) : undefined;
}

/** The note printed beside a verdict that stands despite errors nothing handled. */
export function strayNote(errors: readonly StrayError[]): string {
  return `note: the check's test passed, and its verdict stands, but there ${errors.reduce((n, e) => n + e.times, 0) === 1 ? "was" : "were"} ${counted(errors)} (Cloudflare's runtime only logs them; Vitest fails the run on them):${told(errors)}\n`;
}

/**
 * The explanation, one cause a line (each error's own lines indented under
 * it), from the report's text and the unhandled errors' text, either of
 * which may be missing.
 */
export function vitestFailure(left: {
  readonly report?: string | undefined;
  readonly unhandled?: string | undefined;
}): string {
  const report = parsed<Report>(left.report);
  const unhandled = parsed<Unhandled[]>(left.unhandled) ?? [];
  const { causes, passed } = reportCauses(report);
  if (unhandled.length > 0) {
    const errors = distinct(unhandled);
    const passedAlone = passed > 0 && causes.length === 0;
    // Errors the test's own runtime caught leave a passed test's verdict standing (`strayErrors`),
    // so with only those the run failed because the test left no verdict.
    const onlyFromTheTest = unhandled.every(
      (e) => typeof e?.type === "string" && fromTheTest.has(e.type),
    );
    const intro = !passedAlone
      ? ""
      : onlyFromTheTest
        ? "its test passed but left no verdict in Vitest's report; there "
        : "its test passed, but Vitest fails a run on any error nothing handled, and there ";
    const also = passedAlone && onlyFromTheTest ? "also " : "";
    const verb = intro === "" ? "" : `${unhandled.length === 1 ? "was" : "were"} ${also}`;
    causes.push(`${intro}${verb}${counted(errors)}:${told(errors)}`);
  }
  if (causes.length === 0)
    causes.push(
      report === undefined
        ? "Vitest left no report it could be told from"
        : passed > 0
          ? "its test passed but left no verdict in Vitest's report"
          : "Vitest reported no failed test and no error nothing handled",
    );
  return causes.map((c) => `  ${c}\n`).join("");
}
