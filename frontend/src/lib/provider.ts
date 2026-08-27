// Safe EIP-1193 provider wrapper.
//
// genlayer-js calls `window.ethereum.request({ method: "wallet_getSnaps" })`
// (and "wallet_requestSnaps") directly on the global provider during connect,
// with no error handling. Wallets that do not support MetaMask Snaps reject
// those probes with errors such as:
//
//   "method [wallet_getSnaps] doesn't has corresponding handler"
//
// Because the probe is unguarded upstream, the rejection propagates and breaks
// the whole connect flow even though eth_requestAccounts already succeeded.
//
// This module wraps a provider's `request` method so that these optional probes
// degrade to a benign fallback value instead of throwing. Every other method is
// passed through untouched, and real errors (user rejection, network failures)
// on essential methods still surface normally.

export interface Eip1193RequestArgs {
  method: string;
  params?: unknown[] | object;
}

export interface Eip1193Provider {
  request: (args: Eip1193RequestArgs) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}

// Optional MetaMask Snaps probes. These are non-essential: a wallet without
// Snaps support may reject them, and that must not abort the connect flow.
// The mapped value is the safe fallback returned when the probe is rejected.
//   - wallet_getSnaps  -> {} so `Object.values(result)` yields no installed snaps
//   - wallet_requestSnaps -> {} so the follow-up install request degrades quietly
export const OPTIONAL_PROBE_FALLBACKS: Readonly<Record<string, unknown>> = {
  wallet_getSnaps: {},
  wallet_requestSnaps: {},
};

// Marker used to keep wrapping idempotent so repeated connect attempts do not
// stack multiple wrappers on the same provider.
const WRAPPED_MARKER = "__aiveSafeRequest" as const;

type SafeRequest = Eip1193Provider["request"] & { [WRAPPED_MARKER]?: true };

function isOptionalProbe(method: string): boolean {
  return Object.prototype.hasOwnProperty.call(OPTIONAL_PROBE_FALLBACKS, method);
}

// Wrap a provider so optional Snaps probes never throw. Mutates the provider's
// `request` in place (genlayer-js reads `window.ethereum.request` fresh on each
// call, so the global object itself must carry the guard). Idempotent.
export function wrapEthereumProvider<T extends Eip1193Provider>(provider: T): T {
  const currentRequest = provider.request as SafeRequest;
  if (currentRequest[WRAPPED_MARKER]) return provider;

  const originalRequest = provider.request.bind(provider);

  const safeRequest: SafeRequest = async (args: Eip1193RequestArgs): Promise<unknown> => {
    try {
      return await originalRequest(args);
    } catch (error) {
      if (args && typeof args.method === "string" && isOptionalProbe(args.method)) {
        // Optional probe rejected by a wallet that does not support it. Log for
        // diagnostics and return the safe fallback so the caller can continue.
        if (typeof console !== "undefined" && typeof console.warn === "function") {
          console.warn(`Ignoring unsupported optional wallet method "${args.method}".`);
        }
        return OPTIONAL_PROBE_FALLBACKS[args.method];
      }
      throw error;
    }
  };
  safeRequest[WRAPPED_MARKER] = true;

  try {
    provider.request = safeRequest as T["request"];
  } catch {
    // Some providers expose a read-only `request`. In that case we cannot patch
    // in place; callers that received the return value can still route through
    // safeRequest, and the global-probe path is left untouched.
    return { ...provider, request: safeRequest } as T;
  }
  return provider;
}

// Wrap the global `window.ethereum` (if present) and return the guarded
// provider. Safe to call repeatedly. Returns undefined when no injected wallet
// is available.
export function installSafeProvider(): Eip1193Provider | undefined {
  if (typeof window === "undefined") return undefined;
  const injected = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (!injected) return undefined;
  return wrapEthereumProvider(injected);
}
