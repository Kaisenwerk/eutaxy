/** Types declared in another file beside the module. */

export interface Account {
  readonly balance: number;
  readonly frozen: boolean;
}

export type Decision =
  | { readonly kind: "allow"; readonly remaining: number }
  | { readonly kind: "deny" };
