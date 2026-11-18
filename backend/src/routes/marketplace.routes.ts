import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { authenticate, requireRoles } from '../auth/middleware';
import { RelayerService } from '../services/relayer.service';
import { CryptographicService } from '../services/cryptographic.service';
import { fail, notify, walletFor } from './helpers';

const router = Router();

// GET /api/marketplace/credits - public catalogue (listed) or a wallet's portfolio
router.get('/credits', authenticate, async (req: Request, res: Response) => {
  try {
    const scope = String(req.query.scope || 'catalog');
    const wallet = walletFor(res, req.query.ownerAddress);

    let query = supabase.from('carbon_credit_nfts').select('*, projects(*)');
    if (scope === 'portfolio') {
      if (!wallet) return res.status(400).json({ error: 'A wallet is required for portfolio credits' });
      query = query.ilike('current_owner', wallet);
    } else {
      query = query.in('status', ['ISSUED', 'TRANSFERRED']);
    }
    const { data: credits, error } = await query.order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const result = scope === 'portfolio' ? credits : (credits || []).filter((c: any) => Number(c.listing_price_eth) > 0);
    return res.status(200).json({ credits: result || [] });
  } catch (error: any) {
    return fail(res, error);
  }
});

// GET /api/marketplace/escrows - escrows the caller is party to (regulators see all)
router.get('/escrows', authenticate, async (_req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const wallet = walletFor(res);
    const { data, error } = await supabase.from('escrows').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const mine = auth.role === 'REGULATOR_AUDITOR'
      ? data
      : (data || []).filter((e: any) => wallet && [e.buyer_address, e.seller_address].some((a: string) => String(a).toLowerCase() === wallet.toLowerCase()));
    return res.status(200).json({ escrows: mine || [] });
  } catch (error: any) {
    return fail(res, error);
  }
});

// POST /api/marketplace/list - owner sets a price and lists the credit in EscrowSettlement
router.post('/list', requireRoles('PROJECT_PROPONENT', 'CORPORATE_BUYER'), async (req: Request, res: Response) => {
  try {
    const tokenId = Number(req.body.tokenId);
    const priceEth = Number(req.body.priceEth);
    const wallet = walletFor(res, req.body.ownerAddress);
    if (!Number.isInteger(tokenId) || tokenId <= 0) return res.status(400).json({ error: 'A valid tokenId is required' });
    if (!Number.isFinite(priceEth) || priceEth <= 0) return res.status(400).json({ error: 'priceEth must be positive' });

    const onChain = await RelayerService.getCreditOnChain(tokenId);
    if (!wallet || !onChain.owner || onChain.owner.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(403).json({ error: 'Only the current on-chain owner can list this credit' });
    }

    const txHash = await RelayerService.listCreditOnChain(tokenId, priceEth);
    await supabase.from('carbon_credit_nfts').update({ listing_price_eth: priceEth, list_tx_hash: txHash }).eq('token_id', tokenId);

    const { data: nft } = await supabase.from('carbon_credit_nfts').select('project_id').eq('token_id', tokenId).maybeSingle();
    await notify({
      title: 'Credit Listed on Marketplace',
      message: `NFT #${tokenId} is now listed at ${priceEth} ETH with escrow buyer protection.`,
      category: 'LISTED',
      recipientRole: 'CORPORATE_BUYER',
      projectId: nft?.project_id,
      txHash
    });
    return res.status(200).json({ success: true, tokenId, priceEth, txHash });
  } catch (error: any) {
    return fail(res, error);
  }
});

// POST /api/marketplace/escrow/buy - buyer pays the listing price into on-chain escrow
router.post('/escrow/buy', requireRoles('CORPORATE_BUYER'), async (req: Request, res: Response) => {
  try {
    const tokenId = Number(req.body.tokenId);
    const wallet = walletFor(res, req.body.buyerAddress);
    if (!Number.isInteger(tokenId) || tokenId <= 0 || !wallet) {
      return res.status(400).json({ error: 'tokenId and a buyer wallet are required' });
    }

    const { data: nft } = await supabase.from('carbon_credit_nfts').select('*').eq('token_id', tokenId).maybeSingle();
    if (!nft) return res.status(404).json({ error: 'Credit NFT not found' });

    const { txHash, escrowId, releaseAfter, priceEth } = await RelayerService.buyWithEscrowOnChain(wallet, tokenId);

    const { data: escrow, error } = await supabase.from('escrows').insert({
      escrow_id: escrowId,
      token_id: tokenId,
      buyer_address: wallet,
      seller_address: nft.current_owner,
      deposit_amount: Number(priceEth),
      status: 'LOCKED',
      buy_tx_hash: txHash,
      challenge_window_expiry: new Date(releaseAfter * 1000).toISOString()
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('carbon_credit_nfts').update({ status: 'ESCROWED', listing_price_eth: null, escrow_id: escrowId }).eq('token_id', tokenId);

    await notify({
      title: 'Credit Sold into Escrow',
      message: `${res.locals.auth.organization} paid ${priceEth} ETH for NFT #${tokenId}. Funds are locked until the challenge window ends.`,
      category: 'PURCHASED',
      recipientRole: 'PROJECT_PROPONENT',
      projectId: nft.project_id,
      txHash
    });

    return res.status(201).json({ success: true, escrow, escrowId, txHash, releaseAfter, message: 'Payment locked in on-chain escrow' });
  } catch (error: any) {
    return fail(res, error);
  }
});

// POST /api/marketplace/escrow/release - buyer accepts early, or anyone after the window: pays seller, moves NFT
router.post('/escrow/release', authenticate, async (req: Request, res: Response) => {
  try {
    const { escrowId } = req.body;
    if (!escrowId) return res.status(400).json({ error: 'escrowId is required' });

    const { data: escrow } = await supabase.from('escrows').select('*').eq('escrow_id', escrowId).maybeSingle();
    if (!escrow || escrow.status !== 'LOCKED') return res.status(400).json({ error: 'Escrow not found or not LOCKED' });

    const wallet = walletFor(res);
    const isBuyer = wallet && wallet.toLowerCase() === String(escrow.buyer_address).toLowerCase();
    const windowOver = Date.now() >= new Date(escrow.challenge_window_expiry).getTime();
    if (!isBuyer && !windowOver) {
      return res.status(403).json({ error: 'Only the buyer can settle before the challenge window ends' });
    }

    const txHash = await RelayerService.releaseEscrowOnChain(escrowId);
    await supabase.from('escrows').update({ status: 'RELEASED', release_tx_hash: txHash }).eq('escrow_id', escrowId);
    await supabase.from('carbon_credit_nfts').update({ current_owner: escrow.buyer_address, status: 'TRANSFERRED' }).eq('token_id', escrow.token_id);

    return res.status(200).json({ success: true, escrowId, txHash, newOwner: escrow.buyer_address, message: 'Escrow settled: seller paid, NFT transferred' });
  } catch (error: any) {
    return fail(res, error);
  }
});

// POST /api/marketplace/retire - owner burns the NFT on-chain and receives a retirement certificate
const handleRetirement = async (req: Request, res: Response) => {
  try {
    const tokenId = Number(req.body.tokenId);
    const retirementReason = String(req.body.retirementReason || req.body.retireReason || 'Corporate ESG Net-Zero Offset');
    const beneficiary = String(req.body.beneficiaryLegalName || req.body.beneficiary || res.locals.auth.organization);
    const wallet = walletFor(res, req.body.ownerAddress);
    if (!Number.isInteger(tokenId) || tokenId <= 0 || !wallet) return res.status(400).json({ error: 'tokenId and owner wallet are required' });

    const { data: credit } = await supabase.from('carbon_credit_nfts').select('*, projects(*)').eq('token_id', tokenId).maybeSingle();
    if (!credit) return res.status(404).json({ error: 'Credit NFT not found' });

    const burnTxHash = await RelayerService.retireCreditOnChain(wallet, tokenId, retirementReason);
    const retiredAt = new Date().toISOString();
    const certificate = {
      certificateId: `CRX-RETIRE-${tokenId}`,
      tokenId,
      beneficiary,
      beneficiaryWallet: wallet,
      tonnage: credit.co2_tonnage,
      vintage: credit.vintage_year,
      projectId: credit.project_id,
      projectName: (credit as any).projects?.name || credit.project_id,
      merkleRoot: credit.merkle_root,
      burnTxHash,
      retiredAt,
      retirementReason
    };
    const certificateHash = CryptographicService.hashPayload(certificate);

    await supabase.from('carbon_credit_nfts').update({
      status: 'RETIRED',
      retirement_reason: retirementReason,
      retired_at: retiredAt,
      burn_tx_hash: burnTxHash,
      certificate_hash: certificateHash,
      beneficiary_name: beneficiary,
      listing_price_eth: null
    }).eq('token_id', tokenId);

    await notify({
      title: 'Carbon Offset Retired On-Chain',
      message: `NFT #${tokenId} (${credit.co2_tonnage} tCO2e) was burned for ${beneficiary}. Certificate ${certificate.certificateId}.`,
      category: 'RETIRED',
      recipientRole: 'ALL',
      projectId: credit.project_id,
      txHash: burnTxHash
    });

    return res.status(200).json({ success: true, certificateHash, certificate, burnTxHash, message: 'Credit burned on-chain and certificate generated' });
  } catch (error: any) {
    return fail(res, error);
  }
};

router.post('/retire', requireRoles('CORPORATE_BUYER', 'PROJECT_PROPONENT'), handleRetirement);
router.post('/credits/retire', requireRoles('CORPORATE_BUYER', 'PROJECT_PROPONENT'), handleRetirement);

export default router;
