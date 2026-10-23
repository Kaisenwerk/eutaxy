/** Minimal typing for dynalite, the in-process DynamoDB used in tests (declare-only script). */
declare module "dynalite" {
  import type { Server } from "node:http";

  interface DynaliteOptions {
    createTableMs?: number;
    deleteTableMs?: number;
    updateTableMs?: number;
    maxItemSizeKb?: number;
  }
  function dynalite(options?: DynaliteOptions): Server;
  export default dynalite;
}
