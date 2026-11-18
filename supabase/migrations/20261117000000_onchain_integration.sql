-- On-chain integration: mirror tx hashes, escrow ids, listings, disputes, slashing and contract events.
-- Only needed when running against Supabase. The offline local DB (LOCAL_DB=true) needs no migration.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS register_tx_hash TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS baseline_closed_at TIMESTAMPTZ;

ALTER TABLE risk_assessments ADD COLUMN IF NOT EXISTS on_chain_tx_hash TEXT;

ALTER TABLE verifier_stakes ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE verifier_stakes ADD COLUMN IF NOT EXISTS organization TEXT;
ALTER TABLE verifier_stakes ADD COLUMN IF NOT EXISTS stake_tx_hash TEXT;
ALTER TABLE verifier_stakes ALTER COLUMN total_slashed TYPE NUMERIC;

ALTER TABLE carbon_credit_nfts ADD COLUMN IF NOT EXISTS mint_tx_hash TEXT;
ALTER TABLE carbon_credit_nfts ADD COLUMN IF NOT EXISTS listing_price_eth NUMERIC;
ALTER TABLE carbon_credit_nfts ADD COLUMN IF NOT EXISTS list_tx_hash TEXT;
ALTER TABLE carbon_credit_nfts ADD COLUMN IF NOT EXISTS escrow_id TEXT;
ALTER TABLE carbon_credit_nfts ADD COLUMN IF NOT EXISTS burn_tx_hash TEXT;
ALTER TABLE carbon_credit_nfts ADD COLUMN IF NOT EXISTS certificate_hash TEXT;
ALTER TABLE carbon_credit_nfts ADD COLUMN IF NOT EXISTS beneficiary_name TEXT;

ALTER TABLE escrows ADD COLUMN IF NOT EXISTS buy_tx_hash TEXT;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS release_tx_hash TEXT;
ALTER TABLE escrows ADD COLUMN IF NOT EXISTS refund_tx_hash TEXT;

ALTER TABLE disputes ADD COLUMN IF NOT EXISTS initiator_name TEXT;
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS pre_dispute_status TEXT;
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS raise_tx_hash TEXT;
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS resolve_tx_hash TEXT;
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS refund_amount_eth NUMERIC DEFAULT 0;
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- Seeded demo users get bound Anvil dev wallets (public test keys; local chain only).
UPDATE app_users SET wallet_address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' WHERE login_id = 'proponent.demo' AND wallet_address IS NULL;
UPDATE app_users SET wallet_address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' WHERE login_id = 'verifier.demo' AND wallet_address IS NULL;
UPDATE app_users SET wallet_address = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' WHERE login_id = 'buyer.demo' AND wallet_address IS NULL;
UPDATE app_users SET wallet_address = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc' WHERE login_id = 'auditor.demo' AND wallet_address IS NULL;

CREATE TABLE IF NOT EXISTS slashing_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_key TEXT UNIQUE NOT NULL,
    verifier_address TEXT NOT NULL,
    verifier_name TEXT,
    amount_eth NUMERIC NOT NULL,
    token_id BIGINT,
    dispute_id TEXT,
    reason TEXT,
    tx_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chain_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_key TEXT UNIQUE NOT NULL,
    contract TEXT NOT NULL,
    event_name TEXT NOT NULL,
    args JSONB,
    block_number BIGINT,
    tx_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chain_sync_state (
    key TEXT PRIMARY KEY,
    last_block BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS protocol_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_id TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    category TEXT NOT NULL,
    recipient_role TEXT NOT NULL,
    project_id TEXT,
    tx_hash TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
