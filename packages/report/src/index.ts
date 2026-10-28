// @eutaxy/report: text and JSON rendering of verdicts, and the Vitest regression emitter.
export { emitRegressionTest, type RegressionTestOptions } from "./regression.ts";
export {
  renderJson,
  renderSpecReport,
  renderSpecReportJson,
  renderSpecs,
  renderText,
  renderTrace,
  reportSchemaVersion,
} from "./render.ts";
