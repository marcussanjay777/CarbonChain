import React, { useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, Gavel, Hash, Link2, ShieldCheck, Slash, XCircle } from 'lucide-react';
import { apiFetch, readApiJson } from '../lib/auth';

const API_URL = (import.meta as any).env?.VITE_API_URL || 'http://localhost:5005';
const short = (h?: string | null, n = 10) => (h ? `${String(h).slice(0, n)}…${String(h).slice(-6)}` : '—');

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(`${API_URL}${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await readApiJson<any>(res);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

interface Props {
  disputes: any[];
  slashingEvents: any[];
  escrows: any[];
  investigations: any[];
  onChanged: () => Promise<void> | void;
}

/** Regulator tooling backed directly by the contracts: dispute rulings, slashing log, Merkle proofs, chain feed. */
export default function OnChainConsole({ disputes, slashingEvents, escrows, investigations, onChanged }: Props) {
  const [chain, setChain] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [reason, setReason] = useState('Investigation confirmed that the satellite and sensor evidence contradict the issued claim.');

  const bundles = useMemo(
    () => investigations.filter((i) => i.bundle).map((i) => ({
      bundleId: i.bundle.bundle_id,
      name: i.project.name,
      root: i.bundle.merkle_root,
      leaves: (i.evidenceItems || []).filter((e: any) => e.source_type !== 'VERIFIER_AUDIT').map((e: any) => ({ sourceType: e.source_type, payloadHash: e.payload_hash }))
    })),
    [investigations]
  );
  const [bundleId, setBundleId] = useState('');
  const [payloadHash, setPayloadHash] = useState('');
  const [proofResult, setProofResult] = useState<any>(null);
  const selectedBundle = bundles.find((b) => b.bundleId === bundleId) || bundles[0];

  const loadChain = async () => {
    try {
      const [c, e] = await Promise.all([api('/api/lifecycle/chain'), api('/api/chain/events?limit=25')]);
      setChain(c);
      setEvents(e.events || []);
    } catch (err: any) {
      setChain({ connected: false, error: err.message });
    }
  };

  useEffect(() => {
    void loadChain();
    const t = setInterval(() => void loadChain(), 5000);
    return () => clearInterval(t);
  }, []);

  const rule = async (disputeId: string, ruling: 'UPHELD' | 'DISMISSED') => {
    if (reason.trim().length < 10) return setError('Write a ruling reason of at least 10 characters.');
    setBusy(disputeId);
    setError('');
    setNotice('');
    try {
      const r = await api(`/api/disputes/${disputeId}/resolve`, { ruling, reason });
      setNotice(
        ruling === 'UPHELD'
          ? `Upheld in one transaction (${short(r.txHash)}): credit REVOKED · buyer refunded ${r.refundEth} ETH · verifiers slashed ${r.slashedEth} ETH.`
          : `Dismissed (${short(r.txHash)}): the credit is tradable again.`
      );
      await onChanged();
      await loadChain();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const verifyProof = async (hash?: string) => {
    const target = selectedBundle?.bundleId;
    const leaf = hash ?? payloadHash;
    if (!target || !leaf) return;
    setBusy('proof');
    setProofResult(null);
    try {
      setProofResult(await api('/api/evidence/verify-proof', { bundleId: target, payloadHash: leaf.trim() }));
    } catch (err: any) {
      setProofResult({ valid: false, reason: err.message });
    } finally {
      setBusy(null);
    }
  };

  const openDisputes = disputes.filter((d) => d.status === 'OPEN');

  return (
    <div className="space-y-4">
      {notice && <div className="rounded-xl border border-emerald-200 bg-white px-4 py-3 text-xs font-medium text-emerald-700">{notice}</div>}
      {error && <div className="rounded-xl border border-red-200 bg-white px-4 py-3 text-xs text-red-600">{error}</div>}

      {/* Chain status */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-900"><Link2 className="h-5 w-5 text-[#00a699]" /> Live chain</h2>
          {chain?.connected ? (
            <span className="rounded-full border border-emerald-300 px-2.5 py-1 font-mono text-[10px] font-bold text-emerald-700">
              chainId {chain.chainId} · block #{chain.blockNumber}
            </span>
          ) : (
            <span className="rounded-full border border-red-300 px-2.5 py-1 text-[10px] font-bold text-red-600">DISCONNECTED {chain?.error ? `· ${chain.error}` : ''}</span>
          )}
        </div>
        {chain?.contracts && (
          <div className="mt-3 grid grid-cols-1 gap-2 font-mono text-[10px] text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries(chain.contracts).map(([k, v]) => <div key={k} className="rounded-lg border border-slate-200 p-2"><span className="font-bold uppercase text-slate-500">{k}</span><div className="truncate">{String(v)}</div></div>)}
          </div>
        )}
        {chain?.wallets?.length > 0 && (
          <div className="mt-3 grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-2 lg:grid-cols-5">
            {chain.wallets.map((w: any) => (
              <div key={w.address} className="rounded-lg border border-slate-200 p-2">
                <div className="font-bold text-slate-800 truncate">{w.name}</div>
                <div className="text-[9px] uppercase text-slate-500">{String(w.role).replace(/_/g, ' ')}</div>
                <div className="font-mono font-bold text-slate-900">{Number(w.balanceEth).toFixed(4)} ETH</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Dispute adjudication */}
        <section className="rounded-2xl border border-red-200 bg-white p-5">
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-900"><Gavel className="h-5 w-5 text-red-500" /> Dispute adjudication ({openDisputes.length} open)</h2>
          <p className="mt-1 text-xs text-slate-500">Upholding executes CarbonRegistry.resolveDispute: revoke the credit, refund the escrowed buyer 100% and slash every approving verifier 50%, all in one transaction.</p>
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className="mt-3 w-full rounded-xl border border-slate-300 p-2.5 text-xs text-slate-800" />
          <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
            {disputes.length === 0 && <p className="text-xs text-slate-500">No disputes filed.</p>}
            {disputes.map((d) => (
              <div key={d.dispute_id} className="rounded-xl border border-slate-200 p-3 text-xs">
                <div className="flex items-center justify-between font-bold">
                  <span className="font-mono">{d.dispute_id} · NFT #{d.token_id}</span>
                  <span className={d.status === 'OPEN' ? 'text-orange-600' : d.status === 'UPHELD' ? 'text-red-600' : 'text-slate-500'}>{d.status}</span>
                </div>
                <p className="mt-1 text-[11px] text-slate-600">"{d.reason}"</p>
                <div className="mt-1 text-[10px] text-slate-500">by {d.initiator_name || short(d.initiator_address)} · tx {short(d.raise_tx_hash)}</div>
                {d.status === 'UPHELD' && <div className="mt-1 text-[10px] font-bold text-red-600">Refunded {d.refund_amount_eth ?? 0} ETH · slashed {d.slashed_amount ?? 0} ETH · tx {short(d.resolve_tx_hash)}</div>}
                {d.status === 'OPEN' && (
                  <div className="mt-2 flex justify-end gap-2">
                    <button onClick={() => rule(d.dispute_id, 'DISMISSED')} disabled={busy !== null} className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-[10px] font-bold">Dismiss</button>
                    <button onClick={() => rule(d.dispute_id, 'UPHELD')} disabled={busy !== null} className="rounded-lg bg-red-600 px-2.5 py-1.5 text-[10px] font-bold text-white">
                      {busy === d.dispute_id ? 'Executing…' : 'Uphold · revoke · refund · slash'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Slashing log */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-900"><Slash className="h-5 w-5 text-red-500" /> Verifier slashing log</h2>
          <p className="mt-1 text-xs text-slate-500">Every slash is read back from VerifierStakingLedger. Slashed ETH goes to the protocol treasury.</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[460px] text-left text-xs">
              <thead className="border-b border-slate-200 text-[9px] uppercase tracking-wider text-slate-500"><tr><th className="pb-2">Verifier</th><th className="pb-2">Slashed</th><th className="pb-2">Credit</th><th className="pb-2">Tx</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {slashingEvents.length === 0 && <tr><td colSpan={4} className="py-4 text-slate-500">No verifier has been slashed.</td></tr>}
                {slashingEvents.map((s) => (
                  <tr key={s.event_key}>
                    <td className="py-2.5"><div className="font-semibold">{s.verifier_name || 'Verifier'}</div><div className="font-mono text-[10px] text-slate-500">{short(s.verifier_address, 8)}</div></td>
                    <td className="py-2.5 font-mono font-bold text-red-600">-{Number(s.amount_eth).toFixed(3)} ETH</td>
                    <td className="py-2.5 font-mono">#{s.token_id}</td>
                    <td className="py-2.5 font-mono text-[10px] text-slate-500">{short(s.tx_hash)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 text-[10px] uppercase font-bold text-slate-500">Escrows</div>
          <div className="mt-1 space-y-1">
            {escrows.slice(0, 6).map((e) => (
              <div key={e.escrow_id} className="flex justify-between font-mono text-[10px] text-slate-600">
                <span>NFT #{e.token_id} · {e.deposit_amount} ETH</span>
                <span className={e.status === 'REFUNDED' ? 'text-red-600 font-bold' : e.status === 'RELEASED' ? 'text-emerald-700 font-bold' : 'text-amber-600 font-bold'}>{e.status}</span>
              </div>
            ))}
            {escrows.length === 0 && <div className="text-xs text-slate-500">No escrow purchases yet.</div>}
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Merkle proof validator */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-900"><Hash className="h-5 w-5 text-[#00a699]" /> Merkle inclusion proof validator</h2>
          <p className="mt-1 text-xs text-slate-500">Proves a telemetry record belongs to the bundle whose SHA-256 root is committed on-chain. The proof is checked off-chain AND by CarbonRegistry.verifyEvidenceInclusion.</p>
          <select value={selectedBundle?.bundleId || ''} onChange={(e) => { setBundleId(e.target.value); setProofResult(null); }} className="mt-3 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs">
            {bundles.map((b) => <option key={b.bundleId} value={b.bundleId}>{b.name} · {short(b.root)}</option>)}
          </select>
          {selectedBundle && (
            <div className="mt-2 space-y-1">
              {selectedBundle.leaves.map((l: any) => (
                <button key={l.payloadHash} onClick={() => { setPayloadHash(l.payloadHash); void verifyProof(l.payloadHash); }}
                  className="flex w-full justify-between rounded-lg border border-slate-200 px-2.5 py-1.5 text-left font-mono text-[10px] hover:bg-slate-50">
                  <span className="font-bold">{l.sourceType}</span><span className="text-slate-500">{short(l.payloadHash, 14)}</span>
                </button>
              ))}
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <input value={payloadHash} onChange={(e) => setPayloadHash(e.target.value)} placeholder="…or paste any 0x payload hash (try tampering with one)"
              className="flex-1 rounded-xl border border-slate-300 px-3 py-2 font-mono text-[10px]" />
            <button onClick={() => verifyProof()} disabled={busy === 'proof' || !payloadHash} className="rounded-xl bg-[#15ed48] px-3 py-2 text-xs font-bold text-slate-950">Verify</button>
          </div>
          {proofResult && (
            <div className={`mt-3 rounded-xl border p-3 text-xs ${proofResult.valid ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-red-300 bg-red-50 text-red-700'}`}>
              <div className="flex items-center gap-1.5 font-bold">
                {proofResult.valid ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                {proofResult.valid ? 'INCLUDED in the committed bundle' : 'NOT part of the committed bundle'}
              </div>
              {proofResult.reason && <p className="mt-1">{proofResult.reason}</p>}
              {proofResult.validOffChain !== undefined && (
                <div className="mt-1 font-mono text-[10px]">
                  off-chain: {String(proofResult.validOffChain)} · on-chain (CarbonRegistry): {String(proofResult.validOnChain)} · proof length {proofResult.proof?.length}
                </div>
              )}
              {proofResult.committedRoot && <div className="mt-1 truncate font-mono text-[10px]">root {proofResult.committedRoot}</div>}
            </div>
          )}
        </section>

        {/* Event feed */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-900"><Activity className="h-5 w-5 text-[#00a699]" /> Contract event feed</h2>
          <p className="mt-1 text-xs text-slate-500">Mirrored by the backend event listener from all four protocol contracts.</p>
          <div className="mt-3 max-h-80 space-y-1 overflow-y-auto">
            {events.length === 0 && <p className="text-xs text-slate-500">No events yet.</p>}
            {events.map((e) => (
              <div key={e.event_key} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-2.5 py-1.5 font-mono text-[10px]">
                <span><ShieldCheck className="mr-1 inline h-3 w-3 text-[#00a699]" /><span className="font-bold text-slate-800">{e.event_name}</span> <span className="text-slate-500">{e.contract}</span></span>
                <span className="text-slate-500">#{e.block_number} · {short(e.tx_hash, 8)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
