export type MilestoneStatus = "PENDING" | "APPROVED" | "REJECTED" | string;

export interface Grant {
  owner: string;
  admin: string;
  funder: string;
  creator: string;
  totalGrantAmount: bigint;
  allocatedFunds: bigint;
  reservedFunds: bigint;
  releasedFunds: bigint;
  rejectedFunds: bigint;
  reclaimedFunds: bigint;
  escrowedFunds: bigint;
  unallocatedReclaimedFunds: bigint;
  creatorClaimableFunds: bigint;
  funderClaimableFunds: bigint;
  creatorPendingPayout: bigint;
  funderPendingPayout: bigint;
  milestoneCount: number;
  disputeTimeoutSeconds: number;
  paused: boolean;
}

export interface Milestone {
  milestoneId: number;
  description: string;
  requiredProof: string;
  fundingAmount: bigint;
  status: MilestoneStatus;
  deliverableEvidenceUrl: string;
  deliverableDescription: string;
  submittedAt: number;
  evaluationAvailableAt: number;
  evaluationStartedAt: number;
  evaluatedAt: number;
  reclaimAvailableAt: number;
  evaluationLocked: boolean;
  evaluationAttempted: boolean;
  reclaimed: boolean;
  submissionDeadline: number;
  decision: string;
  decisionReason: string;
  evidenceDigest: string;
}

export interface EscrowSnapshot {
  grant: Grant;
  milestones: Milestone[];
  mode: "live" | "unconfigured";
  fetchedAt: number;
}

export interface WalletState {
  address: string | null;
  balance: bigint;
  chainId: number | null;
}

export type TransactionStage =
  | "idle"
  | "signing"
  | "submitted"
  | "accepted"
  | "finalized"
  | "failed";

export interface TransactionState {
  stage: TransactionStage;
  action: string;
  hash: string;
  error: string;
}
