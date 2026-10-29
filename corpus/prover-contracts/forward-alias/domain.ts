/** A function over types declared after it in the file: the compiler resolves them wherever they are. */

export function next(s: State): State {
  if (s.phase === "idle") return { phase: "busy", count: s.count + 1 };
  return { phase: "idle", count: s.count + 1 };
}

export type State = { readonly phase: Phase; readonly count: number };
export type Phase = "idle" | "busy";
