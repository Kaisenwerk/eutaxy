declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}

declare module "*.test.ts?raw" {
  const source: string;
  export default source;
}
