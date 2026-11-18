import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { RelayerService } from '../services/relayer.service';
import { CryptographicService } from '../services/cryptographic.service';
import { requireRoles } from '../auth/middleware';
import { isAddress } from 'ethers';
import { fail, notify, walletFor } from './helpers';

const router = Router();

const reviewAction = (item: any) => item?.payload?.action || (typeof item?.payload?.approved === 'boolean' ? 'DECISION' : 'NOTE');

function buildQuorum(riskLevel: string, auditItems: any[], highRiskQuorum = 2) {
  const required = riskLevel === 'HIGH' ? Math.max(1, highRiskQuorum) : 1;
  const decisions = auditItems.filter((item) => reviewAction(item) === 'DECISION');
  const votesByVerifier = new Map<string, any>();

  for (const item of decisions) {
    const address = String(item?.payload?.verifierAddress || item?.signer_address || '').toLowerCase();
    if (address) votesByVerifier.set(address, item);
  }

  const votes = Array.from(votesByVerifier.values());
  return {
    required,
    approvals: votes.filter((item) => item?.payload?.approved === true).length,
    rejections: votes.filter((item) => item?.payload?.approved === false).length,
    votes: votes.map((item) => ({
      verifierAddress: item?.payload?.verifierAddress || item?.signer_address,
      approved: item?.payload?.approved,
      auditNotes: item?.payload?.auditNotes,
      recommendedTonnage: item?.payload?.recommendedTonnage,
      submittedAt: item?.submitted_at
    }))
  };
}

// POST /api/verifiers/stake - stake ETH collateral in VerifierStakingLedger (on-chain) and mirror it
const handleStake = async (req: Request, res: Response) => {
  try {
    const { verifierAddress, specialization } = req.body;
    const amountEth = Number(req.body.stakedAmount !== undefined ? req.body.stakedAmount : req.body.amountEth);
    const auth = res.locals.auth;
    const wallet = walletFor(res, verifierAddress);

    if (!wallet) return res.status(400).json({ error: 'A valid verifier wallet is required' });
    if (!Number.isFinite(amountEth) || amountEth < 0.1) {
      return res.status(400).json({ error: 'Stake at least 0.1 ETH of collateral to join the verifier pool' });
    }

    const { txHash } = await RelayerService.stakeOnChain(wallet, amountEth);
    const profile = await RelayerService.getVerifierProfile(wallet);

    const { data: verifier, error } = await supabase
      .from('verifier_stakes')
      .upsert({
        verifier_address: wallet,
        display_name: auth.displayName,
        organization: auth.organization,
        staked_amount: Number(profile.stakedEth),
        reputation_score: profile.reputationScore,
        active_in_pool: profile.isStaked,
        specialization: specialization || 'REFORESTATION',
        stake_tx_hash: txHash,
        last_stake_timestamp: new Date().toISOString()
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    await notify({
      title: 'Verifier Collateral Staked',
      message: `${auth.displayName} staked ${amountEth} ETH on-chain (total ${profile.stakedEth} ETH) and joined the verifier pool.`,
      category: 'VERIFIER_STAKE',
      recipientRole: 'ALL',
      txHash
    });

    return res.status(200).json({ success: true, verifier, profile, txHash, message: 'Collateral staked on-chain' });
  } catch (error: any) {
    return fail(res, error);
  }
};

// GET /api/verifiers/me - live on-chain staking profile for the signed-in verifier
router.get('/me', requireRoles('INDEPENDENT_VERIFIER'), async (_req: Request, res: Response) => {
  try {
    const wallet = walletFor(res);
    if (!wallet) return res.status(200).json({ wallet: null, profile: null });
    const profile = await RelayerService.getVerifierProfile(wallet);
    const balanceEth = await RelayerService.getBalanceEth(wallet);
    return res.status(200).json({ wallet, profile, balanceEth });
  } catch (error: any) {
    return fail(res, error);
  }
});

router.post('/stake', requireRoles('INDEPENDENT_VERIFIER'), handleStake);
router.post('/', requireRoles('INDEPENDENT_VERIFIER'), handleStake);

// GET /api/verifiers - List all verifiers
router.get('/', requireRoles('INDEPENDENT_VERIFIER', 'REGULATOR_AUDITOR'), async (_req: Request, res: Response) => {
  try {
    const { data: verifiers, error } = await supabase
      .from('verifier_stakes')
      .select('*')
      .order('staked_amount', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ verifiers: verifiers || [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/verifiers/queue - Get bundles requiring human verifier review
router.get('/queue', requireRoles('INDEPENDENT_VERIFIER'), async (_req: Request, res: Response) => {
  try {
    const [assessmentResult, policyResult] = await Promise.all([
      supabase.from('risk_assessments').select('*').eq('verifier_required', true).limit(10),
      supabase.from('regulator_policies').select('settings').eq('policy_name', 'GLOBAL_ISSUANCE_POLICY').maybeSingle()
    ]);
    const assessments = assessmentResult.data;
    const rError = assessmentResult.error;
    const highRiskQuorum = Number(policyResult.data?.settings?.highRiskVerifierQuorum || 2);

    if (rError) return res.status(500).json({ error: rError.message });

    const bundleIds = (assessments || []).map((item) => item.bundle_id);
    if (bundleIds.length === 0) return res.status(200).json({ queue: [] });

    const { data: bundles, error: bundleError } = await supabase
      .from('evidence_bundles')
      .select('*')
      .in('bundle_id', bundleIds);
    if (bundleError) return res.status(500).json({ error: bundleError.message });

    const projectIds = (bundles || []).map((bundle) => bundle.project_id);
    const [itemsResult, projectsResult] = await Promise.all([
      supabase.from('evidence_items').select('*').in('bundle_id', bundleIds).order('submitted_at', { ascending: true }),
      supabase.from('projects').select('*').in('project_id', projectIds)
    ]);
    if (itemsResult.error) return res.status(500).json({ error: itemsResult.error.message });
    if (projectsResult.error) return res.status(500).json({ error: projectsResult.error.message });

    const queue = (assessments || []).map((assessment) => {
      const bundle = (bundles || []).find((item) => item.bundle_id === assessment.bundle_id) || null;
      const project = (projectsResult.data || []).find((item) => item.project_id === bundle?.project_id) || null;
      const evidenceItems = (itemsResult.data || []).filter((item) => item.bundle_id === assessment.bundle_id);
      const auditItems = evidenceItems.filter((item) => item.source_type === 'VERIFIER_AUDIT');

      return {
        ...assessment,
        evidence_bundles: bundle ? { ...bundle, projects: project, evidence_items: evidenceItems.filter((item) => item.source_type !== 'VERIFIER_AUDIT') } : null,
        review_history: auditItems,
        quorum: buildQuorum(assessment.risk_level, auditItems, highRiskQuorum)
      };
    });

    return res.status(200).json({ queue });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/verifiers/request-evidence - Ask the proponent for clarification or new evidence.
router.post('/request-evidence', requireRoles('INDEPENDENT_VERIFIER'), async (req: Request, res: Response) => {
  try {
    const { bundleId, category, message, dueDate } = req.body;
    const verifierAddress = walletFor(res, req.body.verifierAddress) || '';
    if (!bundleId || !verifierAddress || !message || String(message).trim().length < 10) {
      return res.status(400).json({ error: 'bundleId, verifierAddress, and a detailed evidence request are required' });
    }
    if (!isAddress(verifierAddress)) {
      return res.status(400).json({ error: 'verifierAddress must be a valid Ethereum address' });
    }

    const { data: verifier } = await supabase
      .from('verifier_stakes')
      .select('active_in_pool')
      .eq('verifier_address', verifierAddress)
      .maybeSingle();
    if (!verifier?.active_in_pool) {
      return res.status(403).json({ error: 'Only an active staked verifier can request evidence' });
    }

    const { data: bundle } = await supabase
      .from('evidence_bundles')
      .select('bundle_id')
      .eq('bundle_id', bundleId)
      .maybeSingle();
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const payload = {
      action: 'EVIDENCE_REQUESTED',
      category: category || 'ADDITIONAL_DOCUMENTATION',
      message: String(message).trim(),
      dueDate: dueDate || null,
      verifierAddress,
      verifierName: res.locals.auth.displayName,
      timestamp: Date.now()
    };
    const { data: requestItem, error } = await supabase
      .from('evidence_items')
      .insert({
        bundle_id: bundleId,
        source_type: 'VERIFIER_AUDIT',
        payload,
        payload_hash: CryptographicService.hashPayload(payload),
        signer_address: verifierAddress,
        integrity_status: 'VALID'
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    return res.status(201).json({ success: true, request: requestItem, message: 'Evidence request recorded in the audit trail' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/verifiers/verify - Record human verifier audit decision
router.post('/verify', requireRoles('INDEPENDENT_VERIFIER'), async (req: Request, res: Response) => {
  try {
    const {
      bundleId,
      approved,
      auditNotes,
      checklist,
      conflictConfirmed,
      decisionConfidence,
      recommendedTonnage
    } = req.body;
    const verifierAddress = walletFor(res, req.body.verifierAddress) || '';

    if (!bundleId || !verifierAddress || approved === undefined) {
      return res.status(400).json({ error: 'bundleId, verifierAddress, and approved decision are required' });
    }
    if (!isAddress(verifierAddress)) {
      return res.status(400).json({ error: 'verifierAddress must be a valid Ethereum address' });
    }
    if (!auditNotes || String(auditNotes).trim().length < 10) {
      return res.status(400).json({ error: 'Add detailed audit notes before submitting a decision' });
    }
    if (!checklist || Object.values(checklist).length < 5 || !Object.values(checklist).every(Boolean)) {
      return res.status(400).json({ error: 'Complete every verification checklist item before submitting a decision' });
    }
    if (conflictConfirmed !== true) {
      return res.status(400).json({ error: 'The conflict-of-interest declaration must be confirmed' });
    }
    if (!Number.isFinite(Number(decisionConfidence)) || Number(decisionConfidence) < 0 || Number(decisionConfidence) > 100) {
      return res.status(400).json({ error: 'Decision confidence must be between 0 and 100' });
    }

    // 1. Verify the verifier holds live collateral on-chain
    const chainProfile = await RelayerService.getVerifierProfile(verifierAddress);
    if (!chainProfile.isStaked) {
      return res.status(403).json({
        error: 'Verifier must have minimum active collateral staked (>= 0.1 ETH) on-chain to submit audits'
      });
    }
    const { data: verifier } = await supabase.from('verifier_stakes').select('*').eq('verifier_address', verifierAddress).maybeSingle();

    // 2. Fetch Bundle Details
    const { data: bundle } = await supabase
      .from('evidence_bundles')
      .select('*, projects(*)')
      .eq('bundle_id', bundleId)
      .single();

    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const [riskResult, policyResult] = await Promise.all([
      supabase.from('risk_assessments').select('risk_level').eq('bundle_id', bundleId).maybeSingle(),
      supabase.from('regulator_policies').select('settings').eq('policy_name', 'GLOBAL_ISSUANCE_POLICY').maybeSingle()
    ]);
    const risk = riskResult.data;
    const highRiskQuorum = Number(policyResult.data?.settings?.highRiskVerifierQuorum || 2);

    const { data: existingAudits, error: auditsError } = await supabase
      .from('evidence_items')
      .select('*')
      .eq('bundle_id', bundleId)
      .eq('source_type', 'VERIFIER_AUDIT')
      .order('submitted_at', { ascending: true });
    if (auditsError) return res.status(500).json({ error: auditsError.message });

    const alreadyVoted = (existingAudits || []).some((item) =>
      reviewAction(item) === 'DECISION'
      && String(item?.payload?.verifierAddress || item?.signer_address || '').toLowerCase() === verifierAddress.toLowerCase()
    );
    if (alreadyVoted) {
      return res.status(409).json({ error: 'This verifier wallet has already voted on the selected bundle' });
    }

    // Record this verifier's decision on-chain first (reverts on double-vote / conflict of interest).
    const voteTxHash = await RelayerService.castVerifierVoteOnChain(bundleId, verifierAddress, Boolean(approved));

    const auditPayload = {
      action: 'DECISION',
      voteTxHash,
      approved,
      auditNotes: String(auditNotes).trim(),
      checklist,
      conflictConfirmed,
      decisionConfidence: Number(decisionConfidence),
      recommendedTonnage: Number.isFinite(Number(recommendedTonnage)) ? Number(recommendedTonnage) : null,
      verifierAddress,
      verifierName: res.locals.auth.displayName,
      timestamp: Date.now()
    };
    const { data: voteItem, error: voteError } = await supabase.from('evidence_items').insert({
      bundle_id: bundleId,
      source_type: 'VERIFIER_AUDIT',
      payload: auditPayload,
      payload_hash: CryptographicService.hashPayload(auditPayload),
      signer_address: verifierAddress,
      integrity_status: 'VALID'
    }).select().single();
    if (voteError) return res.status(500).json({ error: voteError.message });

    const quorum = buildQuorum(risk?.risk_level || 'HIGH', [...(existingAudits || []), voteItem], highRiskQuorum);
    const finalized = quorum.approvals >= quorum.required || quorum.rejections >= quorum.required;
    if (!finalized) {
      return res.status(200).json({
        success: true,
        finalized: false,
        approved,
        bundleId,
        quorum,
        message: `Vote recorded. ${quorum.required - Math.max(quorum.approvals, quorum.rejections)} more independent verifier decision required.`
      });
    }

    const finalApproved = quorum.approvals >= quorum.required;
    let mintTxHash = null;
    let tokenId = null;
    const verificationTxHash = await RelayerService.finalizeVerificationOnChain(bundleId, finalApproved);

    if (finalApproved) {
      const proposedTonnages = quorum.votes
        .filter((vote) => vote.approved)
        .map((vote) => Number(vote.recommendedTonnage))
        .filter((value) => Number.isFinite(value) && value > 0);
      const tonnage = Math.round(proposedTonnages.length
        ? proposedTonnages.reduce((sum, value) => sum + value, 0) / proposedTonnages.length
        : Number((bundle.projects as any)?.claimed_annual_tonnage || 100));
      const vintage = new Date().getFullYear();

      const mintResult = await RelayerService.mintCreditOnChain(bundleId, tonnage, vintage);
      mintTxHash = mintResult.txHash;
      tokenId = mintResult.tokenId;

      await supabase.from('evidence_bundles').update({ status: 'ISSUED' }).eq('bundle_id', bundleId);

      const recipient = (bundle.projects as any)?.owner_address || verifierAddress;
      await supabase.from('carbon_credit_nfts').insert({
        token_id: tokenId,
        project_id: bundle.project_id,
        bundle_id: bundleId,
        current_owner: recipient,
        co2_tonnage: tonnage,
        vintage_year: vintage,
        merkle_root: bundle.merkle_root,
        mint_tx_hash: mintTxHash,
        status: 'ISSUED'
      });

      await notify({
        title: 'Project Audited & Credits Issued',
        message: `Verifier quorum approved ${(bundle.projects as any)?.name || bundleId}. ${tonnage} tCO2e minted as NFT #${tokenId}.`,
        category: 'NFT_ISSUED',
        recipientRole: 'PROJECT_PROPONENT',
        projectId: bundle.project_id,
        txHash: mintTxHash
      });
    } else {
      await supabase.from('evidence_bundles').update({ status: 'REJECTED' }).eq('bundle_id', bundleId);
      await notify({
        title: 'Verifier Quorum Rejected Evidence',
        message: `The verifier quorum rejected the evidence bundle for ${(bundle.projects as any)?.name || bundleId}.`,
        category: 'AUDIT_APPROVED',
        recipientRole: 'PROJECT_PROPONENT',
        projectId: bundle.project_id,
        txHash: verificationTxHash
      });
    }

    // Mirror every voter's reputation/stake from the ledger (the ledger stays authoritative).
    for (const vote of quorum.votes) {
      const addr = String(vote.verifierAddress);
      try {
        const prof = await RelayerService.getVerifierProfile(addr);
        await supabase.from('verifier_stakes').update({
          reputation_score: prof.reputationScore,
          total_verified: prof.totalVerified,
          staked_amount: Number(prof.stakedEth)
        }).eq('verifier_address', addr);
      } catch { /* best effort */ }
    }

    await supabase
      .from('risk_assessments')
      .update({ verifier_required: false })
      .eq('bundle_id', bundleId);

    const finalizationPayload = {
      action: 'QUORUM_FINALIZED',
      approved: finalApproved,
      quorum,
      verificationTxHash,
      mintTxHash,
      tokenId,
      timestamp: Date.now()
    };
    await supabase.from('evidence_items').insert({
      bundle_id: bundleId,
      source_type: 'VERIFIER_AUDIT',
      payload: finalizationPayload,
      payload_hash: CryptographicService.hashPayload(finalizationPayload),
      signer_address: verifierAddress,
      integrity_status: 'VALID'
    });

    return res.status(200).json({
      success: true,
      finalized: true,
      approved: finalApproved,
      bundleId,
      quorum,
      transactionHash: mintTxHash,
      voteTxHash,
      verificationTxHash,
      tokenId,
      message: finalApproved ? 'Verifier quorum reached and Carbon Credit NFT issued' : 'Verifier quorum rejected the evidence bundle'
    });
  } catch (error: any) {
    return fail(res, error);
  }
});

export default router;
