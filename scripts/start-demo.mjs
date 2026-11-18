#!/usr/bin/env node
/**
 * One-command local demo: Anvil chain -> contract deploy -> ML engine -> backend relayer -> frontend.
 *
 *   node scripts/start-demo.mjs            fresh chain + fresh local DB (recommended before a demo)
 *   node scripts/start-demo.mjs --keep     reuse a running Anvil and the existing local DB
 *
 * Ctrl+C stops everything that this script started.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const isWin = process.platform === 'win32';
const foundryBin = path.join(os.homedir(), '.foundry', 'bin');
const env = { ...process.env, PATH: `${foundryBin}${path.delimiter}${process.env.PATH}` };
const children = [];

const colors = { anvil: 33, ml: 35, backend: 36, frontend: 32 };
function start(name, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, env, shell: isWin, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${colors[name] || 37}m[${name}]\x1b[0m `;
  const pipe = (stream) => stream.on('data', (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => console.log(tag + l)));
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => console.log(`${tag}exited (${code})`));
  children.push(child);
  return child;
}

async function rpcUp(url = 'http://127.0.0.1:8545') {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitFor(check, label, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const httpOk = (url) => async () => { try { return (await fetch(url)).ok; } catch { return false; } };

function shutdown() {
  for (const c of children) {
    try {
      if (isWin) execFileSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      else c.kill('SIGTERM');
    } catch { /* already gone */ }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
  console.log('\n=== CarbonChain local demo ===\n');

  // 1. chain
  const running = await rpcUp();
  if (running && !keep) {
    console.error('Anvil is already running on :8545. Stop it for a fresh demo, or pass --keep to reuse it.');
    process.exit(1);
  }
  if (!running) {
    start('anvil', isWin ? 'anvil.exe' : 'anvil', ['--host', '127.0.0.1', '--port', '8545', '--chain-id', '31337', '--silent'], root);
    await waitFor(rpcUp, 'Anvil');
  }

  // 2. contracts + fresh DB (a fresh chain invalidates any previously mirrored state)
  if (!running) {
    execFileSync(process.execPath, [path.join(root, 'scripts', 'deploy-local.mjs')], { cwd: root, env, stdio: 'inherit' });
    if (!keep) fs.rmSync(path.join(root, 'backend', '.localdb'), { recursive: true, force: true });
  }

  // 3. ML engine
  start('ml', isWin ? 'python' : 'python3', ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'], path.join(root, 'ml-engine'));
  await waitFor(httpOk('http://127.0.0.1:8000/health'), 'ML engine', 90000);

  // 4. backend
  start('backend', 'npx', ['ts-node', 'src/server.ts'], path.join(root, 'backend'));
  await waitFor(httpOk('http://127.0.0.1:5005/health'), 'backend', 90000);

  // 5. frontend
  start('frontend', 'npx', ['vite', '--port', '5173', '--strictPort'], path.join(root, 'frontend'));
  await waitFor(httpOk('http://127.0.0.1:5173'), 'frontend', 90000);

  console.log('\n\x1b[32m✔ CarbonChain is running\x1b[0m');
  console.log('  App:       http://localhost:5173');
  console.log('  API:       http://localhost:5005/health');
  console.log('  ML engine: http://localhost:8000/health');
  console.log('  Chain:     http://127.0.0.1:8545 (Anvil, chainId 31337)');
  console.log('  Demo logins: proponent.demo / Carbon@2026 · verifier.demo, verifier2.demo / Verify@2026 · buyer.demo / Buyer@2026 · auditor.demo / Audit@2026');
  console.log('  Self-test:   node scripts/e2e-demo.mjs   (in another terminal)\n  Ctrl+C to stop everything.\n');
})().catch((err) => {
  console.error(err.message);
  shutdown();
});
