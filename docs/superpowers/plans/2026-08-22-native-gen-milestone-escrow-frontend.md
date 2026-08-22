# Native GEN Milestone Escrow Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Build a responsive GenLayer Studionet operator console for funding, configuring, submitting, evaluating, reclaiming, and claiming milestone escrow funds.

**Architecture:** Keep the contract client as a small typed adapter around `genlayer-js`, with read normalization and shared transaction polling in one module. Keep wallet connection and account/network events in a hook, while `App.tsx` composes the project dashboard, forms, lifecycle controls, education, FAQ, and configuration states. Use a deliberate graphite, cyan, amber, and coral visual system with condensed display type and monospace chain labels.

**Tech Stack:** React 18, TypeScript, Vite, `genlayer-js` 1.1.8, Lucide React, CSS, `@fontsource` typography.

## Global Constraints

- Target GenLayer Studionet chain ID is `61999`.
- Contract deployment is configured with `VITE_CONTRACT_ADDRESS`; never invent a deployment address.
- Source, comments, and visible copy are ASCII-only English.
- All live writes require an injected EIP-1193 wallet and a compatible Studionet chain.
- Native GEN transfers use the contract's pull-payment `claim_funds` method.
- A missing deployment must remain an explicit read-only/configuration state.
- Responsive layouts must work at desktop and mobile widths with keyboard-visible focus and reduced-motion support.

---

### Task 1: Frontend Scaffold and Contract Adapter

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/index.html`
- Create: `frontend/src/vite-env.d.ts`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/config.ts`
- Create: `frontend/src/types.ts`
- Create: `frontend/src/lib/contract.ts`

**Interfaces:**
- `getEscrowSnapshot(): Promise<EscrowSnapshot>` reads `get_grant`, `get_milestone_ids`, and every `get_milestone`.
- `connectWallet(): Promise<WalletState>` requests accounts, switches/adds Studionet, and creates the write client.
- `writeContract(functionName, args, value, onStage): Promise<string>` submits and polls a GenLayer transaction.
- Exported actions are `addMilestone`, `submitDeliverable`, `evaluateMilestone`, `reclaimRejected`, `reclaimUnsubmitted`, `reclaimUnallocated`, `claimFunds`, `setPaused`, and `setAdmin`.

- [ ] **Step 1: Add the package and TypeScript/Vite configuration**

Use React 18, `genlayer-js` 1.1.8, Lucide, the three existing fontsource families, and Vite 5-compatible development dependencies. Configure strict TypeScript with `noUnusedLocals` and `noUnusedParameters`.

- [ ] **Step 2: Add normalized domain types and contract configuration**

Define `Grant`, `Milestone`, `EscrowSnapshot`, `WalletState`, `TransactionState`, and `TransactionStage`. Read `VITE_CONTRACT_ADDRESS` and optional `VITE_GENLAYER_RPC_URL`, defaulting to `studionet`.

- [ ] **Step 3: Implement GenLayer reads and writes**

Normalize `Map` or object return values, convert numeric values to `bigint`, and poll until accepted/finalized or a consensus/execution error. Use `wallet_switchEthereumChain` for chain `0xf227` and `wallet_addEthereumChain` if the wallet reports code `4902`.

- [ ] **Step 4: Run the scaffold typecheck**

Run `npm install` and `npm run typecheck` from `frontend/`. Expected result: no TypeScript diagnostics.

### Task 2: Wallet Hook and Operator Dashboard

**Files:**
- Create: `frontend/src/hooks/useWallet.ts`
- Create: `frontend/src/App.tsx`
- Modify: `frontend/src/main.tsx`

**Interfaces:**
- `useWallet()` returns `{ address, balance, chainId, connected, connect, disconnect, refresh }`.
- The app uses `getEscrowSnapshot()` on load and refreshes after each confirmed write.

- [ ] **Step 1: Implement wallet state**

Subscribe to `accountsChanged` and `chainChanged`, read `eth_getBalance`, and expose explicit connect/disconnect behavior. Keep a wallet-unavailable message when no EIP-1193 provider exists.

- [ ] **Step 2: Compose the dashboard**

Build header/network state, hero metrics, role-aware project identity, milestone ledger, create-milestone form, deliverable form, evaluation/reclaim/claim controls, and transaction feedback. Disable controls when the contract is unconfigured, paused, or the caller lacks the relevant role.

- [ ] **Step 3: Add education, FAQ, and footer**

Add a process strip explaining fund, submit, evaluate, and claim; an accordion FAQ; and footer links for contract, network, source, and terms placeholders that do not claim nonexistent deployments.

### Task 3: Visual System and Verification

**Files:**
- Create: `frontend/src/index.css`
- Create: `frontend/.env.example`

- [ ] **Step 1: Implement responsive styles**

Use graphite surfaces, cyan protocol accents, amber review states, coral rejected states, condensed headings, monospace data labels, compact borders, and no decorative gradients or oversized marketing cards. Add mobile breakpoint layout, focus states, and `prefers-reduced-motion` handling.

- [ ] **Step 2: Build and inspect the app**

Run `npm run build`, start `npm run dev -- --host 127.0.0.1`, and inspect the app at desktop and mobile viewport widths. Confirm the unconfigured state renders without throwing and all forms remain usable.

- [ ] **Step 3: Re-run contract verification**

Run `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 pytest -p gltest.direct.pytest_plugin tests/direct/ -v`, `genvm-lint check contracts/ai_venture_escrow.py --json`, `genvm-lint typecheck contracts/ai_venture_escrow.py --json`, and `python3 -m py_compile contracts/ai_venture_escrow.py tests/direct/conftest.py tests/direct/test_ai_venture_escrow.py`.

- [ ] **Step 4: Review generated files and worktree**

Ensure only source, configuration, lockfile, and intended documentation are present. Do not claim live transaction verification without a deployed Studionet address and funded wallet.
