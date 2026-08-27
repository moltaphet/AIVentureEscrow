// Robust error-to-string helper.
//
// Wallet and RPC providers (EIP-1193) frequently reject with plain objects such
// as { code, message, data } rather than real Error instances. Passing those to
// String() yields the literal "[object Object]", which then leaks into the UI.
// This helper drills into the common message-bearing shapes and only falls back
// to JSON.stringify when no readable message can be found.
export function stringifyError(error: unknown): string {
  if (error == null) return "Unknown error.";
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message) return error.message;

  if (typeof error === "object") {
    const record = error as Record<string, unknown>;

    // Direct message property (EIP-1193 provider errors, viem, ethers, etc.).
    if (typeof record.message === "string" && record.message) return record.message;

    // Nested provider error payloads, e.g. { error: { message } } or { data: { message } }.
    const nested = record.error ?? record.data;
    if (nested && typeof nested === "object") {
      const nestedMessage = (nested as Record<string, unknown>).message;
      if (typeof nestedMessage === "string" && nestedMessage) return nestedMessage;
    }

    if (typeof record.reason === "string" && record.reason) return record.reason;

    try {
      const serialized = JSON.stringify(error, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // Circular or otherwise non-serializable object; fall through.
    }
  }

  return String(error);
}
