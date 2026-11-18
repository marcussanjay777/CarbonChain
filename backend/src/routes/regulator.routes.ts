import { randomUUID } from 'node:crypto';
import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { requireRoles } from '../auth/middleware';
import { RelayerService } from '../services/relayer.service';
import { resolveDisputeHandler } from './disputes.routes';
import { fail } from './helpers';

const router = Router();

const DEFAULT_POLICY = {
  minimumAiConfidence: 85,
  maximumEvidenceDeviation: 15,
  highRiskVerifierQuorum: 2,
  observationWindowDays: 14,
  automaticEscalation: true
};

router.get('/overview', requireRoles('REGULATOR_AUDITOR'), async (_req: Request, res: Response) => {
  try {
    const auth = res.locals.auth;
    const [
      projectsResult,
      bundlesResult,
      risksResult,
      evidenceResult,
      creditsResult,
      verifiersResult,
      objectionsResult,
      disputesResult,
      actionsResult,
      policiesResult,
      watchlistResult,
      slashingResult,
      escrowsResult
    ] = await Promise.all([
      supabase.from('projects').select('*').order('created_at', { ascending: false }),
      supabase.from('evidence_bundles').select('*').order('created_at', { ascending: false }),
      supabase.from('risk_assessments').select('*').order('computed_at', { ascending: false }),
      supabase.from('evidence_items').select('*').order('submitted_at', { ascending: false }),
      supabase.from('carbon_credit_nfts').select('*').order('created_at', { ascending: false }),
      supabase.from('verifier_stakes').select('*').order('reputation_score', { ascending: false }),
      supabase.from('project_objections').select('*').order('created_at', { ascending: false }),
      supabase.from('disputes').select('*').order('created_at', { ascending: false }),
      supabase.from('regulatory_actions').select('*').order('created_at', { ascending: false }),
      supabase.from('regulator_policies').select('*').eq('policy_name', 'GLOBAL_ISSUANCE_POLICY').maybeSingle(),
      supabase.from('regulator_watchlist').select('*').eq('regulator_user_id', auth.id).order('created_at', { ascending: false }),
      supabase.from('slashing_events').select('*').order('created_at', { ascending: false }),
      supabase.from('escrows').select('*').order('created_at', { ascending: false })
    ]);

    const firstError = [projectsResult, bundlesResult, risksResult, evidenceResult, creditsResult, verifiersResult, objectionsResult, disputesResult, actionsResult, policiesResult, watchlistResult]
      .find((result) => result.error)?.error;
    if (firstError) return res.status(500).json({ error: firstError.message });

    const projects = projectsResult.data || [];
    const bundles = bundlesResult.data || [];
    const risks = risksResult.data || [];
    const evidence = evidenceResult.data || [];
    const credits = creditsResult.data || [];
    const actions = actionsResult.data || [];

    const investigations = projects.map((project) => {
      const bundle = bundles.find((item) => item.project_id === project.project_id) || null;
      const risk = bundle ? risks.find((item) => item.bundle_id === bundle.bundle_id) || null : null;
      return {
        project,
        bundle,
        risk,
        evidenceItems: bundle ? evidence.filter((item) => item.bundle_id === bundle.bundle_id) : [],
        credits: credits.filter((item) => item.project_id === project.project_id),
        objections: (objectionsResult.data || []).filter((item) => item.project_id === project.project_id),
        regulatoryActions: actions.filter((item) => item.project_id === project.project_id)
      };
    });

    const integrityAlerts: any[] = [];
    const merkleGroups = new Map<string, any[]>();
    for (const bundle of bundles) {
      const group = merkleGroups.get(bundle.merkle_root) || [];
      group.push(bundle);
      merkleGroups.set(bundle.merkle_root, group);
    }
    for (const [merkleRoot, group] of merkleGroups) {
      const projectIds = [...new Set(group.map((item) => item.project_id))];
      if (projectIds.length > 1) integrityAlerts.push({
        id: `merkle-${merkleRoot}`,
        severity: 'CRITICAL',
        type: 'DUPLICATE_MERKLE_ROOT',
        title: 'Evidence root reused across projects',
        detail: `${projectIds.length} projects share Merkle root ${merkleRoot.slice(0, 14)}…`,
        projectIds
      });
    }

    const snapshotGroups = new Map<string, any[]>();
    for (const item of evidence.filter((entry) => entry.source_type === 'SATELLITE_NDVI')) {
      const hash = String(item.payload?.snapshotHash || '');
      if (!hash) continue;
      const group = snapshotGroups.get(hash) || [];
      group.push(item);
      snapshotGroups.set(hash, group);
    }
    for (const [hash, group] of snapshotGroups) {
      const bundleIds = [...new Set(group.map((item) => item.bundle_id))];
      if (bundleIds.length > 1) integrityAlerts.push({
        id: `snapshot-${hash}`,
        severity: 'HIGH',
        type: 'DUPLICATE_SATELLITE_EVIDENCE',
        title: 'Satellite snapshot reused',
        detail: `${bundleIds.length} evidence bundles reference snapshot ${hash.slice(0, 14)}…`,
        bundleIds
      });
    }

    const locationGroups = new Map<string, any[]>();
    for (const project of projects) {
      const locationKey = `${project.location?.country || ''}/${project.location?.region || ''}`.toLowerCase();
      if (!locationKey || locationKey === '/') continue;
      const group = locationGroups.get(locationKey) || [];
      group.push(project);
      locationGroups.set(locationKey, group);
    }
    for (const [location, group] of locationGroups) {
      if (group.length > 1) integrityAlerts.push({
        id: `location-${location}`,
        severity: 'MEDIUM',
        type: 'OVERLAPPING_JURISDICTION',
        title: 'Projects share the same declared region',
        detail: `${group.length} projects are registered in ${location.replace('/', ', ')}. Boundary review recommended.`,
        projectIds: group.map((item) => item.project_id)
      });
    }

    return res.status(200).json({
      investigations,
      credits,
      verifiers: verifiersResult.data || [],
      disputes: disputesResult.data || [],
      integrityAlerts,
      actions,
      policy: policiesResult.data?.settings || DEFAULT_POLICY,
      watchlist: watchlistResult.data || [],
      slashingEvents: slashingResult.data || [],
      escrows: escrowsResult.data || []
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/actions', requireRoles('REGULATOR_AUDITOR'), async (req: Request, res: Response) => {
  try {
    const { projectId, tokenId, actionType, reason } = req.body;
    const allowed = ['SUSPEND_PROJECT', 'CLEAR_PROJECT', 'FREEZE_TRANSFERS', 'REVOKE_CREDITS', 'REOPEN_REVIEW', 'REQUIRE_MONITORING'];
    if (!projectId || !allowed.includes(actionType) || !reason || String(reason).trim().length < 10) {
      return res.status(400).json({ error: 'A project, valid enforcement action, and detailed reason are required' });
    }

    const { data: project } = await supabase.from('projects').select('*').eq('project_id', projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { data: bundle } = await supabase.from('evidence_bundles').select('*').eq('project_id', projectId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    const { data: projectCredits } = await supabase.from('carbon_credit_nfts').select('token_id,status').eq('project_id', projectId);

    const previousState = { projectStatus: project.status, bundleStatus: bundle?.status || null, credits: projectCredits || [] };
    const auth0 = res.locals.auth;
    const txHashes: string[] = [];
    const activeCredits = (projectCredits || []).filter((c: any) => ['ISSUED', 'TRANSFERRED', 'ESCROWED'].includes(c.status));
    if (actionType === 'SUSPEND_PROJECT') {
      txHashes.push(await RelayerService.setProjectStatusOnChain(projectId, 2));
      await supabase.from('projects').update({ status: 'SUSPENDED' }).eq('project_id', projectId);
    }
    if (actionType === 'CLEAR_PROJECT') {
      txHashes.push(await RelayerService.setProjectStatusOnChain(projectId, 1));
      await supabase.from('projects').update({ status: 'ACTIVE' }).eq('project_id', projectId);
    }
    if (actionType === 'FREEZE_TRANSFERS' || actionType === 'REVOKE_CREDITS') {
      // On-chain a freeze is a regulator-initiated dispute; a revocation is that dispute upheld
      // (which also refunds any escrowed buyer and slashes the approving verifiers).
      for (const c of activeCredits) {
        const tokenId = Number(c.token_id);
        txHashes.push(await RelayerService.disputeCreditOnChain(tokenId, '0x0000000000000000000000000000000000000000', String(reason).trim()));
        const disputeId = `DSP-REG-${tokenId}-${Date.now()}`;
        await supabase.from('disputes').insert({
          dispute_id: disputeId,
          token_id: tokenId,
          initiator_address: '0x0000000000000000000000000000000000000000',
          initiator_name: `${auth0.displayName} (Regulator)`,
          reason: String(reason).trim(),
          status: 'OPEN',
          pre_dispute_status: c.status,
          created_at: new Date().toISOString()
        });
        await supabase.from('carbon_credit_nfts').update({ status: 'DISPUTED' }).eq('token_id', tokenId);
      }
    }
    if (actionType === 'REOPEN_REVIEW' && bundle) {
      await supabase.from('evidence_bundles').update({ status: 'ANOMALOUS' }).eq('bundle_id', bundle.bundle_id);
      await supabase.from('risk_assessments').update({ verifier_required: true, auto_mint_eligible: false }).eq('bundle_id', bundle.bundle_id);
    }

    const newState = {
      projectStatus: actionType === 'SUSPEND_PROJECT' ? 'SUSPENDED' : actionType === 'CLEAR_PROJECT' ? 'ACTIVE' : project.status,
      enforcement: actionType,
      txHashes,
      note: actionType === 'REVOKE_CREDITS' ? 'Credits frozen via on-chain disputes; uphold them in the dispute console to revoke, refund and slash.' : undefined
    };
    const auth = res.locals.auth;
    const actionRecord = {
      action_id: `REG-${randomUUID()}`,
      project_id: projectId,
      token_id: tokenId || null,
      regulator_user_id: auth.id,
      regulator_name: auth.displayName,
      action_type: actionType,
      reason: String(reason).trim(),
      previous_state: previousState,
      new_state: newState
    };
    const { data: action, error } = await supabase.from('regulatory_actions').insert(actionRecord).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ success: true, action, txHashes, message: `${actionType.replace(/_/g, ' ')} recorded successfully` });
  } catch (error: any) {
    return fail(res, error);
  }
});

router.post('/policy', requireRoles('REGULATOR_AUDITOR'), async (req: Request, res: Response) => {
  try {
    const settings = req.body?.settings;
    if (!settings || !Number.isFinite(Number(settings.minimumAiConfidence)) || !Number.isFinite(Number(settings.maximumEvidenceDeviation))) {
      return res.status(400).json({ error: 'Valid policy settings are required' });
    }
    const auth = res.locals.auth;
    const { data: policy, error } = await supabase.from('regulator_policies').upsert({
      policy_name: 'GLOBAL_ISSUANCE_POLICY',
      settings,
      updated_by_user_id: auth.id,
      updated_by_name: auth.displayName,
      updated_at: new Date().toISOString()
    }, { onConflict: 'policy_name' }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true, policy, message: 'Global issuance policy updated' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/watchlist', requireRoles('REGULATOR_AUDITOR'), async (req: Request, res: Response) => {
  try {
    const { entityType, entityId, notes } = req.body;
    const auth = res.locals.auth;
    if (!['PROJECT', 'VERIFIER', 'WALLET', 'REGION'].includes(entityType)) {
      return res.status(400).json({ error: 'A valid watchlist entity type is required' });
    }
    if (!entityId) return res.status(400).json({ error: 'entityId is required' });

    const { data: existing } = await supabase.from('regulator_watchlist').select('id').eq('regulator_user_id', auth.id).eq('entity_type', entityType).eq('entity_id', entityId).maybeSingle();
    if (existing) {
      const { error } = await supabase.from('regulator_watchlist').delete().eq('id', existing.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true, watching: false, message: 'Removed from regulatory watchlist' });
    }

    const { data: item, error } = await supabase.from('regulator_watchlist').insert({
      regulator_user_id: auth.id,
      entity_type: entityType,
      entity_id: entityId,
      notes: notes || null
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ success: true, watching: true, item, message: 'Added to regulatory watchlist' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/disputes/:disputeId/resolve', requireRoles('REGULATOR_AUDITOR'), resolveDisputeHandler);

export default router;
