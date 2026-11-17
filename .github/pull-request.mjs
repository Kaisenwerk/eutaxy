#!/usr/bin/env node
// Checks a pull request against the commit rules, for the Pull request
// workflow. It is squash-merged as "<title> (#<number>)" with its commits'
// Co-Authored-By lines as the footer, so:
// - the title is a Conventional Commit header with no trailing period, at
//   most 64 characters, leaving room for the " (#<number>)";
// - each commit made by the agents' bot (kaisen-agent) ends with a
//   Co-Authored-By trailer naming the model. Merge commits are not checked.
//   node .github/pull-request.mjs "<title>" [<commits.ndjson>]
// The commits file holds one {"email", "message", "parents"} object per line,
// parents being the commit's number of parents.
import { readFileSync } from "node:fs";

const TYPES = ["feat", "fix", "perf", "refactor", "test", "docs", "build", "ci", "chore", "style", "revert"];
const HEADER = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9][a-z0-9./-]*\\))?!?: \\S`);
const BOT = /^\d+\+kaisen-agent\[bot\]@users\.noreply\.github\.com$/;
const CO_AUTHOR = /^Co-Authored-By: \S.* <[^<>\s]+>$/im;

const [title = "", commitsFile] = process.argv.slice(2);
const commits = commitsFile
  ? readFileSync(commitsFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : [];

const errors = [
  ...(HEADER.test(title) ? [] : [`Title must be "<type>(<scope>): <description>", type one of ${TYPES.join(", ")}.`]),
  ...(title.length > 64 ? [`Title is ${title.length} characters; at most 64.`] : []),
  ...(title.endsWith(".") ? ["Title must not end with a period."] : []),
  ...commits
    .filter(({ email, message, parents }) => BOT.test(email) && parents < 2 && !CO_AUTHOR.test(message))
    .map(({ message }) => `Commit "${message.split("\n")[0]}" is by an agent and needs a Co-Authored-By trailer.`),
];
if (errors.length > 0) {
  console.error(`Pull request refused:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  process.exit(1);
}
