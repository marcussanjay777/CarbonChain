import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { CryptographicService } from '../services/cryptographic.service';
import { MerkleService } from '../services/merkle.service';
import { RelayerService } from '../services/relayer.service';
import { authenticate, requireRoles } from '../auth/middleware';
import { fail } from './helpers';

const router = Router();

const ALLOWED_SOURCE_TYPES = ['IOT_SENSOR', 'SATELLITE_NDVI', 'OPERATIONAL_DOC', 'VERIFIER_AUDIT'];
const normalizeSourceType = (rawType: string) => {
  if (!rawType) return 'IOT_SENSOR';
  if (ALLOWED_SOURCE_TYPES.includes(rawType)) return rawType;
  if (rawType.includes('DOC') || rawType.includes('FINANCIAL') || rawType.includes('EXPENSE')) return 'OPERATIONAL_DOC';
  if (rawType.includes('SAT') || rawType.includes('NDVI') || rawType.includes('ORBITAL')) return 'SATELLITE_NDVI';
  if (rawType.includes('AUDIT') || rawType.includes('VERIFIER')) return 'VERIFIER_AUDIT';
  return 'IOT_SENSOR';
};

async function handleEvidenceUpload(req: Request, res: Response) {
  try {
    const { projectId, bundleId: customBundleId, monitoringPeriod, evidenceItems } = req.body;
    const auth = res.locals.auth;

    if (!projectId || !evidenceItems || !Array.isArray(evidenceItems) || evidenceItems.length === 0) {
      return res.status(400).json({ error: 'projectId and non-empty evidenceItems array are required' });
    }

    const { data: project } = await supabase.from('projects').select('*').eq('project_id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project not found. Register the project first.' });
    if (project.created_by_user_id && project.created_by_user_id !== auth.id) {
      return res.status(403).json({ error: 'Only the project proponent can submit evidence for this project' });
    }

    const bundleId = customBundleId || `bundle-${projectId}-${Date.now()}`;

    const processedItems = evidenceItems.map((item: any) => ({
      bundle_id: bundleId,
      source_type: normalizeSourceType(item.sourceType),
      payload: item.payload || item,
      payload_hash: CryptographicService.hashPayload(item.payload || item),
      signer_address: item.signerAddress || project.owner_address,
      integrity_status: 'VALID'
    }));

    const leafHashes: string[] = processedItems.map((i: any) => i.payload_hash);
    const merkleResult = MerkleService.computeMerkleTree(leafHashes);

    // Anchor the Merkle root on-chain first. If this fails nothing is persisted.
    const onChainTxHash = await RelayerService.commitEvidenceBundleOnChain(bundleId, projectId, merkleResult.merkleRoot);

    const bundleRecord = {
      bundle_id: bundleId,
      project_id: projectId,
      merkle_root: merkleResult.merkleRoot,
      item_count: processedItems.length,
      monitoring_period: monitoringPeriod || { startDate: '2026-01-01', endDate: '2026-03-31' },
      status: 'INGESTED',
      on_chain_tx_hash: onChainTxHash
    };

    const { data: bundle, error: bundleError } = await supabase.from('evidence_bundles').upsert(bundleRecord).select().single();
    if (bundleError) return res.status(500).json({ error: bundleError.message });

    const { error: itemsError } = await supabase.from('evidence_items').insert(processedItems);
    if (itemsError) return res.status(500).json({ error: itemsError.message });

    return res.status(201).json({
      success: true,
      bundleId,
      bundle,
      merkleRoot: merkleResult.merkleRoot,
      leafCount: merkleResult.leafCount,
      leaves: merkleResult.leaves,
      leafHashes,
      itemCount: processedItems.length,
      items: processedItems.map((i: any) => ({ ...i, payload: undefined })),
      onChainTxHash,
      txHash: onChainTxHash,
      message: 'Evidence bundle ingested and Merkle root anchored on-chain'
    });
  } catch (error: any) {
    return fail(res, error);
  }
}

router.post('/upload', requireRoles('PROJECT_PROPONENT'), handleEvidenceUpload);
router.post('/bundle', requireRoles('PROJECT_PROPONENT'), handleEvidenceUpload);

// GET /api/evidence/bundle/:bundleId - bundle with an inclusion proof for every item
router.get('/bundle/:bundleId', authenticate, async (req: Request, res: Response) => {
  try {
    const { bundleId } = req.params;
    const { data: bundle } = await supabase.from('evidence_bundles').select('*').eq('bundle_id', bundleId).maybeSingle();
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const { data: items } = await supabase.from('evidence_items').select('*').eq('bundle_id', bundleId);
    // Audit votes are appended after the root was committed, so they are not Merkle leaves.
    const committed = (items || []).filter((i: any) => i.source_type !== 'VERIFIER_AUDIT');
    const leafHashes = committed.map((i: any) => i.payload_hash);

    const proofs = committed.map((item: any) => ({
      itemId: item.id,
      sourceType: item.source_type,
      payloadHash: item.payload_hash,
      proof: MerkleService.generateProofForHash(leafHashes, item.payload_hash)
    }));

    return res.status(200).json({ bundle, items: committed, merkleRoot: bundle.merkle_root, proofs });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/evidence/verify-proof - check a payload hash against the committed root, off-chain AND on-chain
router.post('/verify-proof', authenticate, async (req: Request, res: Response) => {
  try {
    const { bundleId, payloadHash } = req.body || {};
    let { proof } = req.body || {};
    if (!bundleId || !payloadHash || !/^(0x)?[0-9a-fA-F]{64}$/.test(String(payloadHash))) {
      return res.status(400).json({ error: 'bundleId and a 32-byte hex payloadHash are required' });
    }
    const hash = String(payloadHash).startsWith('0x') ? String(payloadHash).toLowerCase() : `0x${String(payloadHash).toLowerCase()}`;

    const { data: bundle } = await supabase.from('evidence_bundles').select('*').eq('bundle_id', bundleId).maybeSingle();
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    let proofSource: 'supplied' | 'generated' = 'supplied';
    if (!Array.isArray(proof)) {
      const { data: items } = await supabase.from('evidence_items').select('payload_hash, source_type').eq('bundle_id', bundleId);
      const leaves = (items || []).filter((i: any) => i.source_type !== 'VERIFIER_AUDIT').map((i: any) => i.payload_hash);
      try {
        proof = MerkleService.generateProofForHash(leaves, hash);
        proofSource = 'generated';
      } catch {
        return res.status(200).json({
          success: true, valid: false, bundleId, payloadHash: hash, committedRoot: bundle.merkle_root,
          reason: 'This hash is not a leaf of the committed bundle (tampered or from another bundle).'
        });
      }
    }

    const validOffChain = MerkleService.verifyProof(hash, proof, bundle.merkle_root);
    let validOnChain: boolean | null = null;
    try {
      validOnChain = await RelayerService.verifyInclusionOnChain(bundleId, hash, proof);
    } catch {
      validOnChain = null; // chain unreachable: report off-chain result only
    }

    return res.status(200).json({
      success: true,
      valid: validOffChain && validOnChain !== false,
      validOffChain,
      validOnChain,
      bundleId,
      payloadHash: hash,
      committedRoot: bundle.merkle_root,
      onChainTxHash: bundle.on_chain_tx_hash || null,
      proof,
      proofSource
    });
  } catch (error: any) {
    return fail(res, error);
  }
});

export default router;
