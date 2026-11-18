import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { authenticate } from '../auth/middleware';
import { RelayerService } from '../services/relayer.service';
import { fail, getPolicy } from './helpers';

/**
 * Read model for the frontend: every project with its derived lifecycle state, evidence, AI assessment,
 * verifier quorum and credit NFTs, built from the DB mirror of on-chain state.
 */
const router = Router();

const lower = (v: any) => String(v || '').toLowerCase();

function nftStatus(c: any, developer: string): string {
  if (c.status === 'RETIRED') return 'RETIRED';
  if (c.status === 'REVOKED') return 'REVOKED';
  if (c.status === 'DISPUTED') return 'DISPUTED';
  if (c.status === 'ESCROWED') return 'IN_ESCROW';
  if (Number(c.listing_price_eth) > 0) return 'LISTED';
  if (lower(c.current_owner) !== lower(developer)) return 'PURCHASED';
  return 'MINTED';
}

router.get('/projects', authenticate, async (_req: Request, res: Response) => {
  try {
    const [projects, bundles, risks, items, credits, escrows, users, verifiers, objections, disputes] = await Promise.all([
      supabase.from('projects').select('*').order('created_at', { ascending: false }),
      supabase.from('evidence_bundles').select('*').order('created_at', { ascending: false }),
      supabase.from('risk_assessments').select('*'),
      supabase.from('evidence_items').select('id, bundle_id, source_type, payload, payload_hash, signer_address, submitted_at'),
      supabase.from('carbon_credit_nfts').select('*').order('token_id', { ascending: true }),
      supabase.from('escrows').select('*').order('created_at', { ascending: false }),
      supabase.from('app_users').select('id, display_name, organization, wallet_address, role'),
      supabase.from('verifier_stakes').select('*').order('reputation_score', { ascending: false }),
      supabase.from('project_objections').select('*').order('created_at', { ascending: false }),
      supabase.from('disputes').select('*').order('created_at', { ascending: false })
    ]);
    const policy = await getPolicy();

    const userByWallet = new Map<string, any>();
    for (const u of users.data || []) if (u.wallet_address) userByWallet.set(lower(u.wallet_address), u);
    const userById = new Map<string, any>((users.data || []).map((u: any) => [u.id, u]));

    const pool = (verifiers.data || []).map((v: any) => ({
      id: v.verifier_address,
      name: v.display_name || userByWallet.get(lower(v.verifier_address))?.display_name || 'Independent Verifier',
      organization: v.organization || userByWallet.get(lower(v.verifier_address))?.organization || 'Accredited Verifier',
      address: v.verifier_address,
      reputationScore: Number(v.reputation_score ?? 100),
      minimumStakeEth: 0.1,
      stakedEth: Number(v.staked_amount || 0),
      specialization: v.specialization || 'REFORESTATION',
      activeAuditsCount: 0,
      totalAuditedTonnage: 0,
      activeInPool: Boolean(v.active_in_pool)
    }));
    const unassigned = {
      id: 'unassigned', name: 'Awaiting staked verifier', organization: 'Verifier pool', address: '0x0000000000000000000000000000000000000000',
      reputationScore: 0, minimumStakeEth: 0.1, stakedEth: 0, specialization: '-', activeAuditsCount: 0, totalAuditedTonnage: 0, activeInPool: false
    };

    const out = (projects.data || []).map((p: any) => {
      const bundle = (bundles.data || []).find((b: any) => b.project_id === p.project_id) || null;
      const risk = bundle ? (risks.data || []).find((r: any) => r.bundle_id === bundle.bundle_id) || null : null;
      const bundleItems = bundle ? (items.data || []).filter((i: any) => i.bundle_id === bundle.bundle_id) : [];
      const evidence = bundleItems.filter((i: any) => i.source_type !== 'VERIFIER_AUDIT');
      const audit = bundleItems.filter((i: any) => i.source_type === 'VERIFIER_AUDIT');
      const decisions = audit.filter((i: any) => i.payload?.action === 'DECISION');
      const finalized = audit.find((i: any) => i.payload?.action === 'QUORUM_FINALIZED');
      const evidenceRequests = audit.filter((i: any) => i.payload?.action === 'EVIDENCE_REQUESTED');
      const projectCredits = (credits.data || []).filter((c: any) => c.project_id === p.project_id);
      const owner = userById.get(p.created_by_user_id) || userByWallet.get(lower(p.owner_address));

      const nfts = projectCredits.map((c: any) => {
        const esc = (escrows.data || []).find((e: any) => Number(e.token_id) === Number(c.token_id)) || null;
        const dispute = (disputes.data || []).find((d: any) => Number(d.token_id) === Number(c.token_id)) || null;
        const status = nftStatus(c, p.owner_address);
        const buyer = esc?.buyer_address || (lower(c.current_owner) !== lower(p.owner_address) ? c.current_owner : undefined);
        return {
          nftId: `NFT-${c.token_id}`,
          tokenId: Number(c.token_id),
          serialNumber: `CRX-${String(p.location?.country || 'GL').slice(0, 2).toUpperCase()}-${c.vintage_year}-${String(c.token_id).padStart(4, '0')}`,
          co2Tonnage: Number(c.co2_tonnage),
          vintageYear: Number(c.vintage_year),
          issuanceModel: 'UPFRONT',
          developerWallet: p.owner_address,
          currentOwner: c.current_owner,
          priceEth: Number(c.listing_price_eth) > 0 ? Number(c.listing_price_eth) : esc ? Number(esc.deposit_amount) : undefined,
          isListed: status === 'LISTED',
          status,
          buyerAddress: buyer,
          buyerOrg: buyer ? userByWallet.get(lower(buyer))?.organization : undefined,
          purchasedAt: esc?.created_at,
          purchaseTxHash: esc?.buy_tx_hash,
          escrowId: esc?.escrow_id,
          escrowStatus: esc?.status,
          releaseAfter: esc?.challenge_window_expiry,
          mintTxHash: c.mint_tx_hash,
          retiredAt: c.retired_at,
          burnTxHash: c.burn_tx_hash,
          retirementReason: c.retirement_reason,
          beneficiaryName: c.beneficiary_name,
          certificateHash: c.certificate_hash,
          legalCertificateId: c.status === 'RETIRED' ? `CRX-RETIRE-${c.token_id}` : undefined,
          disputeId: dispute?.dispute_id,
          disputeStatus: dispute?.status,
          disputeReason: dispute?.reason
        };
      });

      let lifecycleState = 'BASELINE_WINDOW';
      if (nfts.length > 0) {
        const live = nfts.filter((n: any) => !['RETIRED', 'REVOKED'].includes(n.status));
        if (live.length === 0) lifecycleState = nfts.every((n: any) => n.status === 'REVOKED') ? 'REVOKED' : 'RETIRED';
        else if (live.some((n: any) => n.status === 'DISPUTED')) lifecycleState = 'DISPUTED';
        else if (live.some((n: any) => n.status === 'LISTED')) lifecycleState = 'LISTED_ON_MARKETPLACE';
        else if (live.some((n: any) => ['IN_ESCROW', 'PURCHASED'].includes(n.status))) lifecycleState = 'PURCHASED';
        else lifecycleState = 'CREDITS_ISSUED';
      } else if (bundle?.status === 'REJECTED') {
        lifecycleState = 'REJECTED';
      } else if (risk?.verifier_required) {
        lifecycleState = decisions.length > 0 ? 'VERIFIER_AUDITING' : 'VERIFIER_PENDING_STAKE';
      }

      const firstVoter = decisions[0]?.payload?.verifierAddress;
      const assignedVerifier = (firstVoter && pool.find((v: any) => lower(v.address) === lower(firstVoter)))
        || pool.find((v: any) => v.activeInPool) || unassigned;

      const required = risk?.risk_level === 'HIGH' ? Math.max(1, Number(policy.highRiskVerifierQuorum || 2)) : 1;
      const votes = decisions.map((d: any) => ({
        verifierAddress: d.payload.verifierAddress,
        verifierName: d.payload.verifierName,
        approved: d.payload.approved,
        auditNotes: d.payload.auditNotes,
        recommendedTonnage: d.payload.recommendedTonnage,
        voteTxHash: d.payload.voteTxHash,
        submittedAt: d.submitted_at
      }));

      const doc = evidence.find((i: any) => i.source_type === 'OPERATIONAL_DOC')?.payload || {};
      const iot = evidence.find((i: any) => i.source_type === 'IOT_SENSOR')?.payload || null;
      const sat = evidence.find((i: any) => i.source_type === 'SATELLITE_NDVI')?.payload || null;
      const createdAt = p.created_at || new Date().toISOString();

      return {
        id: p.project_id,
        name: p.name,
        projectType: p.project_type,
        location: { ...(p.location || {}), coordinates: sat?.latitude !== undefined ? `${sat.latitude}, ${sat.longitude}` : p.location?.coordinates },
        developerWallet: p.owner_address,
        developerName: owner?.organization || owner?.display_name || 'Registered Carbon Proponent',
        developerDid: p.did,
        claimedAnnualTonnage: Number(p.claimed_annual_tonnage),
        capexUsd: Number(doc.projectCapexUsd || 0),
        merkleRoot: bundle?.merkle_root || '',
        aiConfidenceScore: risk ? Number(risk.confidence_score) : 0,
        riskLevel: risk?.risk_level || 'LOW',
        createdAt,
        projectStatus: p.status,
        registerTxHash: p.register_tx_hash,
        lifecycleState,
        baselineStartTime: createdAt,
        baselineDurationDays: Number(policy.observationWindowDays || 14),
        baselineFastForwarded: Boolean(p.baseline_closed_at),
        objections: (objections.data || []).filter((o: any) => o.project_id === p.project_id).map((o: any) => ({
          id: o.objection_id, author: o.raised_by_name, authorOrg: o.raised_by_role, reason: o.reason, category: o.category,
          createdAt: o.created_at, status: o.status === 'REVISION_SUBMITTED' ? 'REVISED' : o.status, developerResponse: o.proponent_response
        })),
        assignedVerifier,
        passedVerifierIds: [],
        verifierStakedEth: assignedVerifier.stakedEth || undefined,
        verifierAuditNotes: votes[0]?.auditNotes,
        auditAttestationHash: finalized?.payload_hash,
        auditedAt: finalized?.submitted_at,
        totalIssuedTonnage: nfts.reduce((s: number, n: any) => s + n.co2Tonnage, 0) || undefined,
        issuedNftCount: nfts.length || undefined,
        tonnagePerNft: nfts[0]?.co2Tonnage,
        issuanceModel: nfts.length ? 'UPFRONT' : undefined,
        nftIssuanceTxHash: nfts[0]?.mintTxHash,
        nfts,
        listingPricePerNftEth: nfts.find((n: any) => n.isListed)?.priceEth,
        isListedOnMarketplace: nfts.some((n: any) => n.isListed),
        // on-chain / audit extras
        bundleId: bundle?.bundle_id || null,
        bundleStatus: bundle?.status || null,
        evidenceTxHash: bundle?.on_chain_tx_hash || null,
        riskTxHash: risk?.on_chain_tx_hash || null,
        riskExplanation: risk?.explanation_reason || null,
        anomalyFlags: risk?.anomaly_flags || [],
        verifierRequired: Boolean(risk?.verifier_required),
        quorum: { required, approvals: votes.filter((v: any) => v.approved).length, rejections: votes.filter((v: any) => !v.approved).length, votes },
        evidenceRequests: evidenceRequests.map((r: any) => r.payload),
        evidenceSummary: {
          iot: iot && { sensorId: iot.sensorId, co2FluxPpm: iot.co2FluxPpm, biomassKgM2: iot.biomassKgM2, soilMoisturePct: iot.soilMoisturePct },
          satellite: sat && { meanNdvi: sat.meanNdvi, canopyCoveragePct: sat.canopyCoveragePct, cloudCoverPct: sat.cloudCoverPct, source: sat.evidenceSource, snapshotHash: sat.snapshotHash },
          financial: { capexUsd: doc.projectCapexUsd, documentName: doc.documentName, invoiceAttestationHash: doc.invoiceAttestationHash },
          leaves: evidence.map((i: any) => ({ sourceType: i.source_type, payloadHash: i.payload_hash }))
        }
      };
    });

    return res.status(200).json({ projects: out, verifierPool: pool });
  } catch (error: any) {
    return fail(res, error);
  }
});

router.get('/notifications', authenticate, async (_req: Request, res: Response) => {
  try {
    const role = res.locals.auth.role;
    const { data, error } = await supabase.from('protocol_notifications').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) return res.status(500).json({ error: error.message });
    const list = (data || [])
      .filter((n: any) => role === 'REGULATOR_AUDITOR' || n.recipient_role === role || n.recipient_role === 'ALL')
      .slice(0, 60)
      .map((n: any) => ({
        id: n.notification_id, timestamp: n.created_at, title: n.title, message: n.message, category: n.category,
        recipientRole: n.recipient_role, projectId: n.project_id, txHash: n.tx_hash, read: false
      }));
    return res.status(200).json({ notifications: list });
  } catch (error: any) {
    return fail(res, error);
  }
});

// GET /api/lifecycle/chain - live chain status + balances of every demo wallet
router.get('/chain', authenticate, async (_req: Request, res: Response) => {
  try {
    const status = await RelayerService.status();
    let wallets: any[] = [];
    if (status.connected) {
      const { data: users } = await supabase.from('app_users').select('display_name, organization, role, wallet_address');
      wallets = await Promise.all((users || []).filter((u: any) => u.wallet_address).map(async (u: any) => ({
        name: u.display_name, organization: u.organization, role: u.role, address: u.wallet_address,
        balanceEth: await RelayerService.getBalanceEth(u.wallet_address)
      })));
    }
    return res.status(200).json({ ...status, wallets });
  } catch (error: any) {
    return fail(res, error);
  }
});

export default router;
