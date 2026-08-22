import { createClient } from "genlayer-js";
import {
  ExecutionResult,
  TransactionStatus,
  transactionsStatusNumberToName,
  type CalldataEncodable,
  type GenLayerTransaction,
  type Network,
  type TransactionHash,
} from "genlayer-js/types";
import {
  CHAIN,
  CHAIN_ID_HEX,
  CONTRACT_ADDRESS,
  NETWORK_NAME,
  RPC_OVERRIDE,
} from "../config";
import type { EscrowSnapshot, Grant, Milestone, TransactionStage } from "../types";

type Client = ReturnType<typeof createClient>;
type ClientConfig = NonNullable<Parameters<typeof createClient>[0]>;
type EthereumProvider = NonNullable<ClientConfig["provider"]>;
export type StageListener = (stage: TransactionStage, hash?: string, error?: string) => void;

const POLL_INTERVAL_MS = 5_000;
const CONFIRMATION_TIMEOUT_MS = 180_000;
const FAILED_CONSENSUS_STATUSES = new Set<TransactionStatus>([
  TransactionStatus.CANCELED,
  TransactionStatus.LEADER_TIMEOUT,
  TransactionStatus.UNDETERMINED,
  TransactionStatus.VALIDATORS_TIMEOUT,
]);

const readClient: Client = createClient({
  chain: CHAIN,
  ...(RPC_OVERRIDE ? { endpoint: RPC_OVERRIDE } : {}),
});
let writeClient: Client | null = null;
let connectedWallet: string | null = null;

function requireAddress(): `0x${string}` {
  if (!CONTRACT_ADDRESS) {
    throw new Error("Set VITE_CONTRACT_ADDRESS to enable live contract access.");
  }
  return CONTRACT_ADDRESS;
}

function asRecord(value: CalldataEncodable | unknown): Record<string, unknown> {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("The contract returned an unexpected record.");
}

function readValue(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = readValue(record, key);
  return value == null ? "" : String(value);
}

function readBig(record: Record<string, unknown>, key: string): bigint {
  const value = readValue(record, key);
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(value);
  if (typeof value === "string" && value.trim() !== "") return BigInt(value);
  return 0n;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  return Number(readBig(record, key));
}

function readBool(record: Record<string, unknown>, key: string): boolean {
  const value = readValue(record, key);
  return value === true || value === 1 || value === "true";
}

function normalizeAddress(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : String(value).toLowerCase();
}

function normalizeGrant(raw: CalldataEncodable): Grant {
  const grant = asRecord(raw);
  return {
    owner: normalizeAddress(readValue(grant, "owner")),
    admin: normalizeAddress(readValue(grant, "admin")),
    funder: normalizeAddress(readValue(grant, "funder")),
    creator: normalizeAddress(readValue(grant, "creator")),
    totalGrantAmount: readBig(grant, "total_grant_amount"),
    allocatedFunds: readBig(grant, "allocated_funds"),
    reservedFunds: readBig(grant, "reserved_funds"),
    releasedFunds: readBig(grant, "released_funds"),
    rejectedFunds: readBig(grant, "rejected_funds"),
    reclaimedFunds: readBig(grant, "reclaimed_funds"),
    escrowedFunds: readBig(grant, "escrowed_funds"),
    unallocatedReclaimedFunds: readBig(grant, "unallocated_reclaimed_funds"),
    creatorClaimableFunds: readBig(grant, "creator_claimable_funds"),
    funderClaimableFunds: readBig(grant, "funder_claimable_funds"),
    creatorPendingPayout: readBig(grant, "creator_pending_payout"),
    funderPendingPayout: readBig(grant, "funder_pending_payout"),
    milestoneCount: readNumber(grant, "milestone_count"),
    disputeTimeoutSeconds: readNumber(grant, "dispute_timeout_seconds"),
    paused: readBool(grant, "paused"),
  };
}

function normalizeMilestone(raw: CalldataEncodable): Milestone {
  const milestone = asRecord(raw);
  return {
    milestoneId: readNumber(milestone, "milestone_id"),
    description: readString(milestone, "description"),
    requiredProof: readString(milestone, "required_proof"),
    fundingAmount: readBig(milestone, "funding_amount"),
    status: readString(milestone, "status") || "PENDING",
    deliverableEvidenceUrl: readString(milestone, "deliverable_evidence_url"),
    deliverableDescription: readString(milestone, "deliverable_description"),
    submittedAt: readNumber(milestone, "submitted_at"),
    evaluationAvailableAt: readNumber(milestone, "evaluation_available_at"),
    evaluationStartedAt: readNumber(milestone, "evaluation_started_at"),
    evaluatedAt: readNumber(milestone, "evaluated_at"),
    reclaimAvailableAt: readNumber(milestone, "reclaim_available_at"),
    evaluationLocked: readBool(milestone, "evaluation_locked"),
    evaluationAttempted: readBool(milestone, "evaluation_attempted"),
    reclaimed: readBool(milestone, "reclaimed"),
    submissionDeadline: readNumber(milestone, "submission_deadline"),
    decision: readString(milestone, "decision"),
    decisionReason: readString(milestone, "decision_reason"),
    evidenceDigest: readString(milestone, "evidence_digest"),
  };
}

async function read(functionName: string, args: CalldataEncodable[] = []): Promise<CalldataEncodable> {
  return readClient.readContract({
    address: requireAddress(),
    functionName,
    args,
  });
}

export async function getEscrowSnapshot(): Promise<EscrowSnapshot | null> {
  if (!CONTRACT_ADDRESS) return null;

  const [rawGrant, rawIds] = await Promise.all([
    read("get_grant"),
    read("get_milestone_ids"),
  ]);
  const grant = normalizeGrant(rawGrant);
  const ids = Array.isArray(rawIds)
    ? rawIds.map((value) => Number(value))
    : [];
  const milestones = await Promise.all(
    ids.map(async (id) => normalizeMilestone(await read("get_milestone", [BigInt(id)]))),
  );

  return {
    grant,
    milestones,
    mode: "live",
    fetchedAt: Date.now(),
  };
}

function walletErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const value = Number((error as { code: unknown }).code);
  return Number.isFinite(value) ? value : null;
}

function chainIdFrom(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isFinite(parsed) ? parsed : null;
}

async function ensureWalletChain(provider: EthereumProvider): Promise<void> {
  const currentChain = String(await provider.request({ method: "eth_chainId" })).toLowerCase();
  if (currentChain === CHAIN_ID_HEX.toLowerCase()) return;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX }],
    });
  } catch (error) {
    if (walletErrorCode(error) !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: CHAIN_ID_HEX,
          chainName: "GenLayer Studionet",
          nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
          rpcUrls: [RPC_OVERRIDE || CHAIN.rpcUrls.default.http[0]],
          ...(CHAIN.blockExplorers?.default.url
            ? { blockExplorerUrls: [CHAIN.blockExplorers.default.url] }
            : {}),
        },
      ],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX }],
    });
  }
}

export async function connectWallet(): Promise<string> {
  const provider = window.ethereum as EthereumProvider | undefined;
  if (!provider) throw new Error("Install an EIP-1193 wallet to connect to GenLayer.");

  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
    throw new Error("The wallet did not return an account.");
  }
  await ensureWalletChain(provider);

  const address = accounts[0].toLowerCase();
  writeClient = createClient({
    chain: CHAIN,
    ...(RPC_OVERRIDE ? { endpoint: RPC_OVERRIDE } : {}),
    account: address as `0x${string}`,
    provider,
  });
  await writeClient.connect(NETWORK_NAME as Network);
  connectedWallet = address;
  return address;
}

export async function initializeWallet(address: string): Promise<void> {
  const provider = window.ethereum as EthereumProvider | undefined;
  if (!provider) return;
  writeClient = createClient({
    chain: CHAIN,
    ...(RPC_OVERRIDE ? { endpoint: RPC_OVERRIDE } : {}),
    account: address.toLowerCase() as `0x${string}`,
    provider,
  });
  await writeClient.connect(NETWORK_NAME as Network);
  connectedWallet = address.toLowerCase();
}

export function connectedAddress(): string | null {
  return connectedWallet;
}

export function disconnectWallet(): void {
  connectedWallet = null;
  writeClient = null;
}

function transactionStatus(receipt: GenLayerTransaction): TransactionStatus | null {
  if (receipt.statusName) return receipt.statusName;
  if (typeof receipt.status === "string") {
    return (
      (transactionsStatusNumberToName as Record<string, TransactionStatus>)[receipt.status] ??
      (receipt.status as TransactionStatus)
    );
  }
  if (typeof receipt.status === "number") {
    return (
      (transactionsStatusNumberToName as Record<string, TransactionStatus>)[String(receipt.status)] ??
      null
    );
  }
  return null;
}

function executionState(receipt: GenLayerTransaction): "success" | "failure" | "pending" {
  if (
    receipt.txExecutionResultName === ExecutionResult.FINISHED_WITH_RETURN ||
    receipt.txExecutionResult === 1
  ) return "success";
  if (
    receipt.txExecutionResultName === ExecutionResult.FINISHED_WITH_ERROR ||
    receipt.txExecutionResult === 2
  ) return "failure";
  return "pending";
}

function receiptReached(receipt: GenLayerTransaction, requested: TransactionStatus): boolean {
  const status = transactionStatus(receipt);
  if (status && FAILED_CONSENSUS_STATUSES.has(status)) {
    throw new Error(`Studionet consensus ended with status ${status}.`);
  }
  const execution = executionState(receipt);
  if (execution === "failure") {
    throw new Error(`Contract execution failed at ${status || "UNKNOWN"} status.`);
  }
  if (requested === TransactionStatus.FINALIZED) {
    return status === TransactionStatus.FINALIZED && execution === "success";
  }
  return (
    (status === TransactionStatus.ACCEPTED || status === TransactionStatus.FINALIZED) &&
    execution === "success"
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function poll(
  hash: TransactionHash,
  requested: TransactionStatus,
  deadline: number,
): Promise<GenLayerTransaction | null> {
  while (Date.now() < deadline) {
    try {
      const receipt = await readClient.getTransaction({ hash });
      if (receiptReached(receipt, requested)) return receipt;
    } catch (error) {
      if (error instanceof Error && /consensus|execution failed/.test(error.message)) throw error;
    }
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(100, deadline - Date.now())));
  }
  return null;
}

async function confirm(hash: TransactionHash, textHash: string, onStage: StageListener): Promise<void> {
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
  const accepted = await poll(hash, TransactionStatus.ACCEPTED, deadline);
  if (!accepted) {
    onStage("submitted", textHash);
    return;
  }
  onStage("accepted", textHash);
  const finalized = await poll(hash, TransactionStatus.FINALIZED, deadline);
  if (!finalized) {
    onStage("submitted", textHash, "Transaction is still finalizing on Studionet.");
    return;
  }
  onStage("finalized", textHash);
}

export async function writeContract(
  functionName: string,
  args: CalldataEncodable[] = [],
  value = 0n,
  onStage: StageListener = () => undefined,
): Promise<string> {
  if (!writeClient) throw new Error("Connect a wallet before sending a transaction.");
  onStage("signing");
  const hash = await writeClient.writeContract({
    address: requireAddress(),
    functionName,
    args,
    value,
  });
  const textHash = String(hash);
  onStage("submitted", textHash);
  await confirm(hash, textHash, onStage);
  return textHash;
}

export function addMilestone(
  id: number,
  description: string,
  proof: string,
  amount: bigint,
  onStage: StageListener,
): Promise<string> {
  return writeContract("add_milestone", [BigInt(id), description, proof, amount], 0n, onStage);
}

export function submitDeliverable(
  id: number,
  evidenceUrl: string,
  description: string,
  onStage: StageListener,
): Promise<string> {
  return writeContract(
    "submit_milestone_deliverable",
    [BigInt(id), evidenceUrl, description],
    0n,
    onStage,
  );
}

export function evaluateMilestone(id: number, onStage: StageListener): Promise<string> {
  return writeContract("evaluate_and_release_milestone", [BigInt(id)], 0n, onStage);
}

export function reclaimRejected(id: number, onStage: StageListener): Promise<string> {
  return writeContract("reclaim_rejected_milestone", [BigInt(id)], 0n, onStage);
}

export function reclaimUnsubmitted(id: number, onStage: StageListener): Promise<string> {
  return writeContract("reclaim_unsubmitted_milestone", [BigInt(id)], 0n, onStage);
}

export function reclaimUnallocated(onStage: StageListener): Promise<string> {
  return writeContract("reclaim_unallocated_funds", [], 0n, onStage);
}

export function claimFunds(onStage: StageListener): Promise<string> {
  return writeContract("claim_funds", [], 0n, onStage);
}

export function setPaused(paused: boolean, onStage: StageListener): Promise<string> {
  return writeContract("set_paused", [paused], 0n, onStage);
}

export function setAdmin(admin: string, onStage: StageListener): Promise<string> {
  return writeContract("set_admin", [admin], 0n, onStage);
}

export async function readWalletState(address: string): Promise<{ balance: bigint; chainId: number | null }> {
  const provider = window.ethereum;
  if (!provider) return { balance: 0n, chainId: null };
  const [balanceResult, chainResult] = await Promise.all([
    provider.request({ method: "eth_getBalance", params: [address, "latest"] }),
    provider.request({ method: "eth_chainId" }),
  ]);
  return {
    balance: typeof balanceResult === "string" ? BigInt(balanceResult) : 0n,
    chainId: chainIdFrom(chainResult),
  };
}
