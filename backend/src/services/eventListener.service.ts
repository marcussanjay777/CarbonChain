import { ethers } from 'ethers';
import { supabase } from '../config/supabase';
import { RelayerService } from './relayer.service';

const STATUSES = ['ISSUED', 'ESCROWED', 'TRANSFERRED', 'RETIRED', 'DISPUTED', 'REVOKED'];
const KEYS = ['registry', 'nft', 'ledger', 'escrow'] as const;

/**
 * Polls the four protocol contracts for logs and mirrors them into `chain_events` (an append-only,
 * publicly auditable feed). It also reconciles NFT owner/status, so transactions signed directly from a
 * wallet (MetaMask) are reflected even though they never passed through the API.
 */
export class EventListenerService {
  private static timer: NodeJS.Timeout | null = null;
  private static running = false;
  private static lastBlock = -1;

  public static async start(intervalMs = 2000) {
    if (!RelayerService.isConnected() || this.timer) return;
    const { data } = await supabase.from('chain_sync_state').select('*').eq('key', this.cursorKey()).maybeSingle();
    this.lastBlock = data ? Number(data.last_block) : -1;
    this.timer = setInterval(() => void this.poll(), intervalMs);
    console.log(`[EventListener] Watching protocol contracts from block ${this.lastBlock + 1}`);
  }

  public static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private static cursorKey() {
    return `cursor:${RelayerService.getContractAddress('registry').toLowerCase()}`;
  }

  private static async poll() {
    if (this.running) return;
    this.running = true;
    try {
      const provider = RelayerService.getProvider();
      const head = await provider.getBlockNumber();
      if (head <= this.lastBlock) return;
      const fromBlock = this.lastBlock + 1;
      const toBlock = Math.min(head, fromBlock + 2000);

      for (const key of KEYS) {
        const contract = RelayerService.getContract(key);
        const logs = await provider.getLogs({ address: contract.target as string, fromBlock, toBlock });
        for (const log of logs) {
          let parsed: ethers.LogDescription | null = null;
          try { parsed = contract.interface.parseLog(log); } catch { parsed = null; }
          if (!parsed) continue;
          await this.handle(key, parsed, log);
        }
      }

      this.lastBlock = toBlock;
      await supabase.from('chain_sync_state').upsert({ key: this.cursorKey(), last_block: toBlock }, { onConflict: 'key' });
    } catch (err: any) {
      console.warn('[EventListener] poll error:', err.message);
    } finally {
      this.running = false;
    }
  }

  private static async handle(contractKey: string, ev: ethers.LogDescription, log: ethers.Log) {
    const args: Record<string, string> = {};
    ev.fragment.inputs.forEach((input, i) => {
      const v = ev.args[i];
      args[input.name] = typeof v === 'bigint' ? v.toString() : String(v);
    });

    await supabase.from('chain_events').upsert({
      event_key: `${log.transactionHash}:${log.index}`,
      contract: contractKey,
      event_name: ev.name,
      args,
      block_number: log.blockNumber,
      tx_hash: log.transactionHash,
      created_at: new Date().toISOString()
    }, { onConflict: 'event_key' });

    if (contractKey === 'nft' && ev.name === 'CreditStatusUpdated') {
      const tokenId = Number(ev.args.tokenId);
      const status = STATUSES[Number(ev.args.newStatus)];
      if (status) await supabase.from('carbon_credit_nfts').update({ status }).eq('token_id', tokenId);
    }
    if (contractKey === 'nft' && ev.name === 'Transfer') {
      const to = String(ev.args.to);
      const from = String(ev.args.from);
      if (to !== ethers.ZeroAddress && from !== ethers.ZeroAddress) {
        await supabase.from('carbon_credit_nfts').update({ current_owner: to }).eq('token_id', Number(ev.args.tokenId));
      }
    }
    if (contractKey === 'ledger' && (ev.name === 'VerifierSlashed' || ev.name === 'VerifierStaked' || ev.name === 'ReputationUpdated')) {
      const verifier = String(ev.args.verifier);
      try {
        const p = await RelayerService.getVerifierProfile(verifier);
        await supabase.from('verifier_stakes').update({
          staked_amount: Number(p.stakedEth),
          reputation_score: p.reputationScore,
          total_slashed: Number(p.totalSlashedEth),
          active_in_pool: p.isStaked
        }).eq('verifier_address', verifier);
      } catch { /* ignore */ }
    }
  }
}
