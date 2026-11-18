import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import ws from 'ws';
import { createLocalClient } from './localdb';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

const hasRealSupabase =
  Boolean(supabaseUrl && supabaseKey) &&
  !supabaseUrl.includes('your-project') &&
  !supabaseKey.includes('your_');

/**
 * LOCAL_DB=true forces the offline file-backed database. It is also used automatically when no real
 * Supabase credentials are configured, so a fresh clone runs end to end with zero external services.
 */
export const usingLocalDb = process.env.LOCAL_DB === 'true' || !hasRealSupabase;

if (usingLocalDb) {
  console.log('[DB] Using offline local database (backend/.localdb/db.json)');
} else {
  console.log('[DB] Using Supabase at', supabaseUrl);
}

export const supabase: SupabaseClient<any, any, any> = usingLocalDb
  ? (createLocalClient() as unknown as SupabaseClient<any, any, any>)
  : createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: ws as any }
    });
