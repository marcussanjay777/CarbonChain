import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { CryptographicService } from '../services/cryptographic.service';
import { RelayerService } from '../services/relayer.service';
import { authenticate, requireRoles } from '../auth/middleware';
import { fail, notify } from './helpers';

const router = Router();
const ML_ENGINE_URL = process.env.ML_ENGINE_URL || 'http://localhost:8000';

router.post('/evaluate', requireRoles('PROJECT_PROPONENT'), async (req: Request, res: Response) => {
  try {
    const { bundleId, projectId, projectType, declaredTonnage, evidenceItems } = req.body || {};

    if (!bundleId) {
      return res.status(400).json({ error: 'bundleId is required' });
    }

    const declared = Number(declaredTonnage || 500);
    const rawItems: any[] = Array.isArray(evidenceItems) ? evidenceItems : [];
    const { data: policyRecord } = await supabase
      .from('regulator_policies')
      .select('settings')
      .eq('policy_name', 'GLOBAL_ISSUANCE_POLICY')
      .maybeSingle();
    const activePolicy = policyRecord?.settings || {};
    const minimumAiConfidence = Number(activePolicy.minimumAiConfidence || 85);
    const maximumEvidenceDeviation = Number(activePolicy.maximumEvidenceDeviation || 15);
    const automaticEscalation = activePolicy.automaticEscalation !== false;

    // Normalize items for ML schema compatibility
    const normalizedItems = rawItems.map((item: any) => {
      const p = item.payload || item;
      let metric = 'CO2_FLUX';
      let value = 0;
      let calculatedTonnage = declared;

      if (item.sourceType === 'IOT_SENSOR' || p.sensorId) {
        metric = 'CO2_FLUX';
        value = Number(p.co2FluxPpm ?? p.co2Flux ?? p.value ?? 418.2);
        calculatedTonnage = Number(p.biomassKgM2 ? p.biomassKgM2 * 3.5 : declared);
      } else if (item.sourceType === 'SATELLITE_NDVI' || p.satellite) {
        metric = 'NDVI_CHANGE';
        value = Number(p.meanNdvi ?? p.ndvi ?? 0.812);
        calculatedTonnage = Number(p.canopyCoveragePct ? (p.canopyCoveragePct / 100) * declared * 1.1 : declared);
      } else {
        metric = 'VERIFIER_ASSESSMENT';
        value = 1.0;
        calculatedTonnage = declared;
      }

      return {
        sourceType: item.sourceType || 'IOT_SENSOR',
        metric,
        value,
        calculatedTonnage,
        timestamp: Number(p.timestamp || item.timestamp || Math.floor(Date.now() / 1000))
      };
    });

    let scoreResult: any;
    try {
      const response = await fetch(`${ML_ENGINE_URL}/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bundleId,
          projectId: projectId || 'PROJ-DEFAULT',
          projectType: projectType || 'REFORESTATION',
          declaredTonnage: declared,
          evidenceItems: normalizedItems
        })
      });

      if (response.ok) {
        scoreResult = await response.json();
      } else {
        const errText = await response.text();
        throw new Error(`ML Engine HTTP ${response.status}: ${errText}`);
      }
    } catch (mlErr: any) {
      console.warn('ML Engine offline or executing dynamic heuristic fallback:', mlErr.message);

      let deductions = 0;
      const flags: string[] = [];

      for (const item of normalizedItems) {
        if (item.sourceType === 'IOT_SENSOR' && item.value > 600) {
          deductions += 35;
          flags.push(`CO2_FLUX_ELEVATED: Sensor CO2 flux ${item.value} ppm exceeds standard baseline`);
        }
        if (item.sourceType === 'SATELLITE_NDVI' && item.value < 0.65) {
          deductions += 30;
          flags.push(`NDVI_DEGRADATION: Satellite canopy NDVI (${item.value}) indicates low vegetative density`);
        }
        const devPct = Math.abs((item.calculatedTonnage - declared) / declared) * 100;
        if (devPct > maximumEvidenceDeviation) {
          deductions += 20;
          flags.push(`TONNAGE_MISMATCH: Calculated tonnage deviates ${devPct.toFixed(1)}% from declared ${declared} tCO2e (policy limit: ${maximumEvidenceDeviation}%)`);
        }
      }

      const dynScore = Math.max(0, Math.min(100, 100 - deductions));
      const dynRisk = dynScore >= 85 ? 'LOW' : dynScore >= 60 ? 'MEDIUM' : 'HIGH';
      const autoMint = dynScore >= 85;

      scoreResult = {
        bundleId,
        confidenceScore: dynScore,
        riskLevel: dynRisk,
        autoMintEligible: autoMint,
        verifierRequired: !autoMint,
        anomalyFlags: flags,
        explanationReason: flags.length === 0
          ? `All ${normalizedItems.length} telemetry streams corroborated within acceptable variance thresholds. Dynamic confidence score: ${dynScore}%.`
          : `Heuristic anomaly check detected ${flags.length} discrepancy flag(s). Calculated confidence score: ${dynScore}%.`,
        executionTimeMs: 12
      };
    }

    const {
      confidenceScore,
      riskLevel,
      anomalyFlags,
      explanationReason
    } = scoreResult;
    const policyConfidenceMet = Number(confidenceScore) >= minimumAiConfidence;
    const autoMintEligible = Boolean(scoreResult.autoMintEligible) && policyConfidenceMet;
    const verifierRequired = automaticEscalation
      ? Boolean(scoreResult.verifierRequired) || !policyConfidenceMet
      : Boolean(scoreResult.verifierRequired);

    const assessmentRecord = {
      bundle_id: bundleId,
      confidence_score: confidenceScore,
      risk_level: riskLevel,
      anomaly_flags: anomalyFlags || [],
      explanation_reason: explanationReason || 'Cross-source evidence corroborated',
      auto_mint_eligible: autoMintEligible,
      verifier_required: verifierRequired
    };

    // The bundle must belong to the caller and already be anchored on-chain.
    const { data: bundleRow } = await supabase.from('evidence_bundles').select('*, projects(*)').eq('bundle_id', bundleId).maybeSingle();
    if (!bundleRow) return res.status(404).json({ error: 'Evidence bundle not found. Upload evidence first.' });
    const projectRow: any = (bundleRow as any).projects;
    if (projectRow?.created_by_user_id && projectRow.created_by_user_id !== res.locals.auth.id) {
      return res.status(403).json({ error: 'Only the project proponent can evaluate this bundle' });
    }

    const correlationMet = !(anomalyFlags || []).some((f: string) => f.includes('MISMATCH') || f.includes('DEVIATION'));
    const confidenceMet = Number(confidenceScore) >= minimumAiConfidence;
    const onChainRiskTxHash = await RelayerService.recordRiskResultOnChain(bundleId, correlationMet, confidenceMet, verifierRequired);

    const { data: riskRecord, error: riskError } = await supabase
      .from('risk_assessments')
      .upsert({ ...assessmentRecord, on_chain_tx_hash: onChainRiskTxHash })
      .select()
      .single();
    if (riskError) return res.status(500).json({ error: riskError.message });

    await supabase.from('evidence_bundles').update({ status: verifierRequired ? 'ANOMALOUS' : 'CORRELATED' }).eq('bundle_id', bundleId);

    // Policy-gated auto-issuance: high confidence + cross-source agreement mints with no human in the loop.
    let mintResult: any = null;
    if (autoMintEligible && correlationMet && !verifierRequired) {
      const tonnage = Math.max(1, Math.floor(declared));
      const vintage = new Date().getFullYear();
      const minted = await RelayerService.mintCreditOnChain(bundleId, tonnage, vintage);
      await supabase.from('carbon_credit_nfts').insert({
        token_id: minted.tokenId,
        project_id: bundleRow.project_id,
        bundle_id: bundleId,
        current_owner: projectRow.owner_address,
        co2_tonnage: tonnage,
        vintage_year: vintage,
        merkle_root: bundleRow.merkle_root,
        mint_tx_hash: minted.txHash,
        status: 'ISSUED'
      });
      await supabase.from('evidence_bundles').update({ status: 'ISSUED' }).eq('bundle_id', bundleId);
      await notify({
        title: 'Credit Auto-Issued',
        message: `AI confidence ${confidenceScore}% passed the policy gate. ${tonnage} tCO2e minted as NFT #${minted.tokenId} to your wallet.`,
        category: 'NFT_ISSUED',
        recipientRole: 'PROJECT_PROPONENT',
        projectId: bundleRow.project_id,
        txHash: minted.txHash
      });
      mintResult = { ...minted, tonnage, vintage };
    } else {
      await notify({
        title: 'Escalated to Independent Verifiers',
        message: `AI confidence ${confidenceScore}% (${riskLevel}) is below the issuance gate. A staked verifier quorum must review this bundle.`,
        category: 'VERIFIER_STAKE',
        recipientRole: 'INDEPENDENT_VERIFIER',
        projectId: bundleRow.project_id,
        txHash: onChainRiskTxHash
      });
    }

    return res.status(200).json({
      success: true,
      riskAssessment: riskRecord,
      assessment: riskRecord,
      txHash: onChainRiskTxHash,
      onChainRiskTxHash,
      mintResult,
      message: mintResult ? 'Risk evaluated, recorded on-chain and credit minted automatically' : 'Risk assessment evaluated and recorded on-chain'
    });
  } catch (error: any) {
    return fail(res, error);
  }
});

router.get('/:bundleId', authenticate, async (req: Request, res: Response) => {
  try {
    const { bundleId } = req.params;
    const { data, error } = await supabase
      .from('risk_assessments')
      .select('*')
      .eq('bundle_id', bundleId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Risk assessment not found' });
    }

    return res.json({ assessment: data, riskAssessment: data });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
