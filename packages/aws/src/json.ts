import { toJson as coreToJson, type JsonValue } from "@eutaxy/core";

/** Binary DynamoDB values keep their contents, so two different binary keys stay distinct. */
function bytesAsBase64(value: object): JsonValue | undefined {
  return value instanceof Uint8Array
    ? `base64:${Buffer.from(value).toString("base64")}`
    : undefined;
}

/** Core's `toJson`, with bytes in base64. */
export function toJson(value: unknown): JsonValue {
  return coreToJson(value, bytesAsBase64);
}
