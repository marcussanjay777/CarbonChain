import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { supabase } from '../config/supabase';
import { authenticate, requireRoles } from '../auth/middleware';
import { RelayerService } from '../services/relayer.service';
import { fail, notify, walletFor } from './helpers';

const router = Router();

// GET /api/disputes - all disputes with live slashing data
router.get('/', authenticate, async (_req: Request, res: Response) => {
  try {
    const [{ data: disputes, error }, { data: slashes }] = await Promise.all([
      supabase.from('disputes').select('*').order('created_at', { ascending: false }),
      supabase.from('slashing_events').select('*').order('created_at', { ascending: false })
    ]);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ disputes: disputes || [], slashingEvents: slashes || [] });
  } catch (error: any) {
    return fail(res, error);
  }
});

// POST /api/disputes/raise - buyer or regulator challenges an issued credit (freezes it on-chain)
router.post('/raise', requireRoles('CORPORATE_BUYER', 'REGULATOR_AUDITOR'), async (req: Request, res: Response) => {
  try {
    const tokenId = Number(req.body.tokenId);
    const reason = String(req.body.reason || '').trim();
    const evidenceUrl = req.body.evidenceUrl ? String(req.body.evidenceUrl) : null;
    const auth = res.locals.auth;
    if (!Number.isInteger(tokenId) || tokenId <= 0) return res.status(400).json({ error: 'A valid tokenId is required' });
    if (reason.length < 10) return res.status(400).json({ error: 'Describe the dispute in at least 10 characters' });

    const { data: credit } = await supabase.from('carbon_credit_nfts').select('*').eq('token_id', tokenId).maybeSingle();
    if (!credit) return res.status(404).json({ error: 'Credit not found' });

    const initiator = walletFor(res, req.body.initiatorAddress) || '0x0000000000000000000000000000000000000000';
    const txHash = await RelayerService.disputeCreditOnChain(tokenId, initiator, reason);

    const disputeId = `DSP-${randomUUID().slice(0, 8).toUpperCase()}`;
    const { data: dispute, error } = await supabase.from('disputes').insert({
      dispute_id: disputeId,
      token_id: tokenId,
      initiator_address: initiator,
      initiator_name: `${auth.displayName} (${auth.organization})`,
      reason,
      evidence_url: evidenceUrl,
      status: 'OPEN',
      pre_dispute_status: credit.status,
      raise_tx_hash: txHash,
      created_at: new Date().toISOString()
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('carbon_credit_nfts').update({ status: 'DISPUTED' }).eq('token_id', tokenId);
    await notify({
      title: 'Credit Disputed & Frozen',
      message: `NFT #${tokenId} was disputed by ${auth.organization}: "${reason.slice(0, 90)}". Transfers and settlement are frozen until a ruling.`,
      category: 'DISPUTE',
      recipientRole: 'ALL',
      projectId: credit.project_id,
      txHash
    });

    return res.status(201).json({ success: true, dispute, txHash });
  } catch (error: any) {
    return fail(res, error);
  }
});

// POST /api/disputes/:disputeId/resolve - regulator ruling. UPHELD => revoke + refund + 50% slash (atomic on-chain)
async function resolve(req: Request, res: Response) {
  try {
    const disputeId = String(req.params.disputeId || '');
    const ruling = String(req.body.ruling || (req.body.uphold === true ? 'UPHELD' : req.body.uphold === false ? 'DISMISSED' : ''));
    const details = String(req.body.reason || req.body.details || '').trim();
    if (!['UPHELD', 'DISMISSED'].includes(ruling) || details.length < 10) {
      return res.status(400).json({ error: 'ruling (UPHELD | DISMISSED) and a detailed reason (10+ chars) are required' });
    }

    const { data: dispute } = await supabase.from('disputes').select('*').eq('dispute_id', disputeId).maybeSingle();
    if (!dispute) return res.status(404).json({ error: 'Dispute not found' });
    if (dispute.status !== 'OPEN') return res.status(409).json({ error: 'This dispute already has a final ruling' });

    const tokenId = Number(dispute.token_id);
    const { data: credit } = await supabase.from('carbon_credit_nfts').select('*').eq('token_id', tokenId).maybeSingle();
    const approversBefore: Array<{ address: string; stakedEth: string }> = [];
    if (credit) {
      const approvers: string[] = await RelayerService.getContract('registry').getApprovers(RelayerService.toId(credit.bundle_id));
      for (const a of approvers) approversBefore.push({ address: a, stakedEth: (await RelayerService.getVerifierProfile(a)).stakedEth });
    }

    const result = await RelayerService.resolveDisputeOnChain(tokenId, ruling === 'UPHELD', details);
    const auth = res.locals.auth;

    const { data: resolved } = await supabase.from('disputes').update({
      status: ruling,
      resolved_by: `${auth.displayName}: ${details}`,
      resolved_at: new Date().toISOString(),
      resolve_tx_hash: result.txHash,
      refund_amount_eth: Number(result.refundEth),
      slashed_amount: Number(result.slashedEth)
    }).eq('dispute_id', disputeId).select().single();

    const slashes: any[] = [];
    if (ruling === 'UPHELD') {
      await supabase.from('carbon_credit_nfts').update({ status: 'REVOKED', listing_price_eth: null }).eq('token_id', tokenId);
      const { data: escrow } = await supabase.from('escrows').select('*').eq('token_id', tokenId).eq('status', 'LOCKED').maybeSingle();
      if (escrow) await supabase.from('escrows').update({ status: 'REFUNDED', refund_tx_hash: result.txHash }).eq('escrow_id', escrow.escrow_id);

      for (const before of approversBefore) {
        const after = await RelayerService.getVerifierProfile(before.address);
        const amount = Number(before.stakedEth) - Number(after.stakedEth);
        if (amount <= 0) continue;
        const { data: v } = await supabase.from('verifier_stakes').select('*').eq('verifier_address', before.address).maybeSingle();
        const row = {
          event_key: `${result.txHash}:${before.address.toLowerCase()}`,
          verifier_address: before.address,
          verifier_name: v?.display_name || null,
          amount_eth: amount,
          token_id: tokenId,
          dispute_id: disputeId,
          reason: details,
          tx_hash: result.txHash,
          created_at: new Date().toISOString()
        };
        await supabase.from('slashing_events').upsert(row, { onConflict: 'event_key' });
        await supabase.from('verifier_stakes').update({
          staked_amount: Number(after.stakedEth),
          reputation_score: after.reputationScore,
          total_slashed: Number(after.totalSlashedEth),
          active_in_pool: after.isStaked
        }).eq('verifier_address', before.address);
        slashes.push(row);
      }

      await notify({
        title: 'Dispute Upheld: Credit Revoked, Buyer Refunded, Verifiers Slashed',
        message: `NFT #${tokenId} revoked. Buyer refunded ${result.refundEth} ETH. ${slashes.length} approving verifier(s) slashed ${result.slashedEth} ETH total (50%).`,
        category: 'SLASHED',
        recipientRole: 'ALL',
        projectId: credit?.project_id,
        txHash: result.txHash
      });
    } else {
      const restored = dispute.pre_dispute_status === 'ESCROWED' ? 'ESCROWED' : (dispute.pre_dispute_status || 'ISSUED');
      await supabase.from('carbon_credit_nfts').update({ status: restored }).eq('token_id', tokenId);
      await notify({
        title: 'Dispute Dismissed',
        message: `The dispute on NFT #${tokenId} was dismissed. The credit is tradable again.`,
        category: 'DISPUTE',
        recipientRole: 'ALL',
        projectId: credit?.project_id,
        txHash: result.txHash
      });
    }

    return res.status(200).json({ success: true, dispute: resolved, ...result, slashingEvents: slashes });
  } catch (error: any) {
    return fail(res, error);
  }
}

router.post('/:disputeId/resolve', requireRoles('REGULATOR_AUDITOR'), resolve);

export { resolve as resolveDisputeHandler };
export default router;
