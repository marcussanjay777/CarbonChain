import { ethers } from 'ethers';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { CryptographicService } from './cryptographic.service';
dotenv.config();

/** Well-known public Anvil/Hardhat dev keys (accounts #0-#9). Only ever used on a local chain. */
const ANVIL_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6'
];

/** Anvil's well-known public test mnemonic. Never holds real funds. */
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const FIRST_SIGNUP_INDEX = 10;
const MAX_SIGNUP_WALLETS = 50;
const DEMO_FUNDING_WEI = ethers.parseEther('100');

export class ChainError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ChainError';
  }
}

interface ContractsConfig {
  chainId?: number;
  rpcUrl?: string;
  contracts: Record<string, { address: string; abi: any[] }>;
}

function loadContractsConfig(): ContractsConfig {
  const candidates = [
    process.env.CONTRACTS_CONFIG,
    path.join(__dirname, '../config/contracts.json'),
    path.join(process.cwd(), 'src/config/contracts.json'),
    path.join(process.cwd(), 'backend/src/config/contracts.json')
  ].filter(Boolean) as string[];
  for (const file of candidates) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  throw new Error('contracts.json not found. Run: node scripts/deploy-local.mjs');
}

/** Turn an ethers/RPC failure into a readable message (custom error names, revert strings). */
export function describeChainError(err: any): string {
  const name = err?.revert?.name;
  if (name) return `Contract reverted: ${name}${err.revert.args?.length ? `(${err.revert.args.map(String).join(', ')})` : ''}`;
  if (err?.reason) return `Contract reverted: ${err.reason}`;
  const msg = String(err?.shortMessage || err?.message || err);
  const m = msg.match(/reverted with reason string '([^']+)'/);
  if (m) return `Contract reverted: ${m[1]}`;
  return msg;
}

export class RelayerService {
  private static provider: ethers.JsonRpcProvider | null = null;
  private static relayer: ethers.NonceManager | null = null;
  private static relayerAddress = '';
  private static chainId = 0;
  private static demoSigners = new Map<string, ethers.NonceManager>();
  private static contracts: Record<string, ethers.Contract> = {};
  private static config: ContractsConfig | null = null;
  private static initError: string | null = null;

  public static async initialize(): Promise<void> {
    try {
      this.config = loadContractsConfig();
      const rpcUrl = process.env.RPC_URL || this.config.rpcUrl || 'http://127.0.0.1:8545';
      this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: false });
      const network = await this.provider.getNetwork();
      this.chainId = Number(network.chainId);

      const key = process.env.RELAYER_PRIVATE_KEY || (this.chainId === 31337 ? ANVIL_KEYS[0] : '');
      if (!key) throw new Error('RELAYER_PRIVATE_KEY is required on non-local networks');
      const wallet = new ethers.Wallet(key, this.provider);
      this.relayerAddress = wallet.address;
      this.relayer = new ethers.NonceManager(wallet);

      const addr = (n: string) => process.env[`${n.toUpperCase()}_ADDRESS`] || this.config!.contracts[n]?.address;
      const names: Record<string, string> = {
        registry: 'CarbonRegistry',
        nft: 'CarbonCreditNFT',
        ledger: 'VerifierStakingLedger',
        escrow: 'EscrowSettlement'
      };
      for (const [key2, contractName] of Object.entries(names)) {
        const address = process.env[`${contractName.toUpperCase()}_ADDRESS`] || addr(contractName);
        const entry = this.config.contracts[contractName];
        if (!address || !entry) throw new Error(`Missing config for ${contractName}`);
        const code = await this.provider.getCode(address);
        if (code === '0x') throw new Error(`No contract at ${address} for ${contractName} - redeploy with scripts/deploy-local.mjs`);
        this.contracts[key2] = new ethers.Contract(address, entry.abi, this.relayer);
      }

      // Demo signers let the backend sign on behalf of the seeded demo wallets. Local chains only.
      const allowDemoSigners = process.env.DEMO_SIGNERS === 'true' || (this.chainId === 31337 && process.env.DEMO_SIGNERS !== 'false');
      this.demoSigners.clear();
      if (allowDemoSigners) {
        for (const k of ANVIL_KEYS) {
          const w = new ethers.Wallet(k, this.provider);
          this.demoSigners.set(w.address.toLowerCase(), new ethers.NonceManager(w));
        }
        // Accounts #10+ of the public Anvil test mnemonic back wallets for users who sign up during a demo.
        const root = ethers.HDNodeWallet.fromPhrase(ANVIL_MNEMONIC, undefined, "m/44'/60'/0'/0");
        for (let i = FIRST_SIGNUP_INDEX; i < FIRST_SIGNUP_INDEX + MAX_SIGNUP_WALLETS; i++) {
          const w = root.deriveChild(i).connect(this.provider);
          this.demoSigners.set(w.address.toLowerCase(), new ethers.NonceManager(w));
        }
      }
      this.initError = null;
      console.log(`[Relayer] Connected to chain ${this.chainId} as ${this.relayerAddress}; demo signers: ${this.demoSigners.size}`);
    } catch (err: any) {
      this.provider = null;
      this.relayer = null;
      this.initError = describeChainError(err);
      console.warn(`[Relayer] NOT CONNECTED: ${this.initError}`);
    }
  }

  public static isConnected(): boolean {
    return this.provider !== null && this.relayer !== null;
  }

  public static async status() {
    if (!this.isConnected()) return { connected: false, error: this.initError };
    const block = await this.provider!.getBlockNumber();
    return {
      connected: true,
      chainId: this.chainId,
      blockNumber: block,
      relayer: this.relayerAddress,
      demoSigners: this.demoSigners.size > 0,
      contracts: Object.fromEntries(Object.entries(this.contracts).map(([k, c]) => [k, (c.target as string)]))
    };
  }

  public static getContractAddress(name: 'registry' | 'nft' | 'ledger' | 'escrow'): string {
    this.requireChain();
    return this.contracts[name].target as string;
  }

  public static getProvider(): ethers.JsonRpcProvider {
    this.requireChain();
    return this.provider!;
  }

  public static getContract(name: 'registry' | 'nft' | 'ledger' | 'escrow'): ethers.Contract {
    this.requireChain();
    return this.contracts[name];
  }

  public static hasSignerFor(address: string): boolean {
    return this.demoSigners.has(address.toLowerCase());
  }

  /** True when the backend can sign for demo wallets (local Anvil chain only). */
  public static isLocalDemo(): boolean {
    return this.isConnected() && this.demoSigners.size > 0;
  }

  /**
   * Wallet for a user who signs up during a local demo: Anvil mnemonic account #(10 + slot),
   * topped up to 100 test ETH. Returns null when no demo wallets are available.
   */
  public static async assignSignupWallet(slot: number): Promise<string | null> {
    if (!this.isLocalDemo() || slot < 0 || slot >= MAX_SIGNUP_WALLETS) return null;
    const root = ethers.HDNodeWallet.fromPhrase(ANVIL_MNEMONIC, undefined, "m/44'/60'/0'/0");
    const address = root.deriveChild(FIRST_SIGNUP_INDEX + slot).address;
    await this.ensureFunded(address);
    return address;
  }

  /** Top a demo wallet back up to 100 test ETH (e.g. after the chain was restarted). */
  public static async ensureFunded(address: string): Promise<void> {
    if (!this.isLocalDemo() || !this.hasSignerFor(address)) return;
    const balance = await this.provider!.getBalance(address);
    if (balance < ethers.parseEther('1')) {
      await this.provider!.send('anvil_setBalance', [address, ethers.toQuantity(DEMO_FUNDING_WEI)]);
    }
  }

  private static requireChain() {
    if (!this.isConnected()) {
      throw new ChainError(`Blockchain node not reachable${this.initError ? ` (${this.initError})` : ''}. Start Anvil and run scripts/deploy-local.mjs.`);
    }
  }

  private static signerContract(name: string, address: string): ethers.Contract {
    this.requireChain();
    const signer = this.demoSigners.get(address.toLowerCase());
    if (!signer) {
      throw new ChainError(`No signing key available for ${address}. Sign this transaction from the wallet (MetaMask) instead.`);
    }
    return this.contracts[name].connect(signer) as ethers.Contract;
  }

  /** NonceManager consumes a nonce even when gas estimation reverts; re-sync so the next tx isn't stuck behind a gap. */
  private static resetNonces() {
    this.relayer?.reset();
    for (const s of this.demoSigners.values()) s.reset();
  }

  private static async send(label: string, fn: () => Promise<ethers.ContractTransactionResponse>): Promise<ethers.ContractTransactionReceipt> {
    try {
      const tx = await fn();
      const receipt = await tx.wait(1, 60_000);
      if (!receipt || receipt.status !== 1) throw new Error('Transaction failed');
      return receipt;
    } catch (err: any) {
      this.resetNonces();
      throw new ChainError(`${label} failed: ${describeChainError(err)}`, err);
    }
  }

  private static findEvent(receipt: ethers.ContractTransactionReceipt, contractKey: string, eventName: string): ethers.LogDescription | null {
    const c = this.contracts[contractKey];
    for (const log of receipt.logs) {
      if (String(log.address).toLowerCase() !== String(c.target).toLowerCase()) continue;
      try {
        const parsed = c.interface.parseLog(log);
        if (parsed?.name === eventName) return parsed;
      } catch { /* not this ABI */ }
    }
    return null;
  }

  public static toId(text: string): string {
    return CryptographicService.toBytes32(text);
  }

  // ------------------------------------------------------------------ registry (relayer)

  public static async registerProjectOnChain(projectId: string, ownerAddress: string, did: string, kycHash: string): Promise<string> {
    this.requireChain();
    const r = await this.send('registerProject', () =>
      this.contracts.registry.registerProjectFor(ownerAddress, this.toId(projectId), did, kycHash, 0)
    );
    return r.hash;
  }

  public static async commitEvidenceBundleOnChain(bundleId: string, projectId: string, merkleRoot: string): Promise<string> {
    this.requireChain();
    const root = merkleRoot.startsWith('0x') && merkleRoot.length === 66 ? merkleRoot : this.toId(merkleRoot);
    const r = await this.send('commitEvidenceBundle', () =>
      this.contracts.registry.commitEvidenceBundle(this.toId(bundleId), this.toId(projectId), root)
    );
    return r.hash;
  }

  public static async recordRiskResultOnChain(bundleId: string, correlationMet: boolean, confidenceMet: boolean, verifierRequired: boolean): Promise<string> {
    this.requireChain();
    const r = await this.send('recordRiskResult', () =>
      this.contracts.registry.recordRiskResult(this.toId(bundleId), correlationMet, confidenceMet, verifierRequired)
    );
    return r.hash;
  }

  public static async castVerifierVoteOnChain(bundleId: string, verifier: string, approved: boolean): Promise<string> {
    this.requireChain();
    const r = await this.send('castVerifierVote', () =>
      this.contracts.registry.castVerifierVote(this.toId(bundleId), verifier, approved)
    );
    return r.hash;
  }

  public static async finalizeVerificationOnChain(bundleId: string, approved: boolean): Promise<string> {
    this.requireChain();
    const r = await this.send('finalizeVerification', () =>
      this.contracts.registry.finalizeVerification(this.toId(bundleId), approved)
    );
    return r.hash;
  }

  public static async mintCreditOnChain(bundleId: string, tonnage: number, vintage: number = new Date().getFullYear()): Promise<{ txHash: string; tokenId: number }> {
    this.requireChain();
    const r = await this.send('mintCredit', () =>
      this.contracts.registry.mintCredit(this.toId(bundleId), Math.max(1, Math.floor(tonnage)), vintage)
    );
    const ev = this.findEvent(r, 'registry', 'CreditIssued');
    if (!ev) throw new ChainError('mintCredit succeeded but no CreditIssued event was emitted');
    return { txHash: r.hash, tokenId: Number(ev.args.tokenId) };
  }

  public static async setProjectStatusOnChain(projectId: string, status: 0 | 1 | 2): Promise<string> {
    this.requireChain();
    const r = await this.send('setProjectStatus', () => this.contracts.registry.setProjectStatus(this.toId(projectId), status));
    return r.hash;
  }

  // --------------------------------------------------------------------- verifiers

  public static async stakeOnChain(verifierAddress: string, amountEth: number): Promise<{ txHash: string; staked: string }> {
    const ledger = this.signerContract('ledger', verifierAddress);
    const r = await this.send('stake', () => ledger.stake({ value: ethers.parseEther(String(amountEth)) }));
    const profile = await this.getVerifierProfile(verifierAddress);
    return { txHash: r.hash, staked: profile.stakedEth };
  }

  public static async getVerifierProfile(address: string) {
    this.requireChain();
    const [staked, reputation, totalVerified, totalSlashed] = await this.contracts.ledger.getVerifierProfile(address);
    const lockedUntil = Number(await this.contracts.ledger.lockedUntil(address));
    return {
      stakedEth: ethers.formatEther(staked),
      reputationScore: Number(reputation),
      totalVerified: Number(totalVerified),
      totalSlashedEth: ethers.formatEther(totalSlashed),
      lockedUntil,
      isStaked: await this.contracts.ledger.isStaked(address)
    };
  }

  // ------------------------------------------------------------------ marketplace

  public static async listCreditOnChain(tokenId: number, priceEth: number): Promise<string> {
    this.requireChain();
    const r = await this.send('listCredit', () => this.contracts.escrow.listCredit(tokenId, ethers.parseEther(String(priceEth))));
    return r.hash;
  }

  public static async buyWithEscrowOnChain(buyerAddress: string, tokenId: number): Promise<{ txHash: string; escrowId: string; releaseAfter: number; priceEth: string }> {
    this.requireChain();
    const price: bigint = await this.contracts.escrow.listingPrice(tokenId);
    if (price === 0n) throw new ChainError('This credit is not listed for sale on-chain');
    const escrow = this.signerContract('escrow', buyerAddress);
    const r = await this.send('buyWithEscrow', () => escrow.buyWithEscrow(tokenId, { value: price }));
    const ev = this.findEvent(r, 'escrow', 'EscrowCreated');
    if (!ev) throw new ChainError('buyWithEscrow succeeded but no EscrowCreated event was emitted');
    return { txHash: r.hash, escrowId: ev.args.escrowId, releaseAfter: Number(ev.args.releaseAfter), priceEth: ethers.formatEther(price) };
  }

  public static async releaseEscrowOnChain(escrowId: string): Promise<string> {
    this.requireChain();
    const r = await this.send('releaseEscrow', () => this.contracts.escrow.releaseEscrow(escrowId));
    return r.hash;
  }

  public static async retireCreditOnChain(ownerAddress: string, tokenId: number, reason: string): Promise<string> {
    const nft = this.signerContract('nft', ownerAddress);
    const r = await this.send('retireCredit', () => nft.retireCredit(tokenId, reason));
    return r.hash;
  }

  // ---------------------------------------------------------------------- disputes

  public static async disputeCreditOnChain(tokenId: number, initiator: string, reason: string): Promise<string> {
    this.requireChain();
    const r = await this.send('disputeCredit', () => this.contracts.registry.disputeCreditBy(tokenId, initiator, reason));
    return r.hash;
  }

  public static async resolveDisputeOnChain(tokenId: number, uphold: boolean, details: string) {
    this.requireChain();
    const r = await this.send('resolveDispute', () => this.contracts.registry.resolveDispute(tokenId, uphold, details));
    const ev = this.findEvent(r, 'registry', 'DisputeResolved');
    return {
      txHash: r.hash,
      upheld: uphold,
      refundEth: ev ? ethers.formatEther(ev.args.buyerRefund) : '0',
      slashedEth: ev ? ethers.formatEther(ev.args.totalSlashed) : '0'
    };
  }

  // ------------------------------------------------------------------------ reads

  public static async verifyInclusionOnChain(bundleId: string, payloadHash: string, proof: string[]): Promise<boolean> {
    this.requireChain();
    return Boolean(await this.contracts.registry.verifyEvidenceInclusion(this.toId(bundleId), payloadHash, proof));
  }

  public static async getCreditOnChain(tokenId: number) {
    this.requireChain();
    const statuses = ['ISSUED', 'ESCROWED', 'TRANSFERRED', 'RETIRED', 'DISPUTED', 'REVOKED'];
    const d = await this.contracts.nft.getCreditDetails(tokenId);
    let owner: string | null = null;
    try { owner = await this.contracts.nft.ownerOf(tokenId); } catch { owner = null; }
    return { owner, tonnage: Number(d.tonnage), vintage: Number(d.vintage), status: statuses[Number(d.status)], merkleRoot: d.merkleRoot as string };
  }

  public static async getBalanceEth(address: string): Promise<string> {
    this.requireChain();
    return ethers.formatEther(await this.provider!.getBalance(address));
  }
}
