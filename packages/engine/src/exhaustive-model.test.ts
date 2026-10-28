/**
 * The enumerator held to the model core proves (`schedules`): driven the way
 * runs drive it, choice by choice down a tree, it yields exactly the model's
 * schedules, in the model's order, on every uniform tree up to a bound; and
 * on every general tree up to a bound, exactly its root-to-leaf paths, each
 * once, depth first. Exhaustive within the bounds, not sampled.
 */
import { schedules } from "@eutaxy/core";
import { describe, expect, test } from "vitest";
import { Enumerator } from "./exhaustive.ts";
import type { ChoiceOption } from "./run.ts";

/** A tree of choices: each node's children, one per option; a leaf has none. */
interface Tree {
  readonly children: readonly Tree[];
}

/** Every schedule the enumerator yields, driving one run per schedule down the tree. */
function enumerate(tree: Tree, reduction: boolean): number[][] {
  const e = new Enumerator({ reduction });
  const out: number[][] = [];
  for (;;) {
    const chooser = e.next();
    const path: number[] = [];
    let node = tree;
    while (node.children.length > 0) {
      const options: ChoiceOption[] = node.children.map((_, i) => ({
        label: `${path.length}:${i}`,
      }));
      const i = chooser.choose("turn", options);
      path.push(i);
      node = node.children[i] as Tree;
    }
    if (!e.blocked) out.push(path);
    expect(e.mismatch).toBeNull();
    if (!e.advance()) return out;
  }
}

/** The uniform tree the levels describe. */
function uniform(levels: readonly (readonly string[])[]): Tree {
  if (levels.length === 0) return { children: [] };
  const below = uniform(levels.slice(1));
  return { children: (levels[0] ?? []).map(() => below) };
}

/** Root-to-leaf paths of a tree, depth first. */
function paths(tree: Tree): number[][] {
  if (tree.children.length === 0) return [[]];
  return tree.children.flatMap((c, i) => paths(c).map((p) => [i, ...p]));
}

/** Every list of up to `depth` levels, each offering 1 to `width` options. */
function allLevels(depth: number, width: number): string[][][] {
  if (depth === 0) return [[]];
  const shorter = allLevels(depth - 1, width);
  const out: string[][][] = [[]];
  for (const rest of shorter)
    for (let w = 1; w <= width; w++)
      out.push([Array.from({ length: w }, (_, i) => `o${i}`), ...rest]);
  return [...new Map(out.map((l) => [JSON.stringify(l), l])).values()];
}

/** Every tree up to `depth` deep whose inner nodes have 1 to `width` children. */
function allTrees(depth: number, width: number): Tree[] {
  if (depth === 0) return [{ children: [] }];
  const below = allTrees(depth - 1, width);
  const out: Tree[] = [{ children: [] }];
  const grow = (prefix: Tree[]) => {
    if (prefix.length > 0) out.push({ children: prefix });
    if (prefix.length === width) return;
    for (const t of below) grow([...prefix, t]);
  };
  grow([]);
  return out;
}

describe("the enumerator refines the proved model", () => {
  const levels = allLevels(4, 3);

  test("every uniform tree up to depth 4 and width 3: exactly the model's schedules, in order", () => {
    expect(levels.length).toBe(1 + 3 + 9 + 27 + 81);
    for (const l of levels)
      for (const reduction of [false, true])
        expect(enumerate(uniform(l), reduction), JSON.stringify(l)).toEqual(
          schedules(l).map((s) => [...s]),
        );
  });

  test("every tree up to depth 3 and width 2: each root-to-leaf path once, depth first", () => {
    const trees = allTrees(3, 2);
    expect(trees.length).toBeGreaterThan(100);
    for (const t of trees) expect(enumerate(t, false)).toEqual(paths(t));
  });
});
