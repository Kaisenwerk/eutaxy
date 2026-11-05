/**
 * The catalogue of UNSUPPORTED reasons (site/reference/unsupported.md) names every reason the code can
 * give: each stretch of literal text in a reason, as the source writes it, appears on the page. A reason
 * added or reworded without its entry fails here.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The end of the expression starting at `i`: the `,`, `)` or `;` at depth 0 that closes it. */
function expressionEnd(src: string, i: number): number {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j] as string;
    if (c === '"' || c === "'" || c === "`") {
      j = literalEnd(src, j);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return j;
      depth--;
    } else if ((c === "," || c === ";") && depth === 0) return j;
  }
  return src.length;
}

/** The index of the quote that closes the literal opening at `i`. */
function literalEnd(src: string, i: number): number {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (q === "`" && c === "$" && src[j + 1] === "{") j = expressionEnd(src, j + 2);
    else if (c === q) return j;
  }
  return src.length;
}

/** The literal text in an expression: each string, and each template's text between its holes, nested ones too. */
function literalChunks(expr: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < expr.length; i++) {
    const q = expr[i];
    if (q !== '"' && q !== "'" && q !== "`") continue;
    const end = literalEnd(expr, i);
    const body = expr.slice(i + 1, end);
    if (q !== "`") out.push(body);
    else {
      let text = "";
      for (let j = 0; j < body.length; j++) {
        if (body[j] === "\\") {
          text += body[j + 1] ?? "";
          j++;
        } else if (body[j] === "$" && body[j + 1] === "{") {
          out.push(text);
          text = "";
          const close = expressionEnd(body, j + 2);
          out.push(...literalChunks(body.slice(j + 2, close)));
          j = close;
        } else text += body[j];
      }
      out.push(text);
    }
    i = end;
  }
  return out;
}

/** Every reason the code can give: arguments of the reporting calls, `reason:` fields and `reason =` values. */
function reasonChunks(): { file: string; chunk: string }[] {
  const files = execFileSync("git", ["ls-files", "packages/*/src/*.ts"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f && !f.endsWith(".test.ts") && !f.endsWith(".fixtures.ts"));
  const out: { file: string; chunk: string }[] = [];
  for (const file of files) {
    const src = readFileSync(join(root, file), "utf8");
    const starts = [
      ...src.matchAll(/\b(?:unsupported|notModelled|fatal)\(\s*/g),
      // A verdict's reason field: the UNSUPPORTED verdicts exploration builds (other packages' reason
      // fields are spec verdicts', not scenario ones).
      ...(file === "packages/engine/src/explore.ts" ? src.matchAll(/\breason:\s*/g) : []),
      ...src.matchAll(/\bconst reason = /g),
      ...src.matchAll(/function waitingUnseen\([^)]*\): string \{\s*return /g),
    ].map((m) => (m.index ?? 0) + m[0].length);
    for (const start of starts) {
      // A declaration's parameter (`unsupported(reason: string)`) is not a reason given.
      if (/^[A-Za-z_]\w*\s*[:?]/.test(src.slice(start))) continue;
      for (const chunk of literalChunks(src.slice(start, expressionEnd(src, start))))
        if (chunk.trim().length >= 12) out.push({ file, chunk: chunk.trim() });
    }
  }
  return out;
}

const squash = (s: string): string => s.replace(/\s+/g, " ");

test("every reason the code reports UNSUPPORTED for has its entry in the catalogue", () => {
  const page = squash(readFileSync(join(root, "site", "reference", "unsupported.md"), "utf8"));
  const chunks = reasonChunks();
  // The extraction finds the reasons: a floor well under today's count, so a broken scan cannot pass.
  expect(chunks.length).toBeGreaterThan(80);
  const missing = chunks.filter((c) => !page.includes(squash(c.chunk)));
  expect(missing.map((m) => `${m.file}: ${m.chunk}`)).toEqual([]);
});

test("the extraction reads nested templates and skips declarations", () => {
  const nested = literalChunks(
    '`WebSocket ${id}: ${n === 0 ? "the object accepted nothing" : `${n} sockets were accepted`}`',
  );
  expect(nested).toContain("WebSocket ");
  expect(nested).toContain("the object accepted nothing");
  expect(nested).toContain(" sockets were accepted");
});
