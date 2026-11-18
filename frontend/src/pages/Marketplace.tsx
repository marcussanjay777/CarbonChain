import React, { useState, useEffect } from 'react';
import {
  BriefcaseBusiness,
  Flame,
  RefreshCw,
  CheckCircle2,
  ShieldCheck,
  Store,
  Wallet,
  Eye,
  Layers,
  BarChart3,
  Scale,
  Coins,
  FileText,
  Printer,
  Sparkles,
  ExternalLink,
  Award,
  AlertCircle,
  Lock,
  Gavel,
  Clock
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { apiFetch, readApiJson } from '../lib/auth';
import { ActivityBarChart, ActivityDonutChart } from '../components/ActivityCharts';
import {
  projectFlowStore,
  LifecycleProject,
  CreditNftRecord,
  LegalComplianceCertificate
} from '../lib/projectFlowStore';
import { LegalComplianceCertificateModal } from '../components/LegalComplianceCertificateModal';

export default function Marketplace({
  walletAddress,
  view = 'marketplace'
}: {
  walletAddress: string | null;
  view?: 'marketplace' | 'portfolio';
}) {
  const [marketItems, setMarketItems] = useState<Array<{ project: LifecycleProject; nft: CreditNftRecord }>>([]);
  const [portfolioItems, setPortfolioItems] = useState<Array<{ project: LifecycleProject; nft: CreditNftRecord }>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const isPortfolio = view === 'portfolio';

  // Direct Purchase Modal State
  const [buyItem, setBuyItem] = useState<{ project: LifecycleProject; nft: CreditNftRecord } | null>(null);
  const [isBuying, setIsBuying] = useState(false);
  const [buyerOrgName, setBuyerOrgName] = useState('Enterprise ESG Holdings LLC');

  // Retirement Modal State
  const [retireItem, setRetireItem] = useState<{ project: LifecycleProject; nft: CreditNftRecord } | null>(null);
  const [retireReason, setRetireReason] = useState('Scope 1 & 2 Corporate Carbon Neutrality FY2026');
  const [retireLegalName, setRetireLegalName] = useState('Enterprise ESG Holdings LLC');
  const [retireJurisdiction, setRetireJurisdiction] = useState('United States / Delaware & Global Scope');
  const [isRetiring, setIsRetiring] = useState(false);

  // Legal Certificate Modal
  const [activeCertificate, setActiveCertificate] = useState<LegalComplianceCertificate | null>(null);

  // Escrow / dispute state
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busyToken, setBusyToken] = useState<number | null>(null);
  const [disputeItem, setDisputeItem] = useState<{ project: LifecycleProject; nft: CreditNftRecord } | null>(null);
  const [disputeReason, setDisputeReason] = useState('Satellite NDVI and ground sensors contradict the claimed sequestration.');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const short = (h?: string) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '');

  const syncData = () => {
    setIsLoading(true);
    const mItems = projectFlowStore.getMarketplaceNfts();
    setMarketItems(mItems);
    const pItems = projectFlowStore.getBuyerPortfolioNfts(walletAddress);
    setPortfolioItems(pItems);
    setIsLoading(false);
  };

  useEffect(() => {
    syncData();
    const unsubscribe = projectFlowStore.subscribe(() => {
      syncData();
    });
    return () => unsubscribe();
  }, [walletAddress, view]);

  // Escrow purchase: payment is locked in EscrowSettlement for the challenge window
  const handleConfirmPurchase = async () => {
    if (!buyItem) return;
    setIsBuying(true);
    setError('');
    try {
      const r = await projectFlowStore.buyCreditNft(buyItem.project.id, buyItem.nft.tokenId);
      setNotice(`Paid ${buyItem.nft.priceEth} ETH into escrow for NFT #${buyItem.nft.tokenId} · tx ${short(r.txHash)}. Settle from your portfolio.`);
      setBuyItem(null);
      confetti({ particleCount: 140, spread: 80, origin: { y: 0.6 }, colors: ['#10B981', '#F59E0B', '#3B82F6', '#6366F1'] });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsBuying(false);
    }
  };

  const handleRelease = async (nft: CreditNftRecord) => {
    if (!nft.escrowId) return;
    setBusyToken(nft.tokenId);
    setError('');
    try {
      const r = await projectFlowStore.releaseEscrow(nft.escrowId);
      setNotice(`Escrow settled: seller paid and NFT #${nft.tokenId} transferred to your wallet · tx ${short(r.txHash)}`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyToken(null);
    }
  };

  const handleDispute = async () => {
    if (!disputeItem) return;
    setBusyToken(disputeItem.nft.tokenId);
    setError('');
    try {
      const r = await projectFlowStore.raiseDispute(disputeItem.nft.tokenId, disputeReason);
      setNotice(`Dispute ${r.dispute.dispute_id} filed. NFT #${disputeItem.nft.tokenId} is frozen on-chain until the regulator rules · tx ${short(r.txHash)}`);
      setDisputeItem(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyToken(null);
    }
  };

  // Permanent retirement: burns the ERC-721 on-chain, then renders the certificate
  const handleConfirmRetirement = async () => {
    if (!retireItem) return;
    setIsRetiring(true);
    setError('');
    try {
      const cert = await projectFlowStore.retireCreditNft(retireItem.project.id, retireItem.nft.tokenId, {
        retirementReason: retireReason,
        beneficiaryLegalName: retireLegalName,
        beneficiaryJurisdiction: retireJurisdiction
      });
      setRetireItem(null);
      confetti({ particleCount: 160, spread: 90, origin: { y: 0.6 }, colors: ['#10B981', '#064E3B', '#34D399', '#6EE7B7'] });
      setActiveCertificate(cert);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsRetiring(false);
    }
  };

  // Open existing legal certificate for already retired NFT
  const handleViewExistingCertificate = (item: { project: LifecycleProject; nft: CreditNftRecord }) => {
    const cert = projectFlowStore.generateLegalDocument(item.project, item.nft);
    setActiveCertificate(cert);
  };

  // Portfolio metrics
  const totalPortfolioTonnage = portfolioItems.reduce((acc, i) => acc + i.nft.co2Tonnage, 0);
  const retiredTonnage = portfolioItems
    .filter((i) => i.nft.status === 'RETIRED')
    .reduce((acc, i) => acc + i.nft.co2Tonnage, 0);
  const activeHoldingTonnage = portfolioItems
    .filter((i) => ['PURCHASED', 'IN_ESCROW'].includes(i.nft.status))
    .reduce((acc, i) => acc + i.nft.co2Tonnage, 0);

  return (
    <div className="space-y-8 text-left w-full max-w-6xl mx-auto">
      
      {/* Top Banner */}
      <div className="portal-page-header flex flex-col md:flex-row items-start md:items-center justify-between gap-4 p-6 rounded-2xl bg-gradient-to-r from-emerald-950/40 via-slate-900/60 to-slate-950 border border-emerald-500/20 backdrop-blur-md">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
              {isPortfolio ? <BriefcaseBusiness className="h-3.5 w-3.5" /> : <Store className="h-3.5 w-3.5" />}
            </span>
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-400">
              {isPortfolio ? 'Corporate ESG Balance Sheet' : 'Peer-to-Peer Environmental Exchange'}
            </span>
          </div>
          <h1 className="text-2xl font-black text-white">
            {isPortfolio ? 'My Carbon Portfolio & Legal Certificates' : 'Verified Carbon Credit Marketplace'}
          </h1>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
            {isPortfolio
              ? 'Manage purchased credits, permanently burn tokens for corporate carbon neutrality, and export official government compliance certificates.'
              : 'Acquire verified carbon credits directly from project developers. 0% intermediary fees — 100% of purchase proceeds settle directly to developer wallets.'}
          </p>
        </div>

        <button
          onClick={syncData}
          className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold flex items-center gap-2 text-white transition-all"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {notice && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-300">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" /> {notice}
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-300">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
        </div>
      )}

      {/* PORTFOLIO METRICS (When in Portfolio view) */}
      {isPortfolio && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="p-4 rounded-xl bg-slate-900/80 border border-emerald-500/20">
            <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">Total Credits Acquired</div>
            <div className="text-2xl font-black font-mono text-white mt-1">{portfolioItems.length} NFTs</div>
            <p className="text-[10px] text-slate-400 mt-1">{totalPortfolioTonnage} tCO2e total</p>
          </div>
          <div className="p-4 rounded-xl bg-slate-900/80 border border-teal-500/20">
            <div className="text-[10px] font-bold uppercase tracking-wider text-teal-400">Permanently Retired</div>
            <div className="text-2xl font-black font-mono text-teal-400 mt-1">{retiredTonnage} tCO2e</div>
            <p className="text-[10px] text-slate-400 mt-1">Offset against Scope 1-3</p>
          </div>
          <div className="p-4 rounded-xl bg-slate-900/80 border border-sky-500/20">
            <div className="text-[10px] font-bold uppercase tracking-wider text-sky-400">Active Tradable Holdings</div>
            <div className="text-2xl font-black font-mono text-white mt-1">{activeHoldingTonnage} tCO2e</div>
            <p className="text-[10px] text-slate-400 mt-1">Held or in escrow</p>
          </div>
          <div className="p-4 rounded-xl bg-slate-900/80 border border-violet-500/20">
            <div className="text-[10px] font-bold uppercase tracking-wider text-violet-400">Compliance Legal Docs</div>
            <div className="text-2xl font-black font-mono text-violet-400 mt-1">
              {portfolioItems.filter((i) => i.nft.status === 'RETIRED').length} Certs
            </div>
            <p className="text-[10px] text-slate-400 mt-1">UNFCCC / CSRD Approved</p>
          </div>
        </div>
      )}

      {/* MARKETPLACE VIEW: Listed Carbon Credit NFTs */}
      {!isPortfolio && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">Live Carbon Credit Listings</h2>
            <span className="text-xs font-mono text-emerald-400">{marketItems.length} Credits Available</span>
          </div>

          {marketItems.length === 0 ? (
            <div className="p-12 rounded-2xl bg-white/5 border border-white/10 text-center space-y-2">
              <Store className="mx-auto h-10 w-10 text-slate-600" />
              <h3 className="text-base font-bold text-white">No credits listed on the marketplace yet</h3>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Once an independent verifier audits a project and mints NFTs, the developer sets the price to list them here.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {marketItems.map(({ project, nft }) => (
                <div
                  key={nft.nftId}
                  className="rounded-2xl border border-white/10 bg-[#0B0F17] p-5 space-y-4 hover:border-emerald-500/40 transition-all shadow-xl flex flex-col justify-between"
                >
                  <div className="space-y-3">
                    {/* Top Tag & Serial */}
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-bold text-emerald-400 bg-emerald-500/10 px-2.5 py-0.5 rounded-full border border-emerald-500/20">
                        Token #{nft.tokenId}
                      </span>
                      <span className="text-[10px] font-semibold px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-300">
                        {project.projectType.replace(/_/g, ' ')}
                      </span>
                    </div>

                    <div>
                      <h3 className="text-base font-bold text-white truncate">{project.name}</h3>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        📍 {project.location.region}, {project.location.country}
                      </div>
                    </div>

                    {/* Prominent CO2 Claim Badge */}
                    <div className="p-3 rounded-xl bg-emerald-950/30 border border-emerald-500/20 flex items-center justify-between">
                      <div>
                        <div className="text-[9px] uppercase font-bold text-emerald-400 tracking-wider">Certified Offset</div>
                        <div className="text-xl font-black text-white font-mono">{nft.co2Tonnage} tCO₂e</div>
                      </div>
                      <div className="text-right">
                        <div className="text-[9px] uppercase font-bold text-slate-400">Vintage</div>
                        <div className="text-xs font-bold text-slate-200">{nft.vintageYear}</div>
                      </div>
                    </div>

                    {/* Verifier PoS Audit Stamp */}
                    <div className="rounded-xl bg-slate-900/80 border border-white/5 p-2.5 space-y-1 text-[10px]">
                      <div className="flex items-center justify-between text-slate-400">
                        <span className="flex items-center gap-1 font-semibold text-amber-300">
                          <ShieldCheck className="w-3.5 h-3.5 text-amber-400" /> Audited by:
                        </span>
                        <span className="text-white font-bold truncate max-w-[130px]">
                          {(project.quorum?.votes || []).some((v) => v.approved)
                            ? `${project.quorum!.approvals} staked verifier(s)`
                            : `AI policy gate`}
                        </span>
                      </div>
                      <div className="flex justify-between text-slate-500 font-mono">
                        <span>AI confidence:</span>
                        <span className={project.aiConfidenceScore >= 85 ? 'text-emerald-400' : 'text-amber-400'}>{project.aiConfidenceScore}% · {project.riskLevel}</span>
                      </div>
                      <div className="flex justify-between text-slate-500 font-mono">
                        <span>Top Merkle:</span>
                        <span className="text-emerald-400 truncate max-w-[120px]">{project.merkleRoot.slice(0, 10)}...</span>
                      </div>
                    </div>

                    {/* 0% Commission Badge */}
                    <div className="flex items-center gap-1 text-[10px] text-teal-300 font-mono">
                      <Lock className="w-3 h-3 text-teal-400" /> Escrow-protected · refund if proven fraudulent
                    </div>
                  </div>

                  {/* Pricing & Buy Button */}
                  <div className="pt-3 border-t border-white/10 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] uppercase font-bold text-slate-400">Price per Credit</div>
                      <div className="text-lg font-black text-white font-mono">{nft.priceEth} ETH</div>
                    </div>

                    <button
                      onClick={() => setBuyItem({ project, nft })}
                      className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-extrabold shadow-lg shadow-emerald-500/25 transition-all flex items-center gap-1.5"
                    >
                      <Coins className="w-3.5 h-3.5" /> Buy Credit
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* PORTFOLIO VIEW: Owned Carbon Credit NFTs */}
      {isPortfolio && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">Your Carbon Credit Holdings & Retirements</h2>
            <span className="text-xs text-slate-400">{portfolioItems.length} credits held</span>
          </div>

          {portfolioItems.length === 0 ? (
            <div className="p-12 rounded-2xl bg-white/5 border border-white/10 text-center space-y-2">
              <BriefcaseBusiness className="mx-auto h-10 w-10 text-slate-600" />
              <h3 className="text-base font-bold text-white">No carbon credits in your portfolio</h3>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Explore the Buyer Marketplace to purchase verified carbon credits directly from project developers.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {portfolioItems.map(({ project, nft }) => {
                const isRetired = nft.status === 'RETIRED';
                const statusStyle: Record<string, string> = {
                  RETIRED: 'bg-teal-500/20 text-teal-300 border-teal-500/30',
                  PURCHASED: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
                  IN_ESCROW: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
                  DISPUTED: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
                  REVOKED: 'bg-red-500/20 text-red-300 border-red-500/30'
                };
                const statusLabel: Record<string, string> = {
                  RETIRED: 'PERMANENTLY RETIRED',
                  PURCHASED: 'OWNED · TRADABLE',
                  IN_ESCROW: 'IN ESCROW',
                  DISPUTED: 'DISPUTED · FROZEN',
                  REVOKED: nft.escrowStatus === 'REFUNDED' ? 'REVOKED · BUYER REFUNDED' : 'REVOKED'
                };
                const releaseMs = nft.releaseAfter ? new Date(nft.releaseAfter).getTime() - now : 0;

                return (
                  <div
                    key={nft.nftId}
                    className="p-5 rounded-2xl border border-white/10 bg-[#0B0F17] flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-white/20 transition-all shadow-lg"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-white bg-slate-800 px-2.5 py-0.5 rounded-full">
                          Token #{nft.tokenId}
                        </span>
                        <span className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full border ${statusStyle[nft.status] || statusStyle.PURCHASED}`}>
                          {statusLabel[nft.status] || nft.status}
                        </span>
                        <span className="text-xs text-slate-400 font-mono">Serial: {nft.serialNumber}</span>
                      </div>

                      <h3 className="text-base font-bold text-white">{project.name}</h3>
                      <div className="text-xs text-slate-400">
                        {project.projectType.replace(/_/g, ' ')} · 📍 {project.location.region}, {project.location.country}
                      </div>

                      {isRetired && nft.retirementReason && (
                        <div className="text-[11px] text-teal-300 italic pt-1">
                          Retirement Purpose: "{nft.retirementReason}"
                        </div>
                      )}
                      <div className="font-mono text-[10px] text-slate-500 space-y-0.5 pt-1">
                        {nft.purchaseTxHash && <div>Escrow deposit tx: <span className="text-sky-300">{short(nft.purchaseTxHash)}</span> · {nft.priceEth} ETH</div>}
                        {nft.burnTxHash && <div>Burn tx: <span className="text-teal-300">{short(nft.burnTxHash)}</span></div>}
                        {nft.status === 'IN_ESCROW' && (
                          <div className="text-amber-300 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {releaseMs > 0 ? `Challenge window: ${Math.ceil(releaseMs / 1000)}s left (accept early or dispute)` : 'Challenge window over: settle now'}
                          </div>
                        )}
                        {nft.disputeReason && <div className="text-orange-300">Dispute: "{nft.disputeReason}" ({nft.disputeStatus})</div>}
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                      <div className="text-left sm:text-right">
                        <div className="text-[10px] uppercase font-bold text-slate-400">Offset Volume</div>
                        <div className="text-xl font-black text-emerald-400 font-mono">
                          {nft.co2Tonnage.toFixed(2)} tCO₂e
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2">
                        {isRetired && (
                          <button
                            onClick={() => handleViewExistingCertificate({ project, nft })}
                            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-teal-500/20 border border-teal-500/40 text-teal-300 hover:bg-teal-500/30 text-xs font-bold transition-all"
                          >
                            <FileText className="w-3.5 h-3.5" /> View Certificate
                          </button>
                        )}
                        {['IN_ESCROW', 'PURCHASED'].includes(nft.status) && (
                          <button
                            onClick={() => setDisputeItem({ project, nft })}
                            disabled={busyToken === nft.tokenId}
                            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-orange-500/40 text-orange-300 hover:bg-orange-500/10 text-xs font-bold disabled:opacity-50"
                          >
                            <Gavel className="w-3.5 h-3.5" /> Raise Dispute
                          </button>
                        )}
                        {nft.status === 'IN_ESCROW' && (
                          <button
                            onClick={() => handleRelease(nft)}
                            disabled={busyToken === nft.tokenId}
                            className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-extrabold disabled:opacity-50"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" /> {busyToken === nft.tokenId ? 'Settling…' : 'Accept & Settle'}
                          </button>
                        )}
                        {nft.status === 'PURCHASED' && (
                          <button
                            onClick={() => setRetireItem({ project, nft })}
                            className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-gradient-to-r from-red-500 to-amber-500 hover:from-red-400 hover:to-amber-400 text-white text-xs font-extrabold shadow-lg shadow-red-500/20 transition-all"
                          >
                            <Flame className="w-3.5 h-3.5" /> Retire (Burn)
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* DIRECT P2P BUY CONFIRMATION MODAL */}
      {buyItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md">
          <div className="w-full max-w-md rounded-3xl border border-emerald-500/30 bg-[#0B0F17] p-6 shadow-2xl space-y-5">
            <div>
              <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-emerald-400">
                On-Chain Escrow Purchase
              </span>
              <h3 className="text-xl font-black text-white mt-1">
                Acquire Credit #{buyItem.nft.tokenId}
              </h3>
              <p className="text-xs text-slate-300 mt-1">
                From <strong>{buyItem.project.developerName}</strong>. Your ETH is locked in the EscrowSettlement contract during the challenge window and refunded 100% if the credit is proven fraudulent.
              </p>
            </div>

            <div className="p-4 rounded-2xl bg-black/40 border border-white/10 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-400">Carbon Offset:</span>
                <span className="font-mono text-emerald-400 font-bold">{buyItem.nft.co2Tonnage} tCO2e</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Purchase Price:</span>
                <span className="font-mono text-white font-bold">{buyItem.nft.priceEth} ETH</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Held in escrow until:</span>
                <span className="font-mono text-amber-300 font-bold">challenge window ends / you accept</span>
              </div>
              <div className="flex justify-between pt-2 border-t border-white/10">
                <span className="text-slate-400">Net to Developer:</span>
                <span className="font-mono text-emerald-400 font-bold">{buyItem.nft.priceEth} ETH (100%)</span>
              </div>
            </div>

            <label className="block text-xs font-semibold text-slate-300">
              Purchasing Corporate Legal Name
              <input
                type="text"
                value={buyerOrgName}
                onChange={(e) => setBuyerOrgName(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs text-white outline-none focus:border-emerald-500"
                placeholder="e.g. Microsoft ESG Holdings LLC"
              />
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setBuyItem(null)}
                className="px-4 py-2 rounded-xl border border-white/10 text-xs font-semibold text-slate-300"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmPurchase}
                disabled={isBuying || !buyerOrgName.trim()}
                className="px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold text-xs shadow-lg shadow-emerald-500/25 flex items-center gap-2 disabled:opacity-50"
              >
                <Coins className="w-4 h-4" />
                {isBuying ? 'Locking Payment…' : `Pay ${buyItem.nft.priceEth} ETH into Escrow`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CLAIM & RETIREMENT MODAL */}
      {retireItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md">
          <div className="w-full max-w-lg rounded-3xl border border-red-500/30 bg-[#0B0F17] p-6 shadow-2xl space-y-5">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-red-400">
                <Flame className="w-4 h-4" /> Permanent On-Chain Retirement & Burn
              </div>
              <h3 className="text-xl font-black text-white mt-1">
                Retire Credit #{retireItem.nft.tokenId} ({retireItem.nft.co2Tonnage} tCO₂e)
              </h3>
              <p className="text-xs text-slate-300 mt-1">
                Permanently burns this token to certify carbon neutrality. An official, tamper-evident <strong>Government Compliance Document</strong> will be generated for submission to tax & regulatory authorities.
              </p>
            </div>

            <div className="space-y-3 text-xs">
              <label className="block text-slate-300 font-semibold">
                Corporate Beneficiary Legal Entity Name
                <input
                  type="text"
                  value={retireLegalName}
                  onChange={(e) => setRetireLegalName(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-white outline-none focus:border-emerald-500"
                />
              </label>

              <label className="block text-slate-300 font-semibold">
                Filing Jurisdiction / Regulatory Scope
                <input
                  type="text"
                  value={retireJurisdiction}
                  onChange={(e) => setRetireJurisdiction(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 text-white outline-none focus:border-emerald-500"
                />
              </label>

              <label className="block text-slate-300 font-semibold">
                Retirement Reason & Scope
                <textarea
                  rows={2}
                  value={retireReason}
                  onChange={(e) => setRetireReason(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 p-3 text-white outline-none focus:border-emerald-500"
                />
              </label>
            </div>

            <div className="p-3.5 rounded-xl bg-red-950/20 border border-red-500/20 text-[11px] text-red-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                <strong>Irreversible Action:</strong> Once burned on-chain, this carbon credit cannot be resold, re-tokenized, or transferred. It permanently extinguishes the claimed GHG emissions.
              </span>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setRetireItem(null)}
                className="px-4 py-2 rounded-xl border border-white/10 text-xs font-semibold text-slate-300"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmRetirement}
                disabled={isRetiring || !retireLegalName.trim()}
                className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-red-500 to-amber-500 hover:from-red-400 hover:to-amber-400 text-white font-extrabold text-xs shadow-lg shadow-red-500/25 flex items-center gap-2 disabled:opacity-50"
              >
                <Flame className="w-4 h-4" />
                {isRetiring ? 'Burning On-Chain…' : 'Burn & Generate Legal Certificate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {disputeItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-md">
          <div className="w-full max-w-md rounded-3xl border border-orange-500/30 bg-[#0B0F17] p-6 shadow-2xl space-y-4 text-xs">
            <div>
              <div className="flex items-center gap-1.5 font-bold uppercase tracking-wider text-orange-400"><Gavel className="w-4 h-4" /> File an on-chain dispute</div>
              <h3 className="text-xl font-black text-white mt-1">Credit #{disputeItem.nft.tokenId} · {disputeItem.project.name}</h3>
              <p className="text-slate-300 mt-1">
                The credit is frozen immediately. If the regulator upholds the dispute, it is revoked, your escrowed payment is refunded 100% and every verifier who approved it loses 50% of their stake.
              </p>
            </div>
            <textarea rows={3} value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-black/40 p-3 text-white outline-none focus:border-orange-500" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setDisputeItem(null)} className="px-4 py-2 rounded-xl border border-white/10 text-slate-300">Cancel</button>
              <button onClick={handleDispute} disabled={disputeReason.trim().length < 10 || busyToken !== null}
                className="px-5 py-2 rounded-xl bg-orange-500 text-slate-950 font-bold hover:bg-orange-400 disabled:opacity-50">
                {busyToken !== null ? 'Filing…' : 'File Dispute On-Chain'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* OFFICIAL LEGAL COMPLIANCE CERTIFICATE MODAL */}
      {activeCertificate && (
        <LegalComplianceCertificateModal
          certificate={activeCertificate}
          onClose={() => setActiveCertificate(null)}
        />
      )}

    </div>
  );
}
