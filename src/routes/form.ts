// Reading form fields without trusting their shape.
//
// `parseBody()` hands back `string | File | (string | File)[]` per key, and
// a missing key is `undefined`. Casting with `as string` and calling a string
// method turned every absent or uploaded field into an HTTP 500.

/** The trimmed value of a text field, or undefined when it is absent, empty,
 *  repeated, or a file. */
export function formString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A protocol value exactly as it was sent, or undefined when it is absent,
 *  repeated, or a file. For values the other side compares byte for byte
 *  (OAuth `state`): trimming those is a silent change to someone's data. */
export function formRaw(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}
