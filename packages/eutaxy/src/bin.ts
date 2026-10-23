// The eutaxy command entry: in development through bin/eutaxy.mjs, when published as dist/bin.js.
import { main } from "./cli.ts";

// A closed pipe (e.g. `eutaxy check ... | head`) is not an error worth a stack trace.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw err;
});

const code = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
});
process.exitCode = code;
