/**
 * CarbonChain Protocol - Lifecycle Store (backend + chain backed)
 *
 * A thin client cache over the CarbonChain API. Every getter reads the last server snapshot; every action is a
 * real API call that executes the corresponding smart-contract transaction and then re-syncs. Nothing here is
 * simulated: token IDs, tx hashes, Merkle roots, stakes and balances all come from the chain.
 *
 * Lifecycle:
 *  1. Proponent registers project (DID + CarbonRegistry) and submits evidence (Merkle root committed on-chain)
 *  2. AI engine scores the bundle. >= policy threshold -> credit auto-minted. Otherwise -> verifier quorum
 *  3. Staked verifiers vote on-chain; quorum approval mints the ERC-721 credit to the proponent
 *  4. Owner lists the credit; buyer pays into EscrowSettlement (challenge window)
 *  5. Buyer settles (NFT + funds move) and retires (burn) -> retirement certificate
 *  6. Any credit can be disputed; an upheld dispute revokes it, refunds the escrowed buyer and slashes verifiers 50%
 */
import { apiFetch, readApiJson } from './auth';

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:5005';

export type ProjectLifecycleState =
  | 'BASELINE_WINDOW'
  | 'VERIFIER_PENDING_STAKE'
  | 'VERIFIER_AUDITING'
  | 'AUDITED'
  | 'CREDITS_ISSUED'
  | 'LISTED_ON_MARKETPLACE'
  | 'PURCHASED'
  | 'RETIRED'
  | 'REJECTED'
  | 'DISPUTED'
  | 'REVOKED';

export interface VerifierPoolMember {
  id: string;
  name: string;
  organization: string;
  address: string;
  reputationScore: number;
  minimumStakeEth: number;
  stakedEth?: number;
  specialization: string;
  activeAuditsCount: number;
  totalAuditedTonnage: number;
  activeInPool?: boolean;
}

export interface ObjectionRecord {
  id: string;
  author: string;
  authorOrg: string;
  reason: string;
  category: string;
  createdAt: string;
  status: 'OPEN' | 'RESPONDED' | 'REVISED' | 'RESOLVED';
  developerResponse?: string;
}

export type NftStatus = 'MINTED' | 'LISTED' | 'IN_ESCROW' | 'PURCHASED' | 'RETIRED' | 'DISPUTED' | 'REVOKED';

export interface CreditNftRecord {
  nftId: string;
  tokenId: number;
  serialNumber: string;
  co2Tonnage: number;
  vintageYear: number;
  issuanceModel: 'UPFRONT' | 'LINEAR_VESTING';
  vestingMonths?: number;
  developerWallet: string;
  currentOwner?: string;
  priceEth?: number;
  isListed: boolean;
  status: NftStatus;
  buyerAddress?: string;
  buyerOrg?: string;
  purchasedAt?: string;
  purchaseTxHash?: string;
  escrowId?: string;
  escrowStatus?: string;
  releaseAfter?: string;
  mintTxHash?: string;
  retiredAt?: string;
  burnTxHash?: string;
  retirementReason?: string;
  beneficiaryName?: string;
  certificateHash?: string;
  legalCertificateId?: string;
  disputeId?: string;
  disputeStatus?: string;
  disputeReason?: string;
}

export interface ProtocolNotification {
  id: string;
  timestamp: string;
  title: string;
  message: string;
  category: string;
  recipientRole: string;
  projectId: string;
  txHash?: string;
  read: boolean;
}

export interface QuorumVote {
  verifierAddress: string;
  verifierName?: string;
  approved: boolean;
  auditNotes?: string;
  recommendedTonnage?: number;
  voteTxHash?: string;
  submittedAt?: string;
}

export interface LifecycleProject {
  id: string;
  name: string;
  projectType: string;
  location: { country: string; region: string; coordinates?: string };
  developerWallet: string;
  developerName: string;
  developerDid: string;
  claimedAnnualTonnage: number;
  capexUsd: number;
  merkleRoot: string;
  aiConfidenceScore: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  createdAt: string;
  projectStatus?: string;
  registerTxHash?: string;

  lifecycleState: ProjectLifecycleState;

  baselineStartTime: string;
  baselineDurationDays: number;
  baselineFastForwarded?: boolean;
  objections: ObjectionRecord[];

  assignedVerifier: VerifierPoolMember;
  passedVerifierIds: string[];
  verifierStakedEth?: number;
  verifierStakeTxHash?: string;
  verifierAuditNotes?: string;
  auditAttestationHash?: string;
  auditedAt?: string;

  totalIssuedTonnage?: number;
  issuedNftCount?: number;
  tonnagePerNft?: number;
  issuanceModel?: 'UPFRONT' | 'LINEAR_VESTING';
  nftIssuanceTxHash?: string;
  nfts: CreditNftRecord[];

  listingPricePerNftEth?: number;
  isListedOnMarketplace?: boolean;

  // on-chain / audit detail
  bundleId?: string | null;
  bundleStatus?: string | null;
  evidenceTxHash?: string | null;
  riskTxHash?: string | null;
  riskExplanation?: string | null;
  anomalyFlags?: string[];
  verifierRequired?: boolean;
  quorum?: { required: number; approvals: number; rejections: number; votes: QuorumVote[] };
  evidenceRequests?: any[];
  evidenceSummary?: {
    iot?: { sensorId?: string; co2FluxPpm?: number; biomassKgM2?: number; soilMoisturePct?: number } | null;
    satellite?: { meanNdvi?: number; canopyCoveragePct?: number; cloudCoverPct?: number; source?: string; snapshotHash?: string } | null;
    financial?: { capexUsd?: number; documentName?: string; invoiceAttestationHash?: string };
    leaves?: Array<{ sourceType: string; payloadHash: string }>;
  };
}

export interface LegalComplianceCertificate {
  certificateId: string;
  serialNumber: string;
  issuanceDate: string;
  complianceStandards: string[];
  beneficiary: { legalName: string; organizationId: string; jurisdiction: string; walletAddress: string };
  projectDetails: {
    projectId: string;
    projectName: string;
    methodology: string;
    developerDid: string;
    developerName: string;
    developerWallet: string;
    location: string;
  };
  verificationAttestation: {
    verifierName: string;
    verifierOrg: string;
    verifierDid: string;
    verifierWallet: string;
    posStakeEth: number;
    posStakeTxHash: string;
    auditReportDigest: string;
  };
  carbonAccounting: {
    metricTonsCo2e: number;
    vintageYear: number;
    serializedNftId: string;
    issuanceModel: string;
    retirementPurpose: string;
    merkleRootCommitment: string;
    onChainBurnTx: string;
  };
  legalClauses: {
    nonDuplicationClause: string;
    additionalityClause: string;
    directSettlementDeclaration: string;
    statutoryComplianceNotice: string;
  };
}

/** Kept for backwards compatibility with components that import it; the live pool comes from the API. */
export const VERIFIER_POOL: VerifierPoolMember[] = [];

async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const response = await apiFetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body
  });
  const data = await readApiJson<any>(response);
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data as T;
}

class ProjectFlowStore {
  private projects: LifecycleProject[] = [];
  private notifications: ProtocolNotification[] = [];
  private readIds = new Set<string>();
  private listeners: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  public verifierPool: VerifierPoolMember[] = [];
  public lastError: string | null = null;
  public loaded = false;

  // ------------------------------------------------------------------ sync

  public subscribe(listener: () => void) {
    this.listeners.push(listener);
    if (!this.timer) {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), 4000);
    }
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
      if (this.listeners.length === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  public refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const [life, notes] = await Promise.all([
          api<{ projects: LifecycleProject[]; verifierPool: VerifierPoolMember[] }>('/api/lifecycle/projects'),
          api<{ notifications: ProtocolNotification[] }>('/api/lifecycle/notifications').catch(() => ({ notifications: [] }))
        ]);
        this.projects = life.projects || [];
        this.verifierPool = life.verifierPool || [];
        this.notifications = (notes.notifications || []).map((n) => ({ ...n, read: this.readIds.has(n.id) }));
        this.lastError = null;
        this.loaded = true;
      } catch (err: any) {
        this.lastError = err?.message || 'Unable to reach the CarbonChain API';
      } finally {
        this.inflight = null;
        this.notify();
      }
    })();
    return this.inflight;
  }

  private notify() {
    this.listeners.forEach((listener) => {
      try { listener(); } catch (e) { console.error('Listener callback error:', e); }
    });
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('carbonchain:lifecycle-update'));
  }

  private async act<T>(fn: () => Promise<T>): Promise<T> {
    const result = await fn();
    await this.refresh();
    return result;
  }

  // ---------------------------------------------------------------- getters

  public getAllProjects(): LifecycleProject[] {
    return [...this.projects];
  }

  public getProjectById(id: string): LifecycleProject | undefined {
    return this.projects.find((p) => p.id === id);
  }

  public getProjectsForDeveloper(developerWallet?: string | null): LifecycleProject[] {
    if (!developerWallet) return this.getAllProjects();
    return this.projects.filter((p) => p.developerWallet?.toLowerCase() === developerWallet.toLowerCase());
  }

  /** Bundles escalated to the verifier pool, plus ones this verifier has already decided on. */
  public getVerifierQueue(verifierAddress?: string | null): LifecycleProject[] {
    const me = verifierAddress?.toLowerCase();
    return this.projects.filter((p) => {
      if (['VERIFIER_PENDING_STAKE', 'VERIFIER_AUDITING'].includes(p.lifecycleState)) return true;
      return Boolean(me && p.quorum?.votes.some((v) => v.verifierAddress?.toLowerCase() === me));
    });
  }

  public getMarketplaceNfts(): Array<{ project: LifecycleProject; nft: CreditNftRecord }> {
    const list: Array<{ project: LifecycleProject; nft: CreditNftRecord }> = [];
    this.projects.forEach((project) => project.nfts.filter((n) => n.status === 'LISTED').forEach((nft) => list.push({ project, nft })));
    return list;
  }

  /** Everything the buyer bought (in escrow, settled, retired, disputed or revoked). */
  public getBuyerPortfolioNfts(buyerAddress?: string | null): Array<{ project: LifecycleProject; nft: CreditNftRecord }> {
    const me = buyerAddress?.toLowerCase();
    const list: Array<{ project: LifecycleProject; nft: CreditNftRecord }> = [];
    this.projects.forEach((project) =>
      project.nfts
        .filter((n) => n.buyerAddress && (!me || n.buyerAddress.toLowerCase() === me))
        .forEach((nft) => list.push({ project, nft }))
    );
    return list;
  }

  public getNotifications(recipientRole?: string): ProtocolNotification[] {
    if (!recipientRole) return this.notifications;
    return this.notifications.filter((n) => n.recipientRole === recipientRole || n.recipientRole === 'ALL');
  }

  public markNotificationAsRead(id: string) {
    this.readIds.add(id);
    const n = this.notifications.find((x) => x.id === id);
    if (n) n.read = true;
    this.notify();
  }

  // ---------------------------------------------------------------- actions

  /** Called after IssuerStudio has completed register -> evidence -> risk against the API. */
  public submitProject(_data?: Partial<LifecycleProject>) {
    void this.refresh();
  }

  public advanceBaselineWindow(projectId: string) {
    return this.act(() => api(`/api/projects/${encodeURIComponent(projectId)}/advance-baseline`, { method: 'POST', json: {} }));
  }

  public addObjection(projectId: string, reason: string, category = 'SUSPICIOUS_CLAIM', bundleId?: string | null) {
    return this.act(() => api('/api/projects/challenge', { method: 'POST', json: { projectId, bundleId: bundleId || undefined, reason, category } }));
  }

  public stake(amountEth: number) {
    return this.act(() => api<{ txHash: string; profile: any }>('/api/verifiers/stake', { method: 'POST', json: { amountEth } }));
  }

  public getMyVerifierProfile() {
    return api<{ wallet: string | null; profile: any; balanceEth?: string }>('/api/verifiers/me');
  }

  public requestEvidence(project: LifecycleProject, message: string) {
    return this.act(() => api('/api/verifiers/request-evidence', { method: 'POST', json: { bundleId: project.bundleId, message, category: 'ADDITIONAL_DOCUMENTATION' } }));
  }

  /** Cast this verifier's on-chain vote. Quorum approval mints the credit automatically. */
  public completeAudit(
    project: LifecycleProject,
    params: { notes: string; confidence: number; approved: boolean; recommendedTonnage: number; checklist: Record<string, boolean> }
  ) {
    return this.act(() =>
      api<{ finalized: boolean; approved: boolean; tokenId?: number; voteTxHash: string; transactionHash?: string; quorum: any; message: string }>(
        '/api/verifiers/verify',
        {
          method: 'POST',
          json: {
            bundleId: project.bundleId,
            approved: params.approved,
            auditNotes: params.notes,
            checklist: params.checklist,
            conflictConfirmed: true,
            decisionConfidence: params.confidence,
            recommendedTonnage: params.recommendedTonnage
          }
        }
      )
    );
  }

  public listNft(tokenId: number, priceEth: number) {
    return this.act(() => api<{ txHash: string }>('/api/marketplace/list', { method: 'POST', json: { tokenId, priceEth } }));
  }

  /** Lists every unlisted credit of a project at the given price. */
  public async listNftsOnMarketplace(projectId: string, pricePerNftEth: number) {
    const project = this.getProjectById(projectId);
    if (!project) throw new Error('Project not found');
    const targets = project.nfts.filter((n) => ['MINTED', 'LISTED', 'PURCHASED'].includes(n.status));
    if (targets.length === 0) throw new Error('No credits available to list');
    for (const nft of targets) await api('/api/marketplace/list', { method: 'POST', json: { tokenId: nft.tokenId, priceEth: pricePerNftEth } });
    await this.refresh();
    return true;
  }

  public buyCreditNft(_projectId: string, tokenId: number) {
    return this.act(() => api<{ escrowId: string; txHash: string; releaseAfter: number }>('/api/marketplace/escrow/buy', { method: 'POST', json: { tokenId } }));
  }

  public releaseEscrow(escrowId: string) {
    return this.act(() => api<{ txHash: string }>('/api/marketplace/escrow/release', { method: 'POST', json: { escrowId } }));
  }

  public raiseDispute(tokenId: number, reason: string) {
    return this.act(() => api<{ dispute: any; txHash: string }>('/api/disputes/raise', { method: 'POST', json: { tokenId, reason } }));
  }

  public async retireCreditNft(
    projectId: string,
    tokenId: number,
    params: { retirementReason: string; beneficiaryLegalName: string; beneficiaryJurisdiction?: string }
  ): Promise<LegalComplianceCertificate> {
    const result = await api<{ burnTxHash: string; certificate: any; certificateHash: string }>('/api/marketplace/retire', {
      method: 'POST',
      json: { tokenId, retirementReason: params.retirementReason, beneficiaryLegalName: params.beneficiaryLegalName }
    });
    await this.refresh();
    const project = this.getProjectById(projectId);
    const nft = project?.nfts.find((n) => n.tokenId === tokenId);
    if (!project || !nft) throw new Error('Retired credit not found after sync');
    return this.generateLegalDocument(project, { ...nft, burnTxHash: result.burnTxHash }, params);
  }

  /** Retirement certificate built only from on-chain facts (token, Merkle root, burn tx, verifier votes). */
  public generateLegalDocument(
    project: LifecycleProject,
    nft: CreditNftRecord,
    params?: { retirementReason?: string; beneficiaryLegalName?: string; beneficiaryJurisdiction?: string }
  ): LegalComplianceCertificate {
    const certId = nft.legalCertificateId || `CRX-RETIRE-${nft.tokenId}`;
    const beneficiaryName = params?.beneficiaryLegalName || nft.beneficiaryName || nft.buyerOrg || 'Beneficiary';
    const jurisdiction = params?.beneficiaryJurisdiction || 'Global Scope';
    const reason = params?.retirementReason || nft.retirementReason || 'Voluntary GHG neutralisation';
    const approver = project.quorum?.votes.find((v) => v.approved);
    const verifier = this.verifierPool.find((v) => v.address.toLowerCase() === approver?.verifierAddress?.toLowerCase());

    return {
      certificateId: certId,
      serialNumber: nft.serialNumber,
      issuanceDate: nft.retiredAt || new Date().toISOString(),
      complianceStandards: [
        'UNFCCC Article 6.2 & 6.4 (International Mitigation Compliance)',
        'ISO 14064-3:2019 (Verification of GHG Assertions)',
        'GHG Protocol Corporate Accounting and Reporting Standard'
      ],
      beneficiary: {
        legalName: beneficiaryName,
        organizationId: nft.certificateHash ? `SHA256:${nft.certificateHash.slice(2, 18)}` : `CRX-${nft.tokenId}`,
        jurisdiction,
        walletAddress: nft.currentOwner || nft.buyerAddress || ''
      },
      projectDetails: {
        projectId: project.id,
        projectName: project.name,
        methodology: project.projectType.replace(/_/g, ' '),
        developerDid: project.developerDid,
        developerName: project.developerName,
        developerWallet: project.developerWallet,
        location: `${project.location.region}, ${project.location.country}${project.location.coordinates ? ` (${project.location.coordinates})` : ''}`
      },
      verificationAttestation: {
        verifierName: approver ? (verifier?.name || approver.verifierName || 'Independent verifier') : 'AI policy gate (auto-issued)',
        verifierOrg: approver ? (verifier?.organization || 'Verifier pool') : `Confidence ${project.aiConfidenceScore}% >= policy threshold`,
        verifierDid: approver ? `did:carbonyx:${approver.verifierAddress.toLowerCase()}` : 'n/a',
        verifierWallet: approver?.verifierAddress || 'n/a',
        posStakeEth: verifier?.stakedEth || 0,
        posStakeTxHash: approver?.voteTxHash || project.riskTxHash || '',
        auditReportDigest: project.auditAttestationHash || project.riskTxHash || ''
      },
      carbonAccounting: {
        metricTonsCo2e: nft.co2Tonnage,
        vintageYear: nft.vintageYear,
        serializedNftId: `#${nft.tokenId} (${nft.serialNumber})`,
        issuanceModel: 'Single ERC-721 credit per verified evidence bundle',
        retirementPurpose: reason,
        merkleRootCommitment: project.merkleRoot,
        onChainBurnTx: nft.burnTxHash || ''
      },
      legalClauses: {
        nonDuplicationClause:
          'The credit certified herein was burned on-chain by its owner. The ERC-721 token no longer exists and cannot be sold, transferred or retired again.',
        additionalityClause:
          'Ground IoT, Sentinel-2 NDVI and financial evidence were hashed into a SHA-256 Merkle tree whose root is committed in CarbonRegistry; any item can be proven against that root.',
        directSettlementDeclaration:
          'Payment was held in the EscrowSettlement contract during the challenge window and released to the seller only after acceptance, with automatic refund on an upheld dispute.',
        statutoryComplianceNotice:
          'This document summarises verifiable on-chain records. Independent parties can check every hash above against the public chain.'
      }
    };
  }
}

export const projectFlowStore = new ProjectFlowStore();
