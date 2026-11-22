// The command alone, not the package's whole index: that would load the installer and the report, and
// with them the engines and the TypeScript compiler, before any command ran.
export { main } from "@eutaxy/cli/main";
