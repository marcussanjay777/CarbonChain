# CarbonChain — Demo Runbook

Everything runs locally: a real Ethereum chain (Anvil), the 4 Solidity contracts, the Python ML engine,
the Express relayer and the React app. No Supabase or internet connection is required.

## 0. One-time setup

| Tool | Check | Install |
|---|---|---|
| Node.js 18+ | `node -v` | nodejs.org |
| Python 3.10+ with ML deps | `python -c "import sklearn, fastapi"` | `pip install -r ml-engine/requirements.txt` |
| Foundry (forge/anvil) | `~/.foundry/bin/forge --version` | Windows: unzip `foundry_v1.9.0_win32_amd64.zip` from github.com/foundry-rs/foundry/releases into `~/.foundry/bin`. macOS/Linux: `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |

```bash
git submodule update --init --recursive     # OpenZeppelin
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
```

## 1. Start everything (one command)

```bash
node scripts/start-demo.mjs
```

This starts a fresh chain, deploys the contracts, wipes the local DB, and starts the ML engine (:8000),
backend (:5005) and frontend (:5173). Open **http://localhost:5173**.

Before you present, check it in a second terminal:

```bash
node scripts/e2e-demo.mjs        # 20 checks across both demo tracks; must end with ALL CHECKS PASSED
```

The self-test leaves data behind. **Restart `start-demo.mjs`** after it so the live demo starts clean.

## 2. Demo logins (one click each on the login page)

| Role | Login | Password | Wallet (Anvil) |
|---|---|---|---|
| Project proponent | proponent.demo | Carbon@2026 | 0x7099…79C8 |
| Verifier #1 | verifier.demo | Verify@2026 | 0x3C44…93BC |
| Verifier #2 | verifier2.demo | Verify@2026 | 0x90F7…b906 |
| Corporate buyer | buyer.demo | Buyer@2026 | 0x15d3…6A65 |
| Regulator | auditor.demo | Audit@2026 | 0x9965…A4dc |

Each account is bound to a funded Anvil wallet. The backend signs that wallet's transactions (local chain only).

## 3. Track A — honest project (≈90 s)

1. **Proponent** → Project Studio → **Load clean scenario** → Submit.
   - Show the success panel: DID, Merkle root, and 4 real tx hashes (register, commit evidence, record risk, mint).
   - AI confidence ≈90% → **auto-minted NFT** (policy gate, no human needed).
2. My Registry → **Set price & list** (e.g. 0.5 ETH) → listed in `EscrowSettlement`.
3. **Buyer** → Marketplace → Buy → ETH is locked in escrow (120 s challenge window).
4. My Portfolio → **Accept & Settle** (seller paid, NFT transferred) → **Retire (Burn)** → certificate.

## 4. Track B — fraud caught and punished (≈90 s)

1. **Proponent** → **Load fraud scenario** → Submit → AI ≈38%, HIGH risk → *escalated to verifiers*, nothing minted.
2. **Verifier #1** → Stake 1 ETH → open the bundle: side-by-side IoT vs satellite, anomaly flags → tick
   the checklist → **Approve** (the "compromised" verifier). Quorum shows 1/2.
3. **Verifier #2** → Stake 1 ETH → Approve → quorum 2/2 → **NFT minted on-chain**.
4. **Proponent** lists it (e.g. 2 ETH). **Buyer** buys → funds in escrow → **Raise Dispute**.
   The credit is frozen, and "Accept & Settle" now reverts on-chain.
5. **Regulator** → Audit Explorer → *Dispute adjudication* → **Uphold**. One transaction:
   - credit **REVOKED** forever,
   - buyer **refunded 2 ETH** (see buyer balance in *Live chain*),
   - both verifiers **slashed 50%** (*Verifier slashing log*, reputation 100 → 70).
6. Same page → **Merkle inclusion proof validator**: click a leaf → valid off-chain and on-chain. Paste a
   modified hash → rejected.

## 5. Talking points (crypto)

- **SHA-256 Merkle tree** with domain separation (`0x00` leaf / `0x01` node), sorted pairs, canonical leaf order.
  The root lives in `CarbonRegistry`. `verifyEvidenceInclusion()` re-computes it on-chain with the SHA-256 precompile.
- **Canonical JSON hashing**: keys are sorted recursively, so editing any nested field changes the hash.
- **DIDs** (`did:carbonyx:<wallet>`), and the KYC attestation is stored as a hash only.
- **Crypto-economic security**: stake ≥ 0.1 ETH to vote. Votes lock the stake (so a verifier can't approve
  fraud and then withdraw). An upheld dispute slashes 50% to the treasury.
- **Escrow** with a challenge window, and an automatic refund when a dispute is upheld.
- **Contract test suite**: `cd contracts && forge test` → 30 tests.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Anvil is already running` | Close the old terminal, or `taskkill /IM anvil.exe /F`, then rerun |
| Login says it cannot reach the API | The backend isn't running. Check the `[backend]` lines in the launcher output |
| `CHAIN_ERROR … No contract at …` | The chain was restarted without redeploying. Rerun `start-demo.mjs` |
| Verifier can't vote | Stake ≥ 0.1 ETH first. A verifier also can't vote on their own project or vote twice |
