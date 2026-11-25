/**
 * A verdict as an assertion's message: the package may not import the
 * report renderer, so a failed expectation shows the verdict's own fields,
 * cut so that a counterexample's trace does not flood the output.
 */
export const told = (verdict: unknown): string => JSON.stringify(verdict, null, 1).slice(0, 4000);
