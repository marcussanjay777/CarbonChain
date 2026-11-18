import React, { useState, useEffect, useCallback } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ClipboardCheck,
  Scale,
  FileText,
  Radio,
  Satellite,
  X,
  Coins,
  Sparkles,
  Award,
  Lock,
  XCircle,
  Hash,
  Users
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { projectFlowStore, LifecycleProject } from '../lib/projectFlowStore';

const CHECKLIST_ITEMS = [
  { key: 'identity', label: 'Project identity and ownership verified via KYC & DID' },
  { key: 'financial', label: 'Financial additionality evidence & invoices cross-verified' },
  { key: 'iot', label: 'Ground IoT telemetry readings & device signatures validated' },
  { key: 'satellite', label: 'Sentinel-2 satellite multispectral NDVI matched to coordinates' },
  { key: 'duplicate', label: 'Prior credit issuance & double-counting check completed' }
] as const;

const emptyChecklist = () => Object.fromEntries(CHECKLIST_ITEMS.map((item) => [item.key, false])) as Record<string, boolean>;
const short = (h?: string | null, n = 10) => (h ? `${h.slice(0, n)}…${h.slice(-6)}` : '—');

interface ChainProfile {
  stakedEth: string;
  reputationScore: number;
  totalVerified: number;
  totalSlashedEth: string;
  lockedUntil: number;
  isStaked: boolean;
}

export default function VerifierPortal({ walletAddress }: { walletAddress: string | null }) {
  const [profile, setProfile] = useState<ChainProfile | null>(null);
  const [balanceEth, setBalanceEth] = useState<string>('');
  const [stakeInput, setStakeInput] = useState<number>(1);
  const [queueProjects, setQueueProjects] = useState<LifecycleProject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [checklist, setChecklist] = useState<Record<string, boolean>>(emptyChecklist);
  const [auditNotes, setAuditNotes] = useState('');
  const [decisionConfidence, setDecisionConfidence] = useState(90);
  const [recommendedTonnage, setRecommendedTonnage] = useState<number>(500);
  const [conflictConfirmed, setConflictConfirmed] = useState(false);
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [showEvidenceRequest, setShowEvidenceRequest] = useState(false);
  const [requestMessage, setRequestMessage] = useState('');

  const loadProfile = useCallback(async () => {
    try {
      const me = await projectFlowStore.getMyVerifierProfile();
      setProfile(me.profile);
      setBalanceEth(me.balanceEth || '');
    } catch (err: any) {
      setActionError(err.message);
    }
  }, []);

  const syncQueue = useCallback(() => {
    const queue = projectFlowStore.getVerifierQueue(walletAddress);
    setQueueProjects(queue);
    setSelectedId((current) => (current && queue.some((p) => p.id === current) ? current : queue[0]?.id || null));
  }, [walletAddress]);

  useEffect(() => {
    syncQueue();
    void loadProfile();
    return projectFlowStore.subscribe(syncQueue);
  }, [syncQueue, loadProfile]);

  const selectedProject = queueProjects.find((p) => p.id === selectedId) || null;
  const me = walletAddress?.toLowerCase();
  const myVote = selectedProject?.quorum?.votes.find((v) => v.verifierAddress?.toLowerCase() === me);
  const isOwnProject = Boolean(me && selectedProject?.developerWallet?.toLowerCase() === me);
  const decided = selectedProject && !['VERIFIER_PENDING_STAKE', 'VERIFIER_AUDITING'].includes(selectedProject.lifecycleState);

  useEffect(() => {
    if (!selectedProject) return;
    setChecklist(emptyChecklist());
    setAuditNotes('');
    setConflictConfirmed(false);
    setRecommendedTonnage(selectedProject.claimedAnnualTonnage);
    setActionError('');
  }, [selectedProject?.id]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setActionError('');
    setActionMessage('');
    try {
      await fn();
    } catch (err: any) {
      setActionError(err.message || 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  const handleStake = () =>
    run('stake', async () => {
      const r = await projectFlowStore.stake(stakeInput);
      await loadProfile();
      setActionMessage(`${stakeInput} ETH bonded in VerifierStakingLedger · tx ${short(r.txHash)}`);
      confetti({ particleCount: 70, spread: 60, origin: { y: 0.6 } });
    });

  const handleVote = (approved: boolean) => {
    if (!selectedProject) return;
    if (!CHECKLIST_ITEMS.every((item) => checklist[item.key])) {
      setActionError('Complete all 5 verification checklist items before signing a decision.');
      return;
    }
    if (!conflictConfirmed) {
      setActionError('Confirm the conflict-of-interest declaration.');
      return;
    }
    if (auditNotes.trim().length < 10) {
      setActionError('Write at least 10 characters of audit notes.');
      return;
    }
    return run(approved ? 'approve' : 'reject', async () => {
      const r = await projectFlowStore.completeAudit(selectedProject, {
        approved,
        notes: auditNotes,
        confidence: decisionConfidence,
        recommendedTonnage,
        checklist
      });
      await loadProfile();
      if (r.finalized && r.approved) {
        setActionMessage(`Quorum reached — credit NFT #${r.tokenId} minted to the proponent · mint tx ${short(r.transactionHash)}`);
        confetti({ particleCount: 140, spread: 80, origin: { y: 0.6 }, colors: ['#10B981', '#F59E0B', '#3B82F6'] });
      } else if (r.finalized) {
        setActionMessage('Quorum rejected the evidence bundle. No credit can be issued.');
      } else {
        setActionMessage(`Vote recorded on-chain (tx ${short(r.voteTxHash)}). ${r.message}`);
      }
    });
  };

  const handleEvidenceRequest = () =>
    run('request', async () => {
      if (!selectedProject) return;
      await projectFlowStore.requestEvidence(selectedProject, requestMessage);
      setShowEvidenceRequest(false);
      setRequestMessage('');
      setActionMessage('Evidence request recorded in the audit trail and sent to the proponent.');
    });

  const iot = selectedProject?.evidenceSummary?.iot;
  const sat = selectedProject?.evidenceSummary?.satellite;
  const fin = selectedProject?.evidenceSummary?.financial;
  const lockedUntil = profile?.lockedUntil ? new Date(profile.lockedUntil * 1000) : null;

  return (
    <div className="space-y-8 text-left w-full max-w-6xl mx-auto">
      <div className="portal-page-header flex flex-col md:flex-row items-start md:items-center justify-between gap-4 p-6 rounded-2xl bg-gradient-to-r from-amber-950/30 via-slate-900/60 to-slate-950 border border-amber-500/20 backdrop-blur-md">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-500/20 text-amber-400">
              <Scale className="h-3.5 w-3.5" />
            </span>
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-400">Proof-of-Stake Auditor Node</span>
          </div>
          <h1 className="text-2xl font-black text-white">Independent Verifier Staking & Audit Portal</h1>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
            Bundles the AI engine could not auto-approve are escalated here. Each decision is a signed on-chain vote backed by your
            staked ETH. <strong>If a credit you approved is later proven fraudulent, 50% of your stake is slashed.</strong>
          </p>
        </div>
        <button
          onClick={() => { void projectFlowStore.refresh(); void loadProfile(); }}
          className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold flex items-center gap-2 text-white transition-all"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      {actionMessage && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-300">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" /> {actionMessage}
        </div>
      )}
      {actionError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-300">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" /> {actionError}
        </div>
      )}

      {/* On-chain staking profile */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-4 rounded-xl bg-slate-900/80 border border-amber-500/20">
          <div className="text-[10px] font-bold uppercase tracking-wider text-amber-400">Staked Collateral (on-chain)</div>
          <div className="text-2xl font-black font-mono text-white mt-1">{profile ? Number(profile.stakedEth).toFixed(3) : '…'} ETH</div>
          <p className="text-[10px] text-slate-400 mt-1">{profile?.isStaked ? 'Active in verifier pool' : 'Below 0.1 ETH minimum'}</p>
        </div>
        <div className="p-4 rounded-xl bg-slate-900/80 border border-emerald-500/20">
          <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">Reputation (ledger)</div>
          <div className="text-2xl font-black font-mono text-emerald-400 mt-1">{profile?.reputationScore ?? '…'}/100</div>
          <p className="text-[10px] text-slate-400 mt-1">{profile?.totalVerified ?? 0} audits signed</p>
        </div>
        <div className="p-4 rounded-xl bg-slate-900/80 border border-red-500/20">
          <div className="text-[10px] font-bold uppercase tracking-wider text-red-400">Total Slashed</div>
          <div className="text-2xl font-black font-mono text-red-300 mt-1">{profile ? Number(profile.totalSlashedEth).toFixed(3) : '…'} ETH</div>
          <p className="text-[10px] text-slate-400 mt-1">Sent to protocol treasury</p>
        </div>
        <div className="p-4 rounded-xl bg-slate-900/80 border border-sky-500/20">
          <div className="text-[10px] font-bold uppercase tracking-wider text-sky-400">Wallet</div>
          <div className="text-sm font-black font-mono text-white mt-1 truncate">{walletAddress ? short(walletAddress, 8) : 'No wallet'}</div>
          <p className="text-[10px] text-slate-400 mt-1">{balanceEth ? `${Number(balanceEth).toFixed(3)} ETH balance` : ''}</p>
        </div>
      </div>

      <div className="p-5 rounded-2xl bg-amber-950/20 border border-amber-500/30 flex flex-col md:flex-row md:items-center gap-4 justify-between">
        <div className="flex items-start gap-3">
          <Lock className="w-6 h-6 text-amber-400 mt-0.5" />
          <div className="text-xs text-slate-300">
            <div className="text-sm font-black text-white">Bond collateral in VerifierStakingLedger</div>
            Minimum 0.1 ETH to vote. After every vote your stake is locked
            {lockedUntil && lockedUntil > new Date() ? <> until <strong className="text-amber-300">{lockedUntil.toLocaleTimeString()}</strong></> : ' for the lock period'} so
            you cannot approve fraud and withdraw before a dispute.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={stakeInput}
            onChange={(e) => setStakeInput(Number(e.target.value))}
            className="w-24 rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-amber-500"
          />
          <button
            onClick={handleStake}
            disabled={busy !== null || stakeInput < 0.1}
            className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-extrabold flex items-center gap-2 disabled:opacity-50"
          >
            <Coins className="w-4 h-4" /> {busy === 'stake' ? 'Staking…' : 'Stake ETH'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Queue */}
        <div className="lg:col-span-4 space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">Anomaly Queue ({queueProjects.length})</h3>
          <div className="space-y-2 max-h-[640px] overflow-y-auto">
            {queueProjects.length === 0 ? (
              <div className="p-8 rounded-2xl bg-white/5 border border-white/10 text-center text-xs text-slate-400">
                No bundles are waiting for human review. High-confidence bundles are issued automatically by the policy gate.
              </div>
            ) : (
              queueProjects.map((p) => {
                const isSelected = selectedId === p.id;
                const open = ['VERIFIER_PENDING_STAKE', 'VERIFIER_AUDITING'].includes(p.lifecycleState);
                return (
                  <div
                    key={p.id}
                    onClick={() => setSelectedId(p.id)}
                    className={`p-3.5 rounded-2xl border cursor-pointer transition-all ${
                      isSelected ? 'border-amber-500/50 bg-amber-950/20 shadow-lg shadow-amber-500/10' : 'border-white/5 bg-white/[0.02] hover:bg-white/[0.05]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] text-emerald-400">{p.id}</span>
                      <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border ${open ? 'bg-amber-500/20 text-amber-300 border-amber-500/30' : 'bg-teal-500/20 text-teal-300 border-teal-500/30'}`}>
                        {p.lifecycleState.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <h4 className="text-sm font-bold text-white mt-1 truncate">{p.name}</h4>
                    <div className="flex items-center justify-between text-[10px] text-slate-500 mt-2 pt-2 border-t border-white/5">
                      <span>Quorum {p.quorum?.approvals ?? 0}/{p.quorum?.required ?? 1}</span>
                      <span className={p.aiConfidenceScore < 60 ? 'text-red-400' : 'text-amber-300'}>AI {p.aiConfidenceScore}% · {p.riskLevel}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Workbench */}
        <div className="lg:col-span-8 space-y-6">
          {selectedProject ? (
            <div className="space-y-6">
              <div className="p-6 rounded-2xl bg-slate-900/80 border border-white/10 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-white/10 pb-4">
                  <div>
                    <span className="font-mono text-xs text-emerald-400 font-bold">{selectedProject.id}</span>
                    <h2 className="text-xl font-black text-white mt-1">{selectedProject.name}</h2>
                    <div className="text-xs text-slate-400 mt-0.5">
                      Proponent: <strong className="text-white">{selectedProject.developerName}</strong> ({short(selectedProject.developerWallet, 8)})
                    </div>
                  </div>
                  <div className="text-left sm:text-right">
                    <span className="text-[10px] uppercase font-bold text-slate-500">Declared</span>
                    <div className="text-xl font-black text-emerald-400 font-mono">{selectedProject.claimedAnnualTonnage.toLocaleString()} tCO2e</div>
                  </div>
                </div>

                {/* AI verdict */}
                <div className={`rounded-xl p-4 border text-xs ${selectedProject.aiConfidenceScore < 60 ? 'border-red-500/40 bg-red-500/10' : 'border-amber-500/40 bg-amber-500/10'}`}>
                  <div className="flex items-center justify-between font-bold">
                    <span className="text-white">AI anomaly engine (Isolation Forest + cross-source correlation)</span>
                    <span className={selectedProject.aiConfidenceScore < 60 ? 'text-red-300' : 'text-amber-300'}>
                      {selectedProject.aiConfidenceScore}% · {selectedProject.riskLevel} RISK
                    </span>
                  </div>
                  {selectedProject.riskExplanation && <p className="mt-2 text-slate-300">{selectedProject.riskExplanation}</p>}
                  {(selectedProject.anomalyFlags || []).length > 0 && (
                    <ul className="mt-2 space-y-1 font-mono text-[10px] text-red-200">
                      {(selectedProject.anomalyFlags || []).map((f) => <li key={f}>⚠ {f}</li>)}
                    </ul>
                  )}
                </div>

                {/* Side-by-side telemetry */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                  <div className="p-3 rounded-xl bg-black/40 border border-white/10 space-y-1">
                    <div className="flex items-center gap-1.5 font-bold text-emerald-400 text-[10px] uppercase"><FileText className="w-3.5 h-3.5" /> Financial evidence</div>
                    <div className="font-bold text-white">${Number(fin?.capexUsd || 0).toLocaleString()} capex</div>
                    <div className="text-[10px] text-slate-400 truncate">{fin?.documentName || 'No document'}</div>
                  </div>
                  <div className="p-3 rounded-xl bg-black/40 border border-white/10 space-y-1">
                    <div className="flex items-center gap-1.5 font-bold text-sky-400 text-[10px] uppercase"><Radio className="w-3.5 h-3.5" /> Ground IoT</div>
                    <div className="font-bold text-white">{iot?.co2FluxPpm ?? '—'} ppm CO₂ flux</div>
                    <div className="text-[10px] text-slate-400">Biomass {iot?.biomassKgM2 ?? '—'} kg/m² · ≈{iot?.biomassKgM2 ? Math.round(iot.biomassKgM2 * 3.5) : '—'} t</div>
                  </div>
                  <div className="p-3 rounded-xl bg-black/40 border border-white/10 space-y-1">
                    <div className="flex items-center gap-1.5 font-bold text-violet-400 text-[10px] uppercase"><Satellite className="w-3.5 h-3.5" /> Sentinel-2 NDVI</div>
                    <div className="font-bold text-white">NDVI {sat?.meanNdvi ?? '—'}</div>
                    <div className="text-[10px] text-slate-400">Canopy {sat?.canopyCoveragePct ?? '—'}% · {sat?.source || 'satellite'}</div>
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-black/50 border border-white/5 font-mono text-[11px] text-slate-400 space-y-1">
                  <div className="truncate"><Hash className="inline w-3 h-3 mr-1" />Merkle root: <span className="text-emerald-300">{selectedProject.merkleRoot}</span></div>
                  <div className="truncate">Anchored in tx: <span className="text-sky-300">{selectedProject.evidenceTxHash}</span></div>
                </div>

                {/* Quorum */}
                <div className="rounded-xl border border-white/10 bg-black/30 p-4 text-xs space-y-2">
                  <div className="flex items-center justify-between font-bold text-white">
                    <span className="flex items-center gap-1.5"><Users className="w-4 h-4 text-sky-400" /> Verifier quorum</span>
                    <span className="font-mono">{selectedProject.quorum?.approvals ?? 0} approve · {selectedProject.quorum?.rejections ?? 0} reject · {selectedProject.quorum?.required ?? 1} required</span>
                  </div>
                  {(selectedProject.quorum?.votes || []).length === 0 ? (
                    <p className="text-slate-400">No votes yet.</p>
                  ) : (
                    selectedProject.quorum!.votes.map((v) => (
                      <div key={v.verifierAddress} className="flex items-center justify-between gap-2 text-[11px] border-t border-white/5 pt-2">
                        <span className={v.approved ? 'text-emerald-300' : 'text-red-300'}>{v.approved ? '✔ APPROVED' : '✖ REJECTED'} · {v.verifierName || short(v.verifierAddress, 8)}</span>
                        <span className="font-mono text-slate-500">tx {short(v.voteTxHash)}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {decided ? (
                <div className="p-6 rounded-2xl bg-slate-900/60 border border-teal-500/30 space-y-2 text-xs">
                  <div className="flex items-center gap-2 text-teal-400 font-bold text-sm">
                    <CheckCircle2 className="w-5 h-5" /> Quorum finalized: {selectedProject.lifecycleState.replace(/_/g, ' ')}
                  </div>
                  {selectedProject.nfts.map((n) => (
                    <div key={n.tokenId} className="font-mono text-[11px] text-slate-300">
                      NFT #{n.tokenId} · {n.co2Tonnage} tCO2e · status <span className={n.status === 'REVOKED' ? 'text-red-300' : 'text-teal-300'}>{n.status}</span> · mint tx {short(n.mintTxHash)}
                    </div>
                  ))}
                </div>
              ) : myVote ? (
                <div className="p-6 rounded-2xl bg-slate-900/60 border border-sky-500/30 text-xs text-slate-300">
                  You voted <strong className={myVote.approved ? 'text-emerald-300' : 'text-red-300'}>{myVote.approved ? 'APPROVE' : 'REJECT'}</strong> (tx {short(myVote.voteTxHash)}).
                  Waiting for {Math.max(0, (selectedProject.quorum?.required ?? 1) - Math.max(selectedProject.quorum?.approvals ?? 0, selectedProject.quorum?.rejections ?? 0))} more independent verifier decision(s).
                </div>
              ) : isOwnProject ? (
                <div className="p-6 rounded-2xl bg-red-950/30 border border-red-500/30 text-xs text-red-200">
                  Conflict of interest: you own this project, so the registry contract will reject your vote.
                </div>
              ) : !profile?.isStaked ? (
                <div className="p-6 rounded-2xl bg-amber-950/20 border-2 border-amber-500/40 text-xs text-slate-300 flex items-center gap-3">
                  <Lock className="w-6 h-6 text-amber-400" /> Stake at least 0.1 ETH above to unlock the audit workbench for this bundle.
                </div>
              ) : (
                <div className="p-6 rounded-2xl bg-slate-900/90 border border-emerald-500/30 space-y-5">
                  <div className="flex items-center gap-2 border-b border-white/10 pb-3">
                    <ClipboardCheck className="w-5 h-5 text-emerald-400" />
                    <h3 className="text-base font-bold text-white">Verification Audit Workbench</h3>
                  </div>
                  <div className="space-y-2">
                    {CHECKLIST_ITEMS.map((item) => (
                      <label key={item.key} className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/10 hover:bg-white/5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checklist[item.key] || false}
                          onChange={(e) => setChecklist({ ...checklist, [item.key]: e.target.checked })}
                          className="h-4 w-4 rounded text-emerald-500 border-slate-700 bg-black"
                        />
                        <span className="text-xs text-slate-200 font-medium">{item.label}</span>
                      </label>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <label className="block font-semibold text-slate-300">
                      Recommended issuance (tCO₂e)
                      <input type="number" min={1} value={recommendedTonnage} onChange={(e) => setRecommendedTonnage(Number(e.target.value))}
                        className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-emerald-500" />
                    </label>
                    <label className="block font-semibold text-slate-300">
                      Decision confidence (%)
                      <input type="number" min={0} max={100} value={decisionConfidence} onChange={(e) => setDecisionConfidence(Number(e.target.value))}
                        className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-emerald-500" />
                    </label>
                  </div>
                  <label className="block text-xs font-semibold text-slate-300">
                    Audit notes & justification
                    <textarea rows={3} value={auditNotes} onChange={(e) => setAuditNotes(e.target.value)}
                      className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-white outline-none focus:border-emerald-500"
                      placeholder="Sensor validation, ground truth inspection, additionality confirmation…" />
                  </label>
                  <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer">
                    <input type="checkbox" checked={conflictConfirmed} onChange={(e) => setConflictConfirmed(e.target.checked)} className="h-4 w-4 rounded text-emerald-500" />
                    <span>I declare zero commercial conflict of interest with this project proponent.</span>
                  </label>
                  <div className="flex flex-col sm:flex-row items-center justify-end gap-3 pt-3 border-t border-white/10">
                    <button onClick={() => setShowEvidenceRequest(true)} className="w-full sm:w-auto px-4 py-2.5 rounded-xl border border-white/10 text-xs font-semibold text-slate-300 hover:bg-white/5">
                      Request Evidence
                    </button>
                    <button onClick={() => handleVote(false)} disabled={busy !== null}
                      className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-red-500/90 hover:bg-red-400 text-white text-xs font-extrabold flex items-center justify-center gap-2 disabled:opacity-50">
                      <XCircle className="w-4 h-4" /> {busy === 'reject' ? 'Signing…' : 'Reject & Flag Fraud'}
                    </button>
                    <button onClick={() => handleVote(true)} disabled={busy !== null}
                      className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-extrabold shadow-lg shadow-emerald-500/25 flex items-center justify-center gap-2 disabled:opacity-50">
                      <Award className="w-4 h-4" /> {busy === 'approve' ? 'Signing…' : 'Approve & Sign On-Chain'}
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-500 flex items-center gap-1"><Sparkles className="w-3 h-3" /> When the quorum approves, CarbonRegistry mints the ERC-721 credit straight to the proponent's wallet.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="p-12 rounded-2xl bg-white/5 border border-white/10 text-center text-slate-400 text-xs">Select a bundle from the queue to start review.</div>
          )}
        </div>
      </div>

      {showEvidenceRequest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md">
          <div className="w-full max-w-md rounded-3xl border border-sky-500/30 bg-[#0B0F17] p-6 shadow-2xl space-y-4 text-xs">
            <div className="flex items-start justify-between">
              <h3 className="text-base font-bold text-white">Request Additional Evidence</h3>
              <button onClick={() => setShowEvidenceRequest(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <textarea rows={4} value={requestMessage} onChange={(e) => setRequestMessage(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-black/40 p-3 text-white outline-none focus:border-sky-500"
              placeholder="Specify documentation, drone imagery or soil core samples required…" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowEvidenceRequest(false)} className="px-4 py-2 rounded-xl border border-white/10 text-slate-300">Cancel</button>
              <button onClick={handleEvidenceRequest} disabled={requestMessage.trim().length < 10 || busy !== null}
                className="px-5 py-2 rounded-xl bg-sky-500 text-slate-950 font-bold hover:bg-sky-400 disabled:opacity-50">Send Request</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
