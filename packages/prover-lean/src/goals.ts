/**
 * The goal file: the properties the tactic script gave up on, each with
 * the statement Lean was asked to prove, written in the form of the proof
 * file the engine accepts (`domain.props.lean`) with every proof left
 * open. A coding agent copies it beside the spec file, puts lemmas above
 * the proofs and tactics under them, and the engine checks them as it
 * checks any supplied proof: nothing new is trusted. The hashes tie the
 * proofs to the module and the spec they were written for; the engine
 * calls a proof file stale once either changed.
 */

import type { OpenGoal } from "@eutaxy/prover";
import { ident } from "./emit.ts";
import { leanVersion } from "./lean.ts";
import { refusedIn, sourceHashMarker, specHashMarker } from "./supplied.ts";

export interface GoalFileInput {
  /** The spec file's name, for the header: `domain.props.ts`. */
  readonly specFile: string;
  readonly sourceSha256: string;
  readonly specSha256: string;
  readonly goals: readonly OpenGoal[];
}

/** The proof file's name beside a spec file: `domain.props.lean` for `domain.props.ts`. */
export function proofFileFor(specFile: string): string {
  return specFile.replace(/\.ts$/, ".lean");
}

/** The goal file's name beside a spec file: `domain.props.goals.lean` for `domain.props.ts`. */
export function goalFileFor(specFile: string): string {
  return specFile.replace(/\.ts$/, ".goals.lean");
}

/** A line of generated commentary: one a proof file may hold, or a note that it was left out. */
const commentLine = (text: string): string =>
  refusedIn(text) === undefined
    ? text
    : "-- (a line left out: it held a word a proof file may not use)";

const comment = (text: string): string =>
  text
    .split("\n")
    .map((l) => commentLine(l.length > 0 ? `-- ${l}` : "--"))
    .join("\n");

/**
 * Render the goal file: the header with the hashes, each goal described
 * in comments (the proof file's lemma area, where comments cost nothing),
 * then one open `-- proof:` part per goal at the end, since everything
 * after a `-- proof:` line belongs to that proof. The text avoids every
 * word a supplied proof may not use, so the file copied as is reads as a
 * proof file with open proofs: every generated line is checked, and one
 * that would refuse the file (a reason Lean gave, a file or function name
 * that is itself a refused word) is left out, with a note in its place.
 * The function is named by its Lean identifier, as the statement names it.
 */
export function renderGoals(input: GoalFileInput): string {
  const header = [
    `-- Open proof goals for ${input.specFile}, written by Eutaxy's Lean engine (Lean ${leanVersion}).`,
    "-- Each goal below is a property the tactic script could not close, with the statement Eutaxy",
    "-- emits for it. To supply proofs, copy this file to",
    `-- ${proofFileFor(input.specFile)} beside the spec file, put lemmas above the \`-- proof:\` lines and`,
    "-- tactics under each, and run the engine again (eutaxy report --prover lean). The hashes tie the",
    "-- proofs to these versions of the module and the spec: once either changes, the proofs are stale",
    "-- until the goals are written again.",
    `${sourceHashMarker}${input.sourceSha256}`,
    `${specHashMarker}${input.specSha256}`,
  ];
  const described = input.goals.map((g) =>
    [
      commentLine(`-- goal: ${g.property}, a property of ${ident.fn(g.function)}`),
      commentLine(`-- Lean said: ${g.reason}`),
      "-- statement:",
      comment(g.statement.replace(/^/gm, "  ")),
    ].join("\n"),
  );
  const open = input.goals.map((g) => `-- proof: ${g.property}\n  -- tactics here`);
  return `${[header.map(commentLine).join("\n"), ...described, ...open].join("\n\n")}\n`;
}
