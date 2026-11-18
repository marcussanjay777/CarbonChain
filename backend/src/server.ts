import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import cors from 'cors';
import { supabase, usingLocalDb } from './config/supabase';
import { RelayerService } from './services/relayer.service';
import { EventListenerService } from './services/eventListener.service';
import { authenticate } from './auth/middleware';

import projectsRouter from './routes/projects.routes';
import evidenceRouter from './routes/evidence.routes';
import riskRouter from './routes/risk.routes';
import creditsRouter from './routes/credits.routes';
import verifiersRouter from './routes/verifiers.routes';
import marketplaceRouter from './routes/marketplace.routes';
import satelliteRouter from './routes/satellite.routes';
import authRouter from './routes/auth.routes';
import regulatorRouter from './routes/regulator.routes';
import disputesRouter from './routes/disputes.routes';
import lifecycleRouter from './routes/lifecycle.routes';

const app = express();
const PORT = process.env.PORT || 5005;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth', authRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/evidence', evidenceRouter);
app.use('/api/risk', riskRouter);
app.use('/api/credits', creditsRouter);
app.use('/api/verifiers', verifiersRouter);
app.use('/api/marketplace', marketplaceRouter);
app.use('/api/satellite', satelliteRouter);
app.use('/api/regulator', regulatorRouter);
app.use('/api/disputes', disputesRouter);
app.use('/api/lifecycle', lifecycleRouter);

// Public, append-only feed of every protocol contract event (mirrored by the event listener)
app.get('/api/chain/events', authenticate, async (req: Request, res: Response) => {
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const { data, error } = await supabase.from('chain_events').select('*').order('block_number', { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ events: data || [] });
});

app.get('/health', async (_req: Request, res: Response) => {
  let databaseConnected = false;
  let dbError: string | null = null;
  try {
    const { error } = await supabase.from('projects').select('count', { count: 'exact', head: true });
    databaseConnected = !error;
    dbError = error?.message || null;
  } catch (err: any) {
    dbError = err.message;
  }
  const chain = await RelayerService.status().catch((e: any) => ({ connected: false, error: e.message }));
  return res.status(200).json({
    status: databaseConnected && chain.connected ? 'HEALTHY' : 'DEGRADED',
    service: 'carbonchain-backend',
    timestamp: new Date().toISOString(),
    database: { mode: usingLocalDb ? 'local-file' : 'supabase', connected: databaseConnected, error: dbError },
    supabaseConnected: databaseConnected,
    relayerConnected: chain.connected,
    chain,
    environment: process.env.NODE_ENV || 'development'
  });
});

export async function bootstrap() {
  await RelayerService.initialize();
  await EventListenerService.start();
}

if (process.env.NODE_ENV !== 'test') {
  bootstrap().then(() => {
    app.listen(PORT, () => {
      console.log(`CarbonChain Backend Relayer running on http://localhost:${PORT}`);
    });
  });
}

export default app;
