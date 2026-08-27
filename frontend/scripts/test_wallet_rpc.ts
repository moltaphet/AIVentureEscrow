// Automated wallet RPC simulation test.
//
// Reproduces the steward's rejection ("method [wallet_getSnaps] doesn't has
// corresponding handler") in a headless Node environment and proves the fix.
//
// It mocks a standard EIP-1193 `window.ethereum` provider that rejects the
// optional MetaMask Snaps probes, wraps it with `wrapEthereumProvider`, and
// replays the exact request sequence genlayer-js issues during connect. The
// test asserts the flow completes gracefully without an unhandled exception,
// while genuine errors on essential methods still surface.
//
// Run with:  node scripts/test_wallet_rpc.ts   (Node >= 22.6, from frontend/)

import {
  wrapEthereumProvider,
  installSafeProvider,
  type Eip1193Provider,
  type Eip1193RequestArgs,
} from "../src/lib/provider.ts";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
  }
}

// The exact error a Snaps-less wallet raises for unsupported RPC methods.
const UNSUPPORTED_METHOD_ERROR =
  "method [wallet_getSnaps] doesn't has corresponding handler";

// Build a mock standard EIP-1193 provider (no MetaMask Snaps support). It
// answers essential methods and rejects the optional Snaps probes, mirroring
// real wallet behavior.
function createStandardWallet(): { provider: Eip1193Provider; calls: string[] } {
  const calls: string[] = [];
  const account = "0xabc0000000000000000000000000000000000001";
  const provider: Eip1193Provider = {
    async request(args: Eip1193RequestArgs): Promise<unknown> {
      calls.push(args.method);
      switch (args.method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account];
        case "eth_chainId":
          return "0xf22f";
        case "wallet_getSnaps":
        case "wallet_requestSnaps":
          // A standard wallet has no handler for Snaps methods.
          throw new Error(UNSUPPORTED_METHOD_ERROR);
        default:
          return null;
      }
    },
  };
  return { provider, calls };
}

async function testProbeIsSwallowed(): Promise<void> {
  console.log("Test 1: wallet_getSnaps rejection is swallowed gracefully");
  const { provider } = createStandardWallet();
  const safe = wrapEthereumProvider(provider);

  let threw = false;
  let result: unknown = "not-set";
  try {
    result = await safe.request({ method: "wallet_getSnaps" });
  } catch {
    threw = true;
  }
  check("wallet_getSnaps does not throw", threw === false);
  check(
    "wallet_getSnaps returns a safe empty-object fallback",
    typeof result === "object" && result !== null && Object.keys(result as object).length === 0,
  );
}

async function testFullConnectProbeSequence(): Promise<void> {
  console.log("Test 2: full genlayer-js connect probe sequence completes");
  const { provider } = createStandardWallet();
  const safe = wrapEthereumProvider(provider);

  // Replay the sequence from genlayer-js connect(): request accounts, read the
  // chain, then probe + request Snaps. Previously the Snaps probes aborted the
  // whole flow; now the flow must run to completion.
  let crashed = false;
  let account = "";
  try {
    const accounts = (await safe.request({ method: "eth_requestAccounts" })) as string[];
    account = accounts[0];
    await safe.request({ method: "eth_chainId" });
    const snaps = await safe.request({ method: "wallet_getSnaps" });
    const installed = Object.values(snaps as Record<string, { id?: string }>).some(
      (snap) => snap.id === "npm:genlayer-snap",
    );
    if (!installed) {
      await safe.request({ method: "wallet_requestSnaps" });
    }
  } catch {
    crashed = true;
  }
  check("connect probe sequence does not crash", crashed === false);
  check("eth_requestAccounts still yields the account", account.startsWith("0x"));
}

async function testEssentialErrorsStillPropagate(): Promise<void> {
  console.log("Test 3: genuine errors on essential methods still propagate");
  const rejection = "User rejected the request.";
  const provider: Eip1193Provider = {
    async request(args: Eip1193RequestArgs): Promise<unknown> {
      if (args.method === "eth_requestAccounts") throw new Error(rejection);
      return null;
    },
  };
  const safe = wrapEthereumProvider(provider);

  let message = "";
  try {
    await safe.request({ method: "eth_requestAccounts" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("eth_requestAccounts rejection is not swallowed", message === rejection);
  check("surfaced error is human-readable, not [object Object]", message !== "[object Object]");
}

async function testIdempotentWrapping(): Promise<void> {
  console.log("Test 4: wrapping is idempotent (no double-wrap)");
  const { provider, calls } = createStandardWallet();
  const once = wrapEthereumProvider(provider);
  const twice = wrapEthereumProvider(once);

  check("re-wrapping returns the same guarded provider", once === twice);

  calls.length = 0;
  await twice.request({ method: "eth_chainId" });
  check("underlying request is invoked exactly once per call", calls.length === 1);
}

function testInstallSafeProviderOnGlobal(): void {
  console.log("Test 5: installSafeProvider guards the global window.ethereum");
  const globalRef = globalThis as unknown as { window?: { ethereum?: Eip1193Provider } };
  const previousWindow = globalRef.window;

  const { provider } = createStandardWallet();
  const originalRequest = provider.request;
  globalRef.window = { ethereum: provider };

  const guarded = installSafeProvider();
  check("installSafeProvider returns the wrapped global provider", guarded !== undefined);
  check(
    "global window.ethereum.request is replaced with the guard",
    globalRef.window?.ethereum?.request !== originalRequest,
  );

  globalRef.window = previousWindow;
}

async function main(): Promise<void> {
  console.log("=== Wallet RPC simulation: unsupported method handling ===\n");
  await testProbeIsSwallowed();
  await testFullConnectProbeSequence();
  await testEssentialErrorsStillPropagate();
  await testIdempotentWrapping();
  testInstallSafeProviderOnGlobal();

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length > 0) {
    console.log("FAILED checks:");
    for (const name of failures) console.log(`  - ${name}`);
    console.log("\nRESULT: FAILURE");
    process.exit(1);
  }
  console.log("\nRESULT: SUCCESS - unsupported wallet RPC methods are handled gracefully.");
}

main().catch((error) => {
  console.error("Unexpected test harness error:", error);
  process.exit(1);
});
