import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  BadgeCheck,
  BookOpen,
  Check,
  ChevronDown,
  CircleAlert,
  CircleDollarSign,
  Code2,
  ExternalLink,
  FileCheck2,
  Github,
  HandCoins,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Menu,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Wallet,
  X,
} from "lucide-react";
import {
  addMilestone,
  claimFunds,
  depositGrant,
  evaluateMilestone,
  getEscrowSnapshot,
  reclaimRejected,
  reclaimUnallocated,
  reclaimUnsubmitted,
  setAdmin,
  setPaused,
  submitDeliverable,
  type StageListener,
} from "./lib/contract";
import { CHAIN_ID, CONTRACT_ADDRESS, DEPLOYMENT_STATUS, EXPLORER_URL, NETWORK_LABEL } from "./config";
import { stringifyError } from "./lib/errors";
import { useWallet } from "./hooks/useWallet";
import type { EscrowSnapshot, Milestone, TransactionState } from "./types";

const EMPTY_TX: TransactionState = { stage: "idle", action: "", hash: "", error: "" };

function formatGen(value: bigint, precision = 2): string {
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, "0").slice(0, precision);
  return `${whole.toLocaleString()}${precision ? `.${fraction}` : ""}`;
}

function parseGen(value: string): bigint {
  const clean = value.trim();
  if (!/^\d+(?:\.\d{0,18})?$/.test(clean)) throw new Error("Amount must be a positive GEN value.");
  const [whole, fraction = ""] = clean.split(".");
  const result = BigInt(whole) * 10n ** 18n + BigInt((fraction + "0".repeat(18)).slice(0, 18) || "0");
  if (result <= 0n) throw new Error("Amount must be greater than zero.");
  return result;
}

function shortAddress(value: string | null): string {
  if (!value) return "Connect wallet";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatTime(timestamp: number): string {
  if (!timestamp) return "Not available";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(
    new Date(timestamp * 1000),
  );
}

function remainingTime(timestamp: number): string {
  if (!timestamp) return "No timer";
  const seconds = timestamp - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return "Open now";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function errorText(error: unknown): string {
  return stringifyError(error).replace(/^.*\[(EXPECTED|EXTERNAL|TRANSIENT|LLM_ERROR)\]\s*/, "").slice(0, 420);
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

function roleFor(snapshot: EscrowSnapshot | null, address: string | null): string {
  if (!snapshot || !address) return "Observer";
  const normalized = address.toLowerCase();
  if (normalized === snapshot.grant.owner) return "Owner";
  if (normalized === snapshot.grant.creator) return "Creator";
  if (normalized === snapshot.grant.funder) return "Funder";
  if (normalized === snapshot.grant.admin) return "Admin";
  return "Observer";
}

function canEvaluate(snapshot: EscrowSnapshot | null, address: string | null): boolean {
  if (!snapshot || !address) return false;
  const normalized = address.toLowerCase();
  return [snapshot.grant.owner, snapshot.grant.funder, snapshot.grant.admin].includes(normalized);
}

function canReclaim(snapshot: EscrowSnapshot | null, address: string | null): boolean {
  if (!snapshot || !address) return false;
  const normalized = address.toLowerCase();
  return [snapshot.grant.owner, snapshot.grant.funder].includes(normalized);
}

function canClaim(snapshot: EscrowSnapshot | null, address: string | null): boolean {
  if (!snapshot || !address) return false;
  const normalized = address.toLowerCase();
  return [snapshot.grant.creator, snapshot.grant.funder].includes(normalized);
}

function statusLabel(milestone: Milestone): string {
  if (milestone.status === "APPROVED") return "Approved";
  if (milestone.status === "REJECTED") return milestone.reclaimed ? "Reclaimed" : "Review failed";
  if (milestone.evaluationLocked) return "Review running";
  if (milestone.submittedAt) return "Awaiting review";
  return "Awaiting delivery";
}

function statusClass(milestone: Milestone): string {
  if (milestone.status === "APPROVED") return "status-approved";
  if (milestone.status === "REJECTED") return milestone.reclaimed ? "status-reclaimed" : "status-rejected";
  if (milestone.evaluationLocked) return "status-running";
  if (milestone.submittedAt) return "status-review";
  return "status-pending";
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

function ActionButton({
  children,
  icon,
  onClick,
  disabled = false,
  tone = "default",
}: {
  children: ReactNode;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "cyan" | "amber" | "quiet";
}) {
  return (
    <button className={`action-button action-${tone}`} type="button" onClick={onClick} disabled={disabled}>
      {icon}
      <span>{children}</span>
    </button>
  );
}

function App() {
  const wallet = useWallet();
  const [snapshot, setSnapshot] = useState<EscrowSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState("");
  const [tx, setTx] = useState<TransactionState>(EMPTY_TX);
  const [mobileNav, setMobileNav] = useState(false);
  const [openFaq, setOpenFaq] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const [milestoneForm, setMilestoneForm] = useState({ id: "", description: "", proof: "", amount: "" });
  const [deliverableForm, setDeliverableForm] = useState({ id: "", url: "", description: "" });
  const [depositForm, setDepositForm] = useState("");
  const [adminForm, setAdminForm] = useState("");

  const loadSnapshot = async () => {
    setLoading(true);
    setReadError("");
    try {
      setSnapshot(await getEscrowSnapshot());
    } catch (error) {
      setReadError(errorText(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSnapshot();
  }, [refreshTick]);

  const now = Math.floor(Date.now() / 1000);
  const grant = snapshot?.grant;
  const role = roleFor(snapshot, wallet.address);
  const txBusy = tx.stage === "signing" || tx.stage === "submitted" || tx.stage === "accepted";
  const adminAuthorized = Boolean(grant && wallet.address && [grant.owner, grant.admin].includes(wallet.address));
  const ownerAuthorized = Boolean(grant && wallet.address && grant.owner === wallet.address);
  const reclaimAuthorized = canReclaim(snapshot, wallet.address);
  const evaluateAuthorized = canEvaluate(snapshot, wallet.address);
  const claimAuthorized = canClaim(snapshot, wallet.address);
  const writesAllowed = Boolean(wallet.supportedChain && !grant?.paused && !txBusy);
  const fundAuthorized = Boolean(grant && wallet.address && [grant.owner, grant.funder].includes(wallet.address));
  const unallocated = grant ? grant.totalGrantAmount - grant.allocatedFunds - grant.unallocatedReclaimedFunds : 0n;
  const fundingRemaining = grant ? grant.totalGrantAmount - grant.fundedAmount : 0n;
  const pendingPayout = grant
    ? wallet.address === grant.creator
      ? grant.creatorPendingPayout
      : wallet.address === grant.funder
        ? grant.funderPendingPayout
        : 0n
    : 0n;

  const progress = useMemo(() => {
    if (!grant || grant.totalGrantAmount === 0n) return 0;
    return Number((grant.releasedFunds * 100n) / grant.totalGrantAmount);
  }, [grant]);

  const runAction = async (action: string, operation: (onStage: StageListener) => Promise<string>) => {
    setTx({ stage: "signing", action, hash: "", error: "" });
    try {
      const hash = await operation((stage, stageHash, stageError) => {
        setTx({ stage, action, hash: stageHash || "", error: stageError || "" });
      });
      setTx((current) => ({ ...current, hash, stage: current.stage === "failed" ? "failed" : current.stage }));
      setRefreshTick((tick) => tick + 1);
    } catch (error) {
      setTx({ stage: "failed", action, hash: "", error: errorText(error) });
    }
  };

  const handleAddMilestone = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const id = Number(milestoneForm.id);
      if (!Number.isInteger(id) || id <= 0) throw new Error("Milestone ID must be a positive integer.");
      const amount = parseGen(milestoneForm.amount);
      if (!milestoneForm.description.trim() || !milestoneForm.proof.trim()) {
        throw new Error("Description and proof requirements are required.");
      }
      await runAction(`Allocate milestone ${id}`, (onStage) =>
        addMilestone(id, milestoneForm.description, milestoneForm.proof, amount, onStage),
      );
      setMilestoneForm({ id: "", description: "", proof: "", amount: "" });
    } catch (error) {
      setTx({ stage: "failed", action: "Allocate milestone", hash: "", error: errorText(error) });
    }
  };

  const handleSubmitDeliverable = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const id = Number(deliverableForm.id);
      if (!Number.isInteger(id) || id <= 0) throw new Error("Choose a milestone before submitting.");
      if (!deliverableForm.url.trim().startsWith("https://")) throw new Error("Evidence URL must use HTTPS.");
      if (!deliverableForm.description.trim()) throw new Error("Submission description is required.");
      await runAction(`Submit evidence for ${id}`, (onStage) =>
        submitDeliverable(id, deliverableForm.url, deliverableForm.description, onStage),
      );
      setDeliverableForm({ id: "", url: "", description: "" });
    } catch (error) {
      setTx({ stage: "failed", action: "Submit deliverable", hash: "", error: errorText(error) });
    }
  };

  const handleDeposit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const amount = parseGen(depositForm);
      if (grant && amount > fundingRemaining) {
        throw new Error("Deposit exceeds the remaining amount needed to fully fund the grant.");
      }
      await runAction("Deposit grant funds", (onStage) => depositGrant(amount, onStage));
      setDepositForm("");
    } catch (error) {
      setTx({ stage: "failed", action: "Deposit grant funds", hash: "", error: errorText(error) });
    }
  };

  const handleSetAdmin = async (event: FormEvent) => {
    event.preventDefault();
    if (!isAddress(adminForm)) {
      setTx({ stage: "failed", action: "Set admin", hash: "", error: "Enter a valid 20-byte wallet address." });
      return;
    }
    await runAction("Set administrator", (onStage) => setAdmin(adminForm.trim(), onStage));
    setAdminForm("");
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="AI Venture Escrow home">
          <span className="brand-mark"><ShieldCheck size={20} /></span>
          <span>
            <strong>AI VENTURE</strong>
            <small>ESCROW / SETTLEMENT CONSOLE</small>
          </span>
        </a>
        <nav className={mobileNav ? "main-nav nav-open" : "main-nav"} aria-label="Primary navigation">
          <a href="#workspace" onClick={() => setMobileNav(false)}>Workspace</a>
          <a href="#protocol" onClick={() => setMobileNav(false)}>Protocol</a>
          <a href="#faq" onClick={() => setMobileNav(false)}>FAQ</a>
        </nav>
        <div className="topbar-actions">
          <div className="network-chip"><span className="pulse-dot" />{NETWORK_LABEL}<b>#{CHAIN_ID}</b></div>
          {wallet.address ? (
            <button className="wallet-chip" type="button" onClick={wallet.disconnect} title="Disconnect wallet">
              <Wallet size={15} /><span>{shortAddress(wallet.address)}</span><X size={13} />
            </button>
          ) : (
            <button className="connect-button" type="button" onClick={() => void wallet.connect()} disabled={wallet.connecting}>
              {wallet.connecting ? <LoaderCircle size={16} className="spin" /> : <Wallet size={16} />}
              {wallet.connecting ? "Connecting" : "Connect wallet"}
            </button>
          )}
          <button className="menu-button" type="button" aria-label="Toggle navigation" onClick={() => setMobileNav((open) => !open)}>
            {mobileNav ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </header>

      <main id="top">
        <section className="hero section-wrap">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-line" />NATIVE GEN / MILESTONE SETTLEMENT</div>
            <h1>Ship the work.<br /><em>Release the proof.</em></h1>
            <p className="hero-lede">An escrow rail for AI ventures where milestone evidence is reviewed by independent GenLayer validators before funds move.</p>
            <div className="hero-actions">
              <a className="primary-cta" href="#workspace"><LayoutDashboard size={17} />Open workspace <ArrowRight size={16} /></a>
              <a className="text-link" href="#protocol">Read the protocol <ArrowDownToLine size={15} /></a>
            </div>
          </div>
          <div className="hero-instrument" aria-label="Escrow settlement status">
            <div className="instrument-top"><span>LIVE SETTLEMENT RAIL</span><span className="mono">GL / 61999</span></div>
            <div className="rail-visual">
              <div className="rail-track"><span style={{ height: `${progress}%` }} /></div>
              <div className="rail-nodes">
                <RailNode label="FUNDED" active={Boolean(grant?.fundedAmount)} value={grant ? `${formatGen(grant.fundedAmount)} / ${formatGen(grant.totalGrantAmount)} GEN` : "Awaiting deposit"} />
                <RailNode label="ALLOCATED" active={Boolean(grant?.allocatedFunds)} value={grant ? `${formatGen(grant.allocatedFunds)} GEN` : "No milestones"} />
                <RailNode label="RELEASED" active={Boolean(grant?.releasedFunds)} value={grant ? `${formatGen(grant.releasedFunds)} GEN` : "No settlements"} />
              </div>
            </div>
            <div className="instrument-foot"><span>CONSENSUS GATE</span><strong>{grant?.paused ? "PAUSED" : "ARMED"}</strong></div>
          </div>
        </section>

        <section className="signal-strip section-wrap" aria-label="Escrow statistics">
          <Stat label="Declared total" value={grant ? `${formatGen(grant.totalGrantAmount)} GEN` : "--"} icon={<CircleDollarSign size={18} />} />
          <Stat label="Funded (deposited)" value={grant ? `${formatGen(grant.fundedAmount)} GEN` : "--"} icon={<ArrowDownToLine size={18} />} />
          <Stat label="In escrow" value={grant ? `${formatGen(grant.escrowedFunds)} GEN` : "--"} icon={<LockKeyhole size={18} />} />
          <Stat label="Released" value={grant ? `${formatGen(grant.releasedFunds)} GEN` : "--"} icon={<BadgeCheck size={18} />} />
        </section>

        <section className="workspace section-wrap" id="workspace">
          <div className="section-heading">
            <div><div className="eyebrow"><span className="eyebrow-line" />OPERATOR WORKSPACE</div><h2>Grant ledger</h2></div>
            <div className="heading-meta"><span className="role-chip">{role}</span><button className="icon-button" type="button" onClick={() => setRefreshTick((tick) => tick + 1)} title="Refresh contract state"><RefreshCw size={16} className={loading ? "spin" : ""} /></button></div>
          </div>

          {wallet.error ? <Notice tone="warning" icon={<CircleAlert size={17} />} message={wallet.error} /> : null}
          {!wallet.supportedChain && wallet.address ? <Notice tone="warning" icon={<CircleAlert size={17} />} message={`Wallet is on chain ${wallet.chainId ?? "unknown"}. Switch to ${NETWORK_LABEL} (chain ${CHAIN_ID}) to transact.`} /> : null}
          {tx.error ? <Notice tone="danger" icon={<CircleAlert size={17} />} message={`${tx.action}: ${tx.error}`} /> : null}
          {tx.stage !== "idle" && !tx.error ? <TransactionNotice tx={tx} /> : null}

          {!CONTRACT_ADDRESS ? <DeploymentNotice /> : null}
          {loading && CONTRACT_ADDRESS ? <LoadingState /> : null}
          {readError && CONTRACT_ADDRESS ? <Notice tone="danger" icon={<CircleAlert size={17} />} message={readError} action={<button className="inline-action" type="button" onClick={() => setRefreshTick((tick) => tick + 1)}>Retry read</button>} /> : null}

          <div className="ledger-layout">
            <div className="ledger-main">
              <div className="ledger-bar"><span>Milestone sequence</span><span className="mono">{grant ? `${grant.milestoneCount} RECORDS / IMMUTABLE TRANCHE` : "NO DEPLOYMENT LINK"}</span></div>
              {snapshot?.milestones.length ? (
                <div className="milestone-list">
                  {snapshot.milestones.map((milestone, index) => (
                    <MilestoneRow
                      key={milestone.milestoneId}
                      milestone={milestone}
                      index={index}
                      now={now}
                      evaluateAuthorized={evaluateAuthorized}
                      reclaimAuthorized={reclaimAuthorized}
                      writesAllowed={writesAllowed}
                      onEvaluate={() => void runAction(`Evaluate milestone ${milestone.milestoneId}`, (onStage) => evaluateMilestone(milestone.milestoneId, onStage))}
                      onReclaimRejected={() => void runAction(`Reclaim milestone ${milestone.milestoneId}`, (onStage) => reclaimRejected(milestone.milestoneId, onStage))}
                      onReclaimUnsubmitted={() => void runAction(`Reclaim milestone ${milestone.milestoneId}`, (onStage) => reclaimUnsubmitted(milestone.milestoneId, onStage))}
                    />
                  ))}
                </div>
              ) : (
                <EmptyLedger configured={Boolean(CONTRACT_ADDRESS)} />
              )}
            </div>
            <aside className="ledger-side">
              <div className="side-block">
                <div className="side-label">Contract identity</div>
                <IdentityRow label="Funder" value={grant?.funder || "Not configured"} />
                <IdentityRow label="Creator" value={grant?.creator || "Not configured"} />
                <IdentityRow label="Admin" value={grant?.admin || "Not configured"} />
                <IdentityRow label="Owner" value={grant?.owner || "Not configured"} />
              </div>
              <div className="side-block balance-block">
                <div className="side-label">Escrow funding</div>
                <strong>{grant ? formatGen(grant.fundedAmount) : "0.00"}<small> / {grant ? formatGen(grant.totalGrantAmount) : "0.00"} GEN</small></strong>
                <p>Native GEN actually deposited versus the declared grant total. Deposits are accepted until the escrow is fully funded.</p>
                <form className="inline-amount-form" onSubmit={handleDeposit}>
                  <input value={depositForm} onChange={(event) => setDepositForm(event.target.value)} placeholder={grant ? `Up to ${formatGen(fundingRemaining)} GEN` : "Amount in GEN"} inputMode="decimal" disabled={!fundAuthorized || !writesAllowed || !CONTRACT_ADDRESS || fundingRemaining <= 0n} />
                  <button className="submit-button submit-cyan" type="submit" disabled={!fundAuthorized || !writesAllowed || !CONTRACT_ADDRESS || fundingRemaining <= 0n}><ArrowDownToLine size={15} />{grant && fundingRemaining <= 0n ? "Fully funded" : "Deposit grant"}</button>
                </form>
              </div>
              <div className="side-block balance-block">
                <div className="side-label">Available to claim</div>
                <strong>{grant && wallet.address === grant.creator ? formatGen(grant.creatorClaimableFunds) : grant && wallet.address === grant.funder ? formatGen(grant.funderClaimableFunds) : "0.00"}<small> GEN</small></strong>
                <p>Pull payments keep settlement separate from evaluation.</p>
                {pendingPayout > 0n ? <div className="pending-note"><RefreshCw size={13} /><span><strong>{formatGen(pendingPayout)} GEN dispatched, pending settlement.</strong> Claimed funds are recorded on-chain as pending to your address. If a native send does not land, the entitlement is preserved by the escrow accounting: it is pending, not permanently failed.</span></div> : null}
                <ActionButton icon={<HandCoins size={15} />} onClick={() => void runAction("Claim available funds", (onStage) => claimFunds(onStage))} disabled={!claimAuthorized || !writesAllowed || !grant || (wallet.address === grant.creator ? grant.creatorClaimableFunds <= 0n : grant.funderClaimableFunds <= 0n)} tone="cyan">Claim funds</ActionButton>
              </div>
              <div className="side-block">
                <div className="side-label">Unallocated pool</div>
                <strong>{grant ? formatGen(unallocated) : "0.00"}<small> GEN</small></strong>
                <p>Funds not assigned to a milestone remain recoverable by the funder.</p>
                <ActionButton icon={<RotateCcw size={15} />} onClick={() => void runAction("Reclaim unallocated funds", (onStage) => reclaimUnallocated(onStage))} disabled={!reclaimAuthorized || !writesAllowed || unallocated <= 0n} tone="quiet">Reclaim pool</ActionButton>
              </div>
            </aside>
          </div>
        </section>

        <section className="forms-section section-wrap">
          <div className="section-heading compact"><div><div className="eyebrow"><span className="eyebrow-line" />CONTROL SURFACE</div><h2>Move the work forward</h2></div><span className="section-note">Role: {role}</span></div>
          <div className="form-grid">
            <form className="operation-form" onSubmit={handleAddMilestone}>
              <div className="form-title"><span className="form-icon"><Plus size={17} /></span><div><h3>Allocate a tranche</h3><p>Owner or admin defines the immutable milestone gate.</p></div></div>
              <div className="two-fields">
                <Field label="Milestone ID"><input value={milestoneForm.id} onChange={(event) => setMilestoneForm({ ...milestoneForm, id: event.target.value })} placeholder={String((grant?.milestoneCount || 0) + 1)} inputMode="numeric" /></Field>
                <Field label="Funding amount" hint="Native GEN"><input value={milestoneForm.amount} onChange={(event) => setMilestoneForm({ ...milestoneForm, amount: event.target.value })} placeholder="10.00" inputMode="decimal" /></Field>
              </div>
              <Field label="Milestone description"><textarea value={milestoneForm.description} onChange={(event) => setMilestoneForm({ ...milestoneForm, description: event.target.value })} placeholder="What must be true when this tranche is complete?" rows={3} /></Field>
              <Field label="Required proof"><textarea value={milestoneForm.proof} onChange={(event) => setMilestoneForm({ ...milestoneForm, proof: event.target.value })} placeholder="Link, artifact, or acceptance criteria validators should inspect." rows={3} /></Field>
              <button className="submit-button" type="submit" disabled={!adminAuthorized || !writesAllowed || !CONTRACT_ADDRESS}><Plus size={16} />Allocate milestone</button>
            </form>

            <form className="operation-form" onSubmit={handleSubmitDeliverable}>
              <div className="form-title"><span className="form-icon form-icon-cyan"><Send size={17} /></span><div><h3>Submit evidence</h3><p>Creator posts one HTTPS page and a concise handoff.</p></div></div>
              <Field label="Milestone"><select value={deliverableForm.id} onChange={(event) => setDeliverableForm({ ...deliverableForm, id: event.target.value })}><option value="">Choose a pending milestone</option>{snapshot?.milestones.filter((milestone) => milestone.status === "PENDING" && !milestone.submittedAt).map((milestone) => <option key={milestone.milestoneId} value={milestone.milestoneId}>M{String(milestone.milestoneId).padStart(2, "0")} / {formatGen(milestone.fundingAmount)} GEN</option>)}</select></Field>
              <Field label="Evidence URL" hint="HTTPS required"><div className="input-with-icon"><Link2 size={16} /><input value={deliverableForm.url} onChange={(event) => setDeliverableForm({ ...deliverableForm, url: event.target.value })} placeholder="https://github.com/you/project" /></div></Field>
              <Field label="Submission description"><textarea value={deliverableForm.description} onChange={(event) => setDeliverableForm({ ...deliverableForm, description: event.target.value })} placeholder="Tell the validators what changed and where to verify it." rows={5} /></Field>
              <button className="submit-button submit-cyan" type="submit" disabled={!snapshot || wallet.address !== snapshot.grant.creator || !writesAllowed || !CONTRACT_ADDRESS}><Send size={16} />Submit deliverable</button>
            </form>
          </div>

          <div className="admin-bar">
            <div className="admin-copy"><Settings2 size={18} /><div><strong>Protocol controls</strong><span>Emergency pause and administrator rotation are owner-only.</span></div></div>
            <div className="admin-actions">
              <form className="admin-form" onSubmit={handleSetAdmin}><input value={adminForm} onChange={(event) => setAdminForm(event.target.value)} placeholder="New admin 0x..." /><button type="submit" disabled={!ownerAuthorized || !writesAllowed || !CONTRACT_ADDRESS}>Set admin</button></form>
              <button className={grant?.paused ? "pause-toggle paused" : "pause-toggle"} type="button" onClick={() => void runAction(grant?.paused ? "Resume contract" : "Pause contract", (onStage) => setPaused(!grant?.paused, onStage))} disabled={!ownerAuthorized || txBusy || !grant || !wallet.supportedChain}>{grant?.paused ? <Play size={15} /> : <Pause size={15} />}{grant?.paused ? "Resume" : "Pause"}</button>
            </div>
          </div>
        </section>

        <section className="protocol-section section-wrap" id="protocol">
          <div className="section-heading compact"><div><div className="eyebrow"><span className="eyebrow-line" />THE SETTLEMENT LOOP</div><h2>Four gates. One honest rail.</h2></div><span className="section-note">No custody shortcuts</span></div>
          <div className="process-grid">
            <ProcessStep number="01" icon={<Wallet size={19} />} title="Fund" text="The funder deploys the grant with native GEN attached and keeps unused value recoverable." />
            <ProcessStep number="02" icon={<Github size={19} />} title="Submit" text="The creator posts one HTTPS evidence page before the submission deadline closes." />
            <ProcessStep number="03" icon={<Sparkles size={19} />} title="Evaluate" text="Independent validators fetch the same page and agree on the milestone decision." />
            <ProcessStep number="04" icon={<HandCoins size={19} />} title="Claim" text="Approved tranches become pull payments. A recipient chooses when to withdraw." />
          </div>
          <div className="protocol-callout"><TerminalSquare size={20} /><div><span className="mono">WHY THIS MATTERS</span><strong>Evidence is fenced before it reaches the evaluator.</strong><p>Untrusted pages are treated as evidence, never as instructions. The evaluation attempt is consumed before nondeterministic work begins.</p></div><ArrowRight size={20} /></div>
        </section>

        <section className="faq-section section-wrap" id="faq">
          <div className="faq-intro"><div className="eyebrow"><span className="eyebrow-line" />FIELD NOTES</div><h2>Questions before<br /><em>the first tranche.</em></h2><p>Short answers for funders, creators, and reviewers operating the rail.</p></div>
          <div className="faq-list">{FAQS.map((faq, index) => <div className={openFaq === index ? "faq-item faq-open" : "faq-item"} key={faq.question}><button type="button" onClick={() => setOpenFaq(openFaq === index ? -1 : index)} aria-expanded={openFaq === index}><span>{faq.question}</span><ChevronDown size={17} /></button>{openFaq === index ? <p>{faq.answer}</p> : null}</div>)}</div>
        </section>

        <footer className="footer section-wrap">
          <div className="footer-brand"><span className="brand-mark"><ShieldCheck size={18} /></span><div><strong>AI VENTURE ESCROW</strong><span>Milestone settlement for accountable AI work.</span></div></div>
          <div className="footer-links"><a href={CONTRACT_ADDRESS ? `${EXPLORER_URL}/address/${CONTRACT_ADDRESS}` : "#workspace"} target={CONTRACT_ADDRESS ? "_blank" : undefined} rel="noreferrer"><Code2 size={14} />Contract</a><a href="https://www.genlayer.com" target="_blank" rel="noreferrer"><ExternalLink size={14} />GenLayer</a><a href="#protocol"><BookOpen size={14} />Protocol notes</a></div>
          <div className="footer-status"><span className="pulse-dot" />{DEPLOYMENT_STATUS === "configured" ? "Deployment configured" : "Deployment address required"}<small>ASCII interface / v0.1</small></div>
        </footer>
      </main>
    </div>
  );
}

function RailNode({ label, value, active }: { label: string; value: string; active: boolean }) {
  return <div className={active ? "rail-node active" : "rail-node"}><span className="node-dot" /><div><small>{label}</small><strong>{value}</strong></div></div>;
}

function Stat({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return <div className="stat"><span className="stat-icon">{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>;
}

function Notice({ tone, icon, message, action }: { tone: "warning" | "danger"; icon: ReactNode; message: string; action?: ReactNode }) {
  return <div className={`notice notice-${tone}`}>{icon}<span>{message}</span>{action}</div>;
}

function TransactionNotice({ tx }: { tx: TransactionState }) {
  const label = tx.stage === "signing" ? "Waiting for wallet signature" : tx.stage === "submitted" ? "Transaction submitted" : tx.stage === "accepted" ? "Consensus accepted" : "Transaction finalized";
  return <div className="notice notice-cyan"><LoaderCircle size={17} className={tx.stage === "finalized" ? "" : "spin"} /><span><strong>{tx.action}:</strong> {label}{tx.hash ? <code>{shortAddress(tx.hash)}</code> : null}</span></div>;
}

function DeploymentNotice() {
  return <div className="deployment-notice"><div className="deployment-icon"><UnconfiguredIcon /></div><div><span className="eyebrow">READ-ONLY CONFIGURATION</span><h3>Link the verified Studionet contract to activate this rail.</h3><p>Set <code>VITE_CONTRACT_ADDRESS</code> to a deployed address. The console will stay readable without one and will never display invented escrow balances.</p><div className="config-line"><span className="mono">NETWORK</span><strong>GenLayer Studionet / 61999</strong><span className="config-separator" /><span className="mono">RPC</span><strong>Default chain endpoint</strong></div></div></div>;
}

function UnconfiguredIcon() {
  return <span className="unconfigured-icon"><span /><span /><span /></span>;
}

function LoadingState() {
  return <div className="loading-state"><LoaderCircle size={24} className="spin" /><span>Reading grant state from Studionet...</span></div>;
}

function EmptyLedger({ configured }: { configured: boolean }) {
  return <div className="empty-ledger"><div className="empty-grid" /><FileCheck2 size={26} /><strong>{configured ? "No milestones allocated" : "Milestone ledger is offline"}</strong><span>{configured ? "The funder or admin can define the first immutable tranche below." : "Configure a contract address to read the live milestone sequence."}</span></div>;
}

function IdentityRow({ label, value }: { label: string; value: string }) {
  return <div className="identity-row"><span>{label}</span><code>{value === "Not configured" ? value : shortAddress(value)}</code></div>;
}

function MilestoneRow({
  milestone,
  index,
  now,
  evaluateAuthorized,
  reclaimAuthorized,
  writesAllowed,
  onEvaluate,
  onReclaimRejected,
  onReclaimUnsubmitted,
}: {
  milestone: Milestone;
  index: number;
  now: number;
  evaluateAuthorized: boolean;
  reclaimAuthorized: boolean;
  writesAllowed: boolean;
  onEvaluate: () => void;
  onReclaimRejected: () => void;
  onReclaimUnsubmitted: () => void;
}) {
  const reviewOpen = milestone.evaluationAvailableAt > 0 && now >= milestone.evaluationAvailableAt;
  const submissionExpired = milestone.submissionDeadline > 0 && now >= milestone.submissionDeadline;
  const reclaimOpen = milestone.reclaimAvailableAt > 0 && now >= milestone.reclaimAvailableAt;
  return <article className="milestone-row">
    <div className="milestone-index"><span>{String(index + 1).padStart(2, "0")}</span><div className={`timeline-node ${statusClass(milestone)}`} /></div>
    <div className="milestone-content">
      <div className="milestone-heading"><div><span className="milestone-id">MILESTONE {String(milestone.milestoneId).padStart(2, "0")}</span><h3>{milestone.description}</h3></div><span className={`status-badge ${statusClass(milestone)}`}><span />{statusLabel(milestone)}</span></div>
      <div className="milestone-details"><div><span className="detail-label">TRANCHE</span><strong>{formatGen(milestone.fundingAmount)} <small>GEN</small></strong></div><div><span className="detail-label">REQUIRED PROOF</span><p>{milestone.requiredProof}</p></div><div><span className="detail-label">DEADLINE</span><p>{milestone.submittedAt ? `Review ${remainingTime(milestone.evaluationAvailableAt)}` : submissionExpired ? "Submission expired" : remainingTime(milestone.submissionDeadline)}</p></div></div>
      {milestone.submittedAt ? <div className="evidence-line"><Link2 size={14} /><a href={milestone.deliverableEvidenceUrl} target="_blank" rel="noreferrer">{milestone.deliverableEvidenceUrl}</a><span>{formatTime(milestone.submittedAt)}</span></div> : null}
      {milestone.decisionReason ? <div className="decision-line"><span className="mono">DECISION</span><span>{milestone.decisionReason}</span>{milestone.evidenceDigest ? <code>{milestone.evidenceDigest}</code> : null}</div> : null}
      <div className="milestone-actions">
        {milestone.status === "PENDING" && milestone.submittedAt && !milestone.evaluationAttempted ? <ActionButton icon={milestone.evaluationLocked ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />} onClick={onEvaluate} disabled={!evaluateAuthorized || !writesAllowed || !reviewOpen || milestone.evaluationLocked} tone="amber">{milestone.evaluationLocked ? "Validators running" : reviewOpen ? "Run AI consensus" : `Review opens in ${remainingTime(milestone.evaluationAvailableAt)}`}</ActionButton> : null}
        {milestone.status === "PENDING" && !milestone.submittedAt && submissionExpired ? <ActionButton icon={<RotateCcw size={15} />} onClick={onReclaimUnsubmitted} disabled={!reclaimAuthorized || !writesAllowed} tone="quiet">Reclaim expired tranche</ActionButton> : null}
        {milestone.status === "REJECTED" && !milestone.reclaimed ? <ActionButton icon={<RotateCcw size={15} />} onClick={onReclaimRejected} disabled={!reclaimAuthorized || !writesAllowed || !reclaimOpen} tone="quiet">{reclaimOpen ? "Reclaim rejected tranche" : `Reclaim opens in ${remainingTime(milestone.reclaimAvailableAt)}`}</ActionButton> : null}
        {milestone.status === "APPROVED" ? <span className="approved-note"><Check size={15} />Funds moved to creator claim balance</span> : null}
      </div>
    </div>
  </article>;
}

function ProcessStep({ number, icon, title, text }: { number: string; icon: ReactNode; title: string; text: string }) {
  return <div className="process-step"><div className="process-top"><span>{number}</span><span className="process-icon">{icon}</span></div><h3>{title}</h3><p>{text}</p></div>;
}

export default App;

const FAQS = [
  { question: "Who can define a milestone?", answer: "The contract owner or current admin can allocate a positive funding tranche while unallocated grant value remains. Each milestone's description, proof requirement, and amount are immutable after creation." },
  { question: "Why does review wait after submission?", answer: "A submission enters a dispute buffer before evaluation becomes available. This gives the funder a predictable observation window and makes the evaluation moment explicit on-chain." },
  { question: "What happens when validators reject the work?", answer: "The milestone becomes rejected and its tranche leaves the active reserve. After the reclaim buffer expires, the funder or owner can credit the amount back to the funder's claimable balance." },
  { question: "Can the creator evaluate their own work?", answer: "No. The contract explicitly rejects creator evaluation even when the creator also appears in another role. Evaluation is restricted to the owner, funder, or admin." },
  { question: "How do payouts leave the contract?", answer: "Payouts are pull-based. Approval or reclaiming credits a claimable balance; the eligible creator or funder calls claim_funds, which moves the amount into a pending payout and dispatches native GEN. A pending payout is recorded on-chain to the recipient: if a native send does not land, the escrow accounting preserves the entitlement, so the payout stays pending rather than being permanently failed or silently restored." },
];
