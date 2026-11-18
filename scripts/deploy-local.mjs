#!/usr/bin/env node
/**
 * Deploys the 4 protocol contracts with Foundry and syncs addresses + ABIs into
 *   backend/src/config/contracts.json  and  frontend/src/lib/contracts.json
 *
 * Usage:  node scripts/deploy-local.mjs [rpcUrl]
 * Env:    PRIVATE_KEY, RPC_URL, CHAIN_ID, CHALLENGE_WINDOW_SECONDS, STAKE_LOCK_SECONDS, TREASURY_ADDRESS
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractsDir = path.join(root, 'contracts');
const rpcUrl = process.argv[2] || process.env.RPC_URL || 'http://127.0.0.1:8545';
const names = ['CarbonCreditNFT', 'VerifierStakingLedger', 'EscrowSettlement', 'CarbonRegistry'];

const foundryBin = path.join(os.homedir(), '.foundry', 'bin');
const env = { ...process.env, PATH: `${foundryBin}${path.delimiter}${process.env.PATH}` };
const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n);

const rpc = async (method, params = []) => {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return (await res.json()).result;
};

let chainId;
try {
  chainId = parseInt(await rpc('eth_chainId'), 16);
} catch {
  console.error(`No JSON-RPC node reachable at ${rpcUrl}. Start one first:  anvil`);
  process.exit(1);
}

console.log(`> Deploying to ${rpcUrl} (chainId ${chainId})`);
const args = ['script', 'script/Deploy.s.sol', '--rpc-url', rpcUrl, '--broadcast', '--slow'];
const out = execFileSync(path.join(foundryBin, exe('forge')), args, { cwd: contractsDir, env, encoding: 'utf8' });
process.stdout.write(out.split('\n').filter((l) => /deployed|Treasury|window|lock|Deployer|CarbonC|Verifier|Escrow/.test(l)).join('\n') + '\n');

const runFile = path.join(contractsDir, 'broadcast', 'Deploy.s.sol', String(chainId), 'run-latest.json');
const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
// Deploy.s.sol deploys in this exact order; forge leaves contractName blank for constructors with string args.
const creates = run.transactions.filter((tx) => tx.transactionType === 'CREATE');
if (creates.length < names.length) throw new Error('Unexpected deployment transactions in broadcast file');
const addresses = {};
names.forEach((name, i) => { addresses[name] = creates[i].contractAddress; });

const contracts = {};
for (const name of names) {
  if (!addresses[name]) throw new Error(`Missing deployed address for ${name}`);
  const artifact = JSON.parse(fs.readFileSync(path.join(contractsDir, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
  contracts[name] = { address: addresses[name], abi: artifact.abi };
}

const config = JSON.stringify({ chainId, rpcUrl, deployedAt: new Date().toISOString(), contracts }, null, 2);
for (const target of ['backend/src/config/contracts.json', 'frontend/src/lib/contracts.json']) {
  fs.writeFileSync(path.join(root, target), config);
  console.log(`> wrote ${target}`);
}
console.log('> Deployed:', Object.fromEntries(Object.entries(addresses)));
