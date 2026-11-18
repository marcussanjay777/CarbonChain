#!/usr/bin/env node
/**
 * End-to-end verification of the full CarbonChain protocol through the REST API, against a live chain.
 *
 *  Track A (clean):  register -> evidence + Merkle root on-chain -> AI score >= 85% -> auto-mint
 *                    -> list -> buyer escrow purchase -> settle -> retire (burn) -> Merkle proof check
 *  Track B (fraud):  register -> anomalous evidence -> AI escalates -> 2 staked verifiers approve
 *                    -> mint -> list -> buyer escrow -> dispute -> regulator upholds
 *                    -> credit REVOKED, buyer refunded 100%, both verifiers slashed 50%
 *
 * Usage: node scripts/e2e-demo.mjs [apiUrl]      (backend, ML engine and Anvil must be running)
 */
const API = process.argv[2] || process.env.API_URL || 'http://localhost:5005';
const run = Date.now().toString().slice(-6);
let failures = 0;

const ok = (cond, msg) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${msg}`);
  if (!cond) failures++;
  return cond;
};

async function call(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json.error || JSON.stringify(json)}`);
  return json;
}

async function login(loginId, password) {
  const r = await call(null, 'POST', '/api/auth/login', { loginId, password });
  return { token: r.token, user: r.user };
}

const evidence = (scenario) => [
  {
    sourceType: 'OPERATIONAL_DOC',
    payload: { projectCapexUsd: 1450000, invoiceAttestationHash: '0x' + 'ab'.repeat(32), documentName: 'capex-invoices.pdf', timestamp: 1767225600 }
  },
  {
    sourceType: 'IOT_SENSOR',
    payload: scenario === 'clean'
      ? { sensorId: 'IOT-CANOPY-409', co2FluxPpm: 412.5, soilMoisturePct: 48.2, biomassKgM2: 142, timestamp: 1767225600 }
      : { sensorId: 'IOT-CANOPY-666', co2FluxPpm: 684.0, soilMoisturePct: 12.1, biomassKgM2: 142, timestamp: 1767225600 }
  },
  {
    sourceType: 'SATELLITE_NDVI',
    payload: scenario === 'clean'
      ? { satellite: 'Sentinel-2B L2A', meanNdvi: 0.812, canopyCoveragePct: 94.5, cloudCoverPct: 1.2, snapshotHash: `0xclean${run}`, latitude: -9.02, longitude: -70.81 }
      : { satellite: 'Sentinel-2B L2A', meanNdvi: 0.41, canopyCoveragePct: 38.0, cloudCoverPct: 3.0, snapshotHash: `0xfraud${run}`, latitude: -9.02, longitude: -70.81 }
  }
];

async function issue(proponent, scenario) {
  const projectId = `PROJ-${scenario.toUpperCase()}-${run}`;
  await call(proponent.token, 'POST', '/api/projects/register', {
    projectId, name: scenario === 'clean' ? 'Amazonian Peatland Bio-Sink' : 'Borneo Canopy (suspicious)',
    projectType: 'REFORESTATION', location: { country: 'Brazil', region: 'Acre' }, claimedAnnualTonnage: 500
  });
  const ev = await call(proponent.token, 'POST', '/api/evidence/upload', { projectId, evidenceItems: evidence(scenario) });
  const risk = await call(proponent.token, 'POST', '/api/risk/evaluate', {
    bundleId: ev.bundleId, projectId, projectType: 'REFORESTATION', declaredTonnage: 500, evidenceItems: evidence(scenario)
  });
  return { projectId, ev, risk };
}

async function main() {
  console.log(`CarbonChain E2E against ${API}`);
  const health = await call(null, 'GET', '/health');
  ok(health.relayerConnected, `chain connected (chainId ${health.chain?.chainId}, block ${health.chain?.blockNumber})`);

  const proponent = await login('proponent.demo', 'Carbon@2026');
  const verifierA = await login('verifier.demo', 'Verify@2026');
  const verifierB = await login('verifier2.demo', 'Verify@2026');
  const buyer = await login('buyer.demo', 'Buyer@2026');
  const auditor = await login('auditor.demo', 'Audit@2026');
  ok(true, 'all 5 demo identities authenticated');

  // ------------------------------------------------------------------ Track A
  console.log('\nTrack A - clean evidence, automatic issuance, escrow trade, retirement');
  const A = await issue(proponent, 'clean');
  ok(/^0x[0-9a-f]{64}$/.test(A.ev.merkleRoot) && /^0x[0-9a-f]{64}$/.test(A.ev.txHash), `Merkle root ${A.ev.merkleRoot.slice(0, 14)}... anchored in tx ${A.ev.txHash.slice(0, 12)}...`);
  ok(A.risk.assessment.confidence_score >= 85, `AI confidence ${A.risk.assessment.confidence_score}% (${A.risk.assessment.risk_level})`);
  ok(Boolean(A.risk.mintResult?.tokenId), `auto-minted NFT #${A.risk.mintResult?.tokenId}`);
  const tokenA = A.risk.mintResult.tokenId;

  const bundle = await call(buyer.token, 'GET', `/api/evidence/bundle/${A.ev.bundleId}`);
  const leaf = bundle.proofs[1];
  const proof = await call(buyer.token, 'POST', '/api/evidence/verify-proof', { bundleId: A.ev.bundleId, payloadHash: leaf.payloadHash, proof: leaf.proof });
  ok(proof.validOffChain && proof.validOnChain, `Merkle inclusion proof for ${leaf.sourceType} verified off-chain and by CarbonRegistry on-chain`);
  const forged = await call(buyer.token, 'POST', '/api/evidence/verify-proof', { bundleId: A.ev.bundleId, payloadHash: '0x' + '11'.repeat(32), proof: leaf.proof });
  ok(!forged.valid, 'tampered telemetry hash is rejected');

  await call(proponent.token, 'POST', '/api/marketplace/list', { tokenId: tokenA, priceEth: 0.5 });
  const buyA = await call(buyer.token, 'POST', '/api/marketplace/escrow/buy', { tokenId: tokenA });
  ok(Boolean(buyA.escrowId), `buyer paid 0.5 ETH into escrow ${buyA.escrowId.slice(0, 12)}...`);
  await call(buyer.token, 'POST', '/api/marketplace/escrow/release', { escrowId: buyA.escrowId });
  const retire = await call(buyer.token, 'POST', '/api/marketplace/retire', { tokenId: tokenA, retirementReason: 'FY2026 Scope 1 neutralisation', beneficiaryLegalName: 'Northstar ESG Fund' });
  ok(Boolean(retire.burnTxHash), `NFT #${tokenA} burned on-chain, certificate ${retire.certificate.certificateId}`);

  // ------------------------------------------------------------------ Track B
  console.log('\nTrack B - fraudulent evidence, compromised verifiers, dispute, slashing, refund');
  const B = await issue(proponent, 'fraud');
  ok(B.risk.assessment.verifier_required && !B.risk.mintResult, `AI confidence ${B.risk.assessment.confidence_score}% -> escalated to verifiers (no auto-mint)`);

  for (const v of [verifierA, verifierB]) await call(v.token, 'POST', '/api/verifiers/stake', { amountEth: 1 });
  const before = await call(verifierA.token, 'GET', '/api/verifiers/me');
  ok(before.profile.isStaked, `verifier staked on-chain: ${before.profile.stakedEth} ETH`);

  const checklist = { identity: true, telemetry: true, satellite: true, financial: true, additionality: true };
  const vote = (v) => call(v.token, 'POST', '/api/verifiers/verify', {
    bundleId: B.ev.bundleId, approved: true, auditNotes: 'Looks fine to me, approving the bundle.', checklist, conflictConfirmed: true, decisionConfidence: 90, recommendedTonnage: 500
  });
  const v1 = await vote(verifierA);
  const v2 = v1.finalized ? v1 : await vote(verifierB);
  ok(v2.finalized && v2.approved && v2.tokenId, `verifier quorum (${v2.quorum.approvals}/${v2.quorum.required}) approved; NFT #${v2.tokenId} minted`);
  const tokenB = v2.tokenId;

  await call(proponent.token, 'POST', '/api/marketplace/list', { tokenId: tokenB, priceEth: 2 });
  const buyB = await call(buyer.token, 'POST', '/api/marketplace/escrow/buy', { tokenId: tokenB });
  const chainBefore = await call(buyer.token, 'GET', '/api/lifecycle/chain');
  const buyerWallet = chainBefore.wallets.find((w) => w.role === 'CORPORATE_BUYER');

  const dispute = await call(buyer.token, 'POST', '/api/disputes/raise', { tokenId: tokenB, reason: 'Satellite NDVI shows 60% canopy loss, sensor CO2 flux far above baseline.' });
  ok(dispute.dispute.status === 'OPEN', `dispute ${dispute.dispute.dispute_id} raised; credit frozen on-chain`);

  let blocked = false;
  try { await call(buyer.token, 'POST', '/api/marketplace/escrow/release', { escrowId: buyB.escrowId }); } catch { blocked = true; }
  ok(blocked, 'escrow settlement is blocked while the credit is disputed');

  const ruling = await call(auditor.token, 'POST', `/api/disputes/${dispute.dispute.dispute_id}/resolve`, { ruling: 'UPHELD', reason: 'Evidence proves the canopy claim was fabricated.' });
  ok(Number(ruling.refundEth) === 2, `buyer refunded ${ruling.refundEth} ETH from escrow`);
  ok(Number(ruling.slashedEth) === 1, `approving verifiers slashed ${ruling.slashedEth} ETH total (50% each)`);

  const after = await call(verifierA.token, 'GET', '/api/verifiers/me');
  ok(Number(after.profile.stakedEth) === Number(before.profile.stakedEth) / 2, `verifier stake ${before.profile.stakedEth} -> ${after.profile.stakedEth} ETH, reputation ${after.profile.reputationScore}`);

  const chainAfter = await call(buyer.token, 'GET', '/api/lifecycle/chain');
  const buyerAfter = chainAfter.wallets.find((w) => w.role === 'CORPORATE_BUYER');
  ok(Number(buyerAfter.balanceEth) - Number(buyerWallet.balanceEth) > 1.99, `buyer wallet balance restored (+${(Number(buyerAfter.balanceEth) - Number(buyerWallet.balanceEth)).toFixed(4)} ETH)`);

  const life = await call(auditor.token, 'GET', '/api/lifecycle/projects');
  const pB = life.projects.find((p) => p.id === B.projectId);
  ok(pB?.nfts[0]?.status === 'REVOKED', `lifecycle read model shows NFT #${tokenB} REVOKED`);

  let revokedBlocked = false;
  try { await call(proponent.token, 'POST', '/api/marketplace/list', { tokenId: tokenB, priceEth: 1 }); } catch { revokedBlocked = true; }
  ok(revokedBlocked, 'revoked credit can never be relisted');

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nE2E aborted:', e.message);
  process.exit(1);
});
