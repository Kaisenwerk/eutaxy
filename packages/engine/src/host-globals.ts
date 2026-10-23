/**
 * The engine's library setting is pure ECMAScript, so the host globals it
 * patches are declared here, minimally, as a declare-only script (a .d.ts
 * is not seen as global by TypeScript 7's build mode). At runtime they
 * come from workerd or Node. Nothing imports this file.
 */

declare function setTimeout(
  callback: (...args: unknown[]) => void,
  ms?: number,
  ...args: unknown[]
): number;
declare function setInterval(
  callback: (...args: unknown[]) => void,
  ms?: number,
  ...args: unknown[]
): number;
declare function clearTimeout(id?: number): void;
declare function clearInterval(id?: number): void;
/** Node's process, when the host is Node (or workerd with Node compatibility). */
declare const process: { getBuiltinModule?(id: string): unknown } | undefined;

declare const performance: { now(): number };

declare const crypto: {
  randomUUID(): string;
  getRandomValues<T extends ArrayBufferView>(view: T): T;
};

// The fetch standard, as much of it as the scripted fetch uses.
type HeadersInit = Headers | Record<string, string> | [string, string][];
declare class Headers {
  constructor(init?: HeadersInit);
  get(name: string): string | null;
  forEach(callback: (value: string, name: string) => void): void;
}
interface RequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: string | null;
  redirect?: "follow" | "error" | "manual";
}
type RequestInfo = Request | string;
declare class Request {
  constructor(input: RequestInfo | URL, init?: RequestInit);
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly redirect: "follow" | "error" | "manual";
  text(): Promise<string>;
}
interface ResponseInit {
  status?: number;
  headers?: HeadersInit;
}
declare class Response {
  constructor(body?: string | null, init?: ResponseInit);
  readonly status: number;
  readonly headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
declare class URL {
  constructor(url: string, base?: string);
  readonly host: string;
  readonly pathname: string;
}
declare function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
