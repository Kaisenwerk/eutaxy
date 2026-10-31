/**
 * Exhaustive exploration: every schedule within the bounds, each once. A
 * schedule is the sequence of choices a run makes: a fault or none at each
 * effect point that may still take one, and the next turn at each decision
 * of a concurrent run. Runs are deterministic, so forcing a prefix of
 * choices reproduces the run up to there; the enumerator walks the tree of
 * choice sequences depth first, one run per leaf, without saving state
 * (each run starts from the scenario's reset).
 *
 * Reduction, when on, uses sleep sets (Godefroid, Partial-Order Methods for
 * the Verification of Concurrent Systems, 1996): two turns of different
 * invocations whose effects have different targets commute, so after one
 * order of them has been explored the other is not. Starting an event is
 * dependent on everything. A run whose every option is asleep repeats an
 * explored order; it still runs (the choices are forced up to it) but is not
 * counted as a schedule and nothing below it is explored.
 */

import { type ChoiceOption, type Chooser, limitFaults } from "./chooser.ts";

interface Node {
  readonly kind: "fault" | "turn";
  readonly options: readonly ChoiceOption[];
  picked: number;
  /** Options already explored from this node, in the order they were. */
  readonly done: number[];
  /** Turns not to take from this node: their order with the path here is explored. */
  readonly sleep: ReadonlyMap<string, ChoiceOption>;
}

/** Whether two turns commute: different invocations, effects on different targets. */
export function independent(a: ChoiceOption, b: ChoiceOption): boolean {
  return (
    a.invocation !== undefined &&
    b.invocation !== undefined &&
    a.invocation !== b.invocation &&
    a.target !== undefined &&
    b.target !== undefined &&
    a.target !== b.target
  );
}

const asleep = new Map<string, ChoiceOption>();

export class Enumerator {
  private readonly stack: Node[] = [];
  private depth = 0;
  /** The depth of the first node in the run just made whose every option was asleep, or null. */
  private blockedAt: number | null = null;
  private mismatchReason: string | null = null;
  private readonly reduction: boolean;

  constructor(options: { readonly reduction: boolean }) {
    this.reduction = options.reduction;
  }

  /** Whether the run just made repeats an explored order (every option at some point was asleep). */
  get blocked(): boolean {
    return this.blockedAt !== null;
  }

  /** Set when a run made different choices than the same prefix did before: not deterministic. */
  get mismatch(): string | null {
    return this.mismatchReason;
  }

  /**
   * The chooser for the next run: the explored prefix, then the first option
   * not asleep. Enumerated runs pick their choices and share one seed for
   * the virtual globals; their turns are recorded, since they do not follow it.
   */
  next(): Chooser {
    this.depth = 0;
    this.blockedAt = null;
    return { seed: 0, recordsTurns: true, choose: (kind, options) => this.choose(kind, options) };
  }

  private choose(kind: "fault" | "turn", options: readonly ChoiceOption[]): number {
    const i = this.depth++;
    const known = this.stack[i];
    if (known) {
      const same =
        known.kind === kind &&
        known.options.length === options.length &&
        known.options.every((o, j) => o.label === options[j]?.label);
      if (!same && this.mismatchReason === null) {
        this.mismatchReason = `choice ${i} differed between runs with the same earlier choices (${known.options.map((o) => o.label).join(", ")} then ${options.map((o) => o.label).join(", ")})`;
      }
      return known.picked < options.length ? known.picked : 0;
    }
    // Below a blocked node every order is explored already: the run finishes, nothing is recorded.
    if (this.blockedAt !== null) return 0;
    const sleep = this.sleepAt(i);
    let picked = kind === "turn" ? options.findIndex((o) => !sleep.has(o.label)) : 0;
    if (picked < 0) {
      this.blockedAt = i;
      picked = 0;
    }
    this.stack.push({ kind, options, picked, done: [], sleep });
    return picked;
  }

  /** The sleep set of a new node at depth i, from its parent's. */
  private sleepAt(i: number): ReadonlyMap<string, ChoiceOption> {
    const parent = this.stack[i - 1];
    if (!this.reduction || !parent) return asleep;
    // A fault decision belongs to the effect of the turn being taken: the sleep set passes through.
    if (parent.kind === "fault") return parent.sleep;
    const taken = parent.options[parent.picked];
    if (!taken) return asleep;
    const sleep = new Map<string, ChoiceOption>();
    const candidates = [...parent.sleep.values(), ...parent.done.map((j) => parent.options[j])];
    for (const c of candidates) if (c && independent(c, taken)) sleep.set(c.label, c);
    return sleep;
  }

  /** Move to the next schedule after a run. False once every schedule has been explored. */
  advance(): boolean {
    // A run blocked by its sleep set explores nothing below the blocking node.
    this.stack.length = Math.min(this.stack.length, this.depth, (this.blockedAt ?? Infinity) + 1);
    while (this.stack.length > 0) {
      const node = this.stack[this.stack.length - 1] as Node;
      if (!node.done.includes(node.picked)) node.done.push(node.picked);
      const next = node.options.findIndex(
        (o, j) => !node.done.includes(j) && (node.kind === "fault" || !node.sleep.has(o.label)),
      );
      if (next >= 0) {
        node.picked = next;
        return true;
      }
      this.stack.pop();
    }
    return false;
  }
}

/**
 * The exhaustive half of `explore`: the chooser for each run, what a run
 * counts for, and starting the enumeration again with the reduction off
 * once a run shows its turns may not commute.
 */
export class ExhaustiveDriver {
  private reduction: boolean;
  private enumerator: Enumerator;
  private readonly maxFaultsPerRun: number;
  private schedules = 0;
  private more = true;
  private restart = false;

  constructor(reduction: boolean, maxFaultsPerRun: number) {
    this.reduction = reduction;
    this.maxFaultsPerRun = maxFaultsPerRun;
    this.enumerator = new Enumerator({ reduction });
  }

  /** Whether schedules are left to run. */
  get hasMore(): boolean {
    return this.more;
  }

  /** See `Enumerator.mismatch`. */
  get mismatch(): string | null {
    return this.enumerator.mismatch;
  }

  /** The chooser for the next run, under the run's fault bound. */
  next(): Chooser {
    return limitFaults(this.enumerator.next(), this.maxFaultsPerRun);
  }

  /**
   * Account for the run just made. False when it only repeated an order the
   * reduction had covered: it is not a new schedule and its checks repeat
   * others'. A run that shows its turns may not commute counts and is
   * checked, and `checked` then starts again over every order.
   */
  ran(turnsMayNotCommute: () => boolean): boolean {
    this.restart = this.reduction && turnsMayNotCommute();
    if (!this.restart) {
      this.more = this.enumerator.advance();
      if (this.enumerator.blocked) return false;
    }
    this.schedules++;
    return true;
  }

  /** The run's checks passed: if it turned the reduction off, every order from the start. */
  checked(): void {
    if (!this.restart) return;
    this.reduction = false;
    this.enumerator = new Enumerator({ reduction: false });
    this.schedules = 0;
  }

  /** What the verdict reports (see `BoundsReached.exhaustive`). */
  get reached(): {
    readonly complete: boolean;
    readonly schedules: number;
    readonly reduction: boolean;
  } {
    return { complete: !this.more, schedules: this.schedules, reduction: this.reduction };
  }
}
