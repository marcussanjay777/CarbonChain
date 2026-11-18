import { Response } from 'express';
import { isAddress } from 'ethers';
import { randomUUID } from 'node:crypto';
import { supabase } from '../config/supabase';
import { ChainError } from '../services/relayer.service';

/**
 * Wallet used for on-chain actions by the signed-in user. The session wallet (bound to the account) wins;
 * a body-supplied address is only used for accounts that have no wallet bound yet.
 */
export function walletFor(res: Response, supplied?: unknown): string | null {
  const sessionWallet = res.locals.auth?.walletAddress as string | null | undefined;
  if (sessionWallet && isAddress(sessionWallet)) return sessionWallet;
  if (typeof supplied === 'string' && isAddress(supplied)) return supplied;
  return null;
}

/** Map a thrown error to an HTTP response. Chain failures are 502 with the decoded revert reason. */
export function fail(res: Response, error: any) {
  if (error instanceof ChainError) {
    return res.status(502).json({ error: error.message, code: 'CHAIN_ERROR' });
  }
  return res.status(500).json({ error: error?.message || 'Unexpected error' });
}

export type NotificationCategory =
  | 'BASELINE' | 'VERIFIER_STAKE' | 'AUDIT_APPROVED' | 'NFT_ISSUED' | 'LISTED' | 'PURCHASED' | 'RETIRED' | 'DISPUTE' | 'SLASHED';

export async function notify(input: {
  title: string;
  message: string;
  category: NotificationCategory;
  recipientRole: 'PROJECT_PROPONENT' | 'INDEPENDENT_VERIFIER' | 'CORPORATE_BUYER' | 'REGULATOR_AUDITOR' | 'ALL';
  projectId?: string | null;
  txHash?: string | null;
}) {
  await supabase.from('protocol_notifications').insert({
    notification_id: `notif-${randomUUID()}`,
    title: input.title,
    message: input.message,
    category: input.category,
    recipient_role: input.recipientRole,
    project_id: input.projectId || null,
    tx_hash: input.txHash || null,
    created_at: new Date().toISOString()
  });
}

export async function getPolicy() {
  const { data } = await supabase.from('regulator_policies').select('settings').eq('policy_name', 'GLOBAL_ISSUANCE_POLICY').maybeSingle();
  return {
    minimumAiConfidence: 85,
    maximumEvidenceDeviation: 15,
    highRiskVerifierQuorum: 2,
    observationWindowDays: 14,
    automaticEscalation: true,
    ...(data?.settings || {})
  };
}
