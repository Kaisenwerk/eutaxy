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

/** An error's text, cut to its first lines and indented under its heading. */
function cut(text: string): string {
  const lines = text
    .trimEnd()
    .split("\n")
    .map((l) => l.trimStart());
  const kept = lines.slice(0, keptLines);
  if (lines.length > keptLines) kept.push(`… ${lines.length - keptLines} more lines`);
  return kept.join("\n      ");
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
      const [first] = t.failureMessages ?? [];
      if (t.status === "failed" && first !== undefined)
        causes.push(`the check's test failed: ${cut(asText(first))}`);
    }
  }
  if (unhandled.length > 0) {
    const distinct = new Map<string, { type: string; what: string; times: number }>();
    for (const e of unhandled) {
      const type = typeof e.type === "string" && e.type !== "" ? e.type : "Error";
      const what = said(e);
      const key = `${type}\n${what}`;
      const seen = distinct.get(key);
      if (seen) seen.times++;
      else distinct.set(key, { type, what, times: 1 });
    }
    const intro =
      passed > 0 && causes.length === 0
        ? "its test passed, but Vitest fails a run on any error nothing handled, and there "
        : "";
    const count =
      unhandled.length === 1
        ? `${intro ? "was " : ""}1 error nothing handled`
        : `${intro ? "were " : ""}${unhandled.length} errors nothing handled, ${distinct.size} distinct`;
    causes.push(
      `${intro}${count}:${[...distinct.values()]
        .map(
          ({ type, what, times }) =>
            `\n    ${type}${times > 1 ? ` (${times} times)` : ""}: ${cut(what)}`,
        )
        .join("")}`,
    );
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
