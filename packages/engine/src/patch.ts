/** The one way the engine and its platforms replace a property for a while. */

/**
 * Replace `target[key]` with a value or a getter until the returned
 * function is called, which puts the property back exactly as it was (its
 * descriptor, or no property at all). The replacement is configurable and
 * keeps the original's enumerability. Calling the restore twice is
 * harmless. Throws where the property cannot be redefined.
 */
export function patchProperty(
  target: object,
  key: PropertyKey,
  patch: { readonly value: unknown } | { readonly get: () => unknown },
): () => void {
  const saved = Object.getOwnPropertyDescriptor(target, key);
  const enumerable = saved?.enumerable ?? false;
  Object.defineProperty(
    target,
    key,
    "get" in patch
      ? { get: patch.get, configurable: true, enumerable }
      : { value: patch.value, writable: true, configurable: true, enumerable },
  );
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (saved) Object.defineProperty(target, key, saved);
    else Reflect.deleteProperty(target, key);
  };
}
