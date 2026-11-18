/**
 * Minimal file-backed implementation of the subset of the supabase-js query builder that CarbonChain uses.
 * Lets the whole protocol run offline (no Supabase project, no network) for demos and tests.
 * Enabled with LOCAL_DB=true (or automatically when SUPABASE_URL is not configured).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../auth/session';

type Row = Record<string, any>;
type Result = { data: any; error: { message: string; code?: string } | null; count?: number | null };

const now = () => new Date().toISOString();

const TABLE_DEFAULTS: Record<string, () => Row> = {
  projects: () => ({ status: 'ACTIVE', kyc_status: 'VERIFIED', created_at: now() }),
  evidence_bundles: () => ({ status: 'INGESTED', item_count: 0, created_at: now() }),
  evidence_items: () => ({ integrity_status: 'VALID', submitted_at: now() }),
  risk_assessments: () => ({ anomaly_flags: [], auto_mint_eligible: false, verifier_required: false, computed_at: now() }),
  verifier_stakes: () => ({
    active_in_pool: true,
    reputation_score: 100,
    total_verified: 0,
    total_slashed: 0,
    specialization: 'REFORESTATION',
    last_stake_timestamp: now()
  }),
  carbon_credit_nfts: () => ({ status: 'ISSUED', created_at: now() }),
  escrows: () => ({ status: 'LOCKED', created_at: now() }),
  disputes: () => ({ status: 'OPEN', slashed_amount: 0, created_at: now() }),
  app_users: () => ({ is_active: true, created_at: now() }),
  project_objections: () => ({ status: 'OPEN', created_at: now(), updated_at: now() }),
  regulatory_actions: () => ({ created_at: now() }),
  regulator_policies: () => ({ updated_at: now() }),
  regulator_watchlist: () => ({ created_at: now() }),
  slashing_events: () => ({ created_at: now() }),
  chain_events: () => ({ created_at: now() }),
  chain_sync_state: () => ({})
};

const UNIQUE_KEYS: Record<string, string[]> = {
  projects: ['project_id'],
  evidence_bundles: ['bundle_id'],
  risk_assessments: ['bundle_id'],
  verifier_stakes: ['verifier_address'],
  carbon_credit_nfts: ['token_id'],
  escrows: ['escrow_id'],
  disputes: ['dispute_id'],
  app_users: ['login_id'],
  project_objections: ['objection_id'],
  regulatory_actions: ['action_id'],
  regulator_policies: ['policy_name'],
  slashing_events: ['event_key'],
  chain_events: ['event_key'],
  chain_sync_state: ['key']
};

// table -> relation -> [localColumn, foreignColumn]
const RELATIONS: Record<string, Record<string, [string, string]>> = {
  carbon_credit_nfts: { projects: ['project_id', 'project_id'] },
  evidence_bundles: { projects: ['project_id', 'project_id'] },
  escrows: { carbon_credit_nfts: ['token_id', 'token_id'] },
  disputes: { carbon_credit_nfts: ['token_id', 'token_id'] }
};

const looseEq = (a: any, b: any) => (a === null || a === undefined ? b === null || b === undefined : String(a) === String(b));
const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

class Store {
  tables: Record<string, Row[]> = {};
  private file: string;

  constructor(file: string) {
    this.file = file;
    try {
      if (fs.existsSync(file)) this.tables = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.tables = {};
    }
    this.seed();
  }

  rows(table: string): Row[] {
    if (!this.tables[table]) this.tables[table] = [];
    return this.tables[table];
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.tables));
    } catch (err: any) {
      console.warn('[LocalDB] Could not persist database:', err.message);
    }
  }

  reset() {
    this.tables = {};
    this.seed();
  }

  private seed() {
    const users = this.rows('app_users');
    if (users.length === 0) {
      const demo: Array<[string, string, string, string, string, string]> = [
        // loginId, name, organization, role, password, wallet (Anvil dev accounts #1-#5)
        ['proponent.demo', 'Maya Chen', 'Canopy Restoration Labs', 'PROJECT_PROPONENT', 'Carbon@2026', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'],
        ['verifier.demo', 'Elena Rossi', 'Bureau Veritas', 'INDEPENDENT_VERIFIER', 'Verify@2026', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'],
        ['verifier2.demo', 'Dr. Kenji Mori', 'SGS Assurance', 'INDEPENDENT_VERIFIER', 'Verify@2026', '0x90F79bf6EB2c4f870365E785982E1f101E93b906'],
        ['buyer.demo', 'Noah Williams', 'Northstar ESG Fund', 'CORPORATE_BUYER', 'Buyer@2026', '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'],
        ['auditor.demo', 'Amina Okafor', 'Article 6 Supervisory Office', 'REGULATOR_AUDITOR', 'Audit@2026', '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc']
      ];
      for (const [login, name, org, role, pw, wallet] of demo) {
        const { salt, hash } = hashPassword(pw);
        users.push({
          id: randomUUID(),
          login_id: login,
          display_name: name,
          organization: org,
          role,
          wallet_address: wallet,
          password_salt: salt,
          password_hash: hash,
          is_active: true,
          created_at: now()
        });
      }
    }
    const policies = this.rows('regulator_policies');
    if (policies.length === 0) {
      policies.push({
        id: randomUUID(),
        policy_name: 'GLOBAL_ISSUANCE_POLICY',
        settings: {
          minimumAiConfidence: 85,
          maximumEvidenceDeviation: 15,
          highRiskVerifierQuorum: 2,
          observationWindowDays: 0,
          automaticEscalation: true
        },
        updated_at: now()
      });
    }
    this.save();
  }
}

class Query implements PromiseLike<Result> {
  private mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private columns = '*';
  private countMode = false;
  private headOnly = false;
  private payload: Row | Row[] | null = null;
  private onConflict?: string;
  private filters: Array<(row: Row) => boolean> = [];
  private orders: Array<{ col: string; asc: boolean }> = [];
  private limitN: number | null = null;
  private wantsReturn = false;
  private singleMode: 'none' | 'single' | 'maybe' = 'none';

  constructor(private store: Store, private table: string) {}

  select(columns = '*', opts?: { count?: string; head?: boolean }) {
    if (this.mode === 'select') {
      this.columns = columns;
    } else {
      this.wantsReturn = true;
      this.columns = columns;
    }
    if (opts?.count) this.countMode = true;
    if (opts?.head) this.headOnly = true;
    return this;
  }
  insert(values: Row | Row[]) { this.mode = 'insert'; this.payload = values; return this; }
  upsert(values: Row | Row[], opts?: { onConflict?: string }) { this.mode = 'upsert'; this.payload = values; this.onConflict = opts?.onConflict; return this; }
  update(values: Row) { this.mode = 'update'; this.payload = values; return this; }
  delete() { this.mode = 'delete'; return this; }

  eq(col: string, val: any) { this.filters.push((r) => looseEq(r[col], val)); return this; }
  neq(col: string, val: any) { this.filters.push((r) => !looseEq(r[col], val)); return this; }
  in(col: string, vals: any[]) { this.filters.push((r) => vals.some((v) => looseEq(r[col], v))); return this; }
  is(col: string, val: any) { this.filters.push((r) => looseEq(r[col], val)); return this; }
  gt(col: string, val: any) { this.filters.push((r) => r[col] > val); return this; }
  gte(col: string, val: any) { this.filters.push((r) => r[col] >= val); return this; }
  lt(col: string, val: any) { this.filters.push((r) => r[col] < val); return this; }
  lte(col: string, val: any) { this.filters.push((r) => r[col] <= val); return this; }
  ilike(col: string, pattern: string) {
    const re = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
    this.filters.push((r) => r[col] !== null && r[col] !== undefined && re.test(String(r[col])));
    return this;
  }
  or(expr: string) {
    const clauses = expr.split(',').map((part) => {
      const [col, op, ...rest] = part.split('.');
      const val = rest.join('.');
      return (r: Row) => {
        if (op === 'eq') return looseEq(r[col], val);
        if (op === 'neq') return !looseEq(r[col], val);
        if (op === 'ilike') {
          const re = new RegExp('^' + val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i');
          return re.test(String(r[col] ?? ''));
        }
        return false;
      };
    });
    this.filters.push((r) => clauses.some((c) => c(r)));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) { this.orders.push({ col, asc: opts?.ascending !== false }); return this; }
  limit(n: number) { this.limitN = n; return this; }
  maybeSingle() { this.singleMode = 'maybe'; return this; }
  returns() { return this; }
  singleRow() { this.singleMode = 'single'; return this; }

  then<T1 = Result, T2 = never>(
    onfulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    let result: Result;
    try {
      result = this.execute();
    } catch (err: any) {
      result = { data: null, error: { message: err.message } };
    }
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }

  private build(values: Row): Row {
    const base = TABLE_DEFAULTS[this.table] ? TABLE_DEFAULTS[this.table]() : {};
    const row: Row = { ...base, ...clone(values) };
    if (this.table !== 'verifier_stakes' && this.table !== 'chain_sync_state' && !row.id) row.id = randomUUID();
    return row;
  }

  private conflictKey(values: Row): Row | undefined {
    const keys = (this.onConflict ? this.onConflict.split(',').map((k) => k.trim()) : UNIQUE_KEYS[this.table]) || [];
    if (keys.length === 0) return undefined;
    return this.store.rows(this.table).find((r) => keys.every((k) => values[k] !== undefined && looseEq(r[k], values[k])));
  }

  private project(rows: Row[]): Row[] {
    const cols = this.columns.trim();
    if (cols === '*' || cols === '' || cols === 'count') return rows.map(clone);
    const parts: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of cols) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());

    return rows.map((row) => {
      const out: Row = {};
      for (const part of parts) {
        const rel = part.match(/^(\w+)\((.*)\)$/);
        if (rel) {
          const link = RELATIONS[this.table]?.[rel[1]];
          const target = link ? this.store.rows(rel[1]).find((t) => looseEq(t[link[1]], row[link[0]])) : null;
          out[rel[1]] = target ? clone(target) : null;
        } else if (part === '*') {
          Object.assign(out, clone(row));
        } else {
          out[part] = clone(row[part]);
        }
      }
      return out;
    });
  }

  private execute(): Result {
    const rows = this.store.rows(this.table);
    const matches = () => rows.filter((r) => this.filters.every((f) => f(r)));

    if (this.mode === 'insert' || this.mode === 'upsert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const written: Row[] = [];
      for (const values of list) {
        const existing = this.conflictKey(values);
        if (existing) {
          if (this.mode === 'insert') {
            return { data: null, error: { message: `duplicate key value violates unique constraint on ${this.table}`, code: '23505' } };
          }
          Object.assign(existing, clone(values));
          written.push(existing);
        } else {
          const row = this.build(values);
          rows.push(row);
          written.push(row);
        }
      }
      this.store.save();
      return this.finish(this.wantsReturn ? this.project(written) : null);
    }

    if (this.mode === 'update') {
      const targets = matches();
      for (const row of targets) Object.assign(row, clone(this.payload as Row));
      this.store.save();
      return this.finish(this.wantsReturn ? this.project(targets) : null);
    }

    if (this.mode === 'delete') {
      const targets = new Set(matches());
      this.store.tables[this.table] = rows.filter((r) => !targets.has(r));
      this.store.save();
      return this.finish(null);
    }

    // select
    let found = matches();
    const total = found.length;
    for (const { col, asc } of [...this.orders].reverse()) {
      found = [...found].sort((a, b) => {
        const av = a[col], bv = b[col];
        if (av === bv) return 0;
        if (av === undefined || av === null) return 1;
        if (bv === undefined || bv === null) return -1;
        return (av > bv ? 1 : -1) * (asc ? 1 : -1);
      });
    }
    if (this.limitN !== null) found = found.slice(0, this.limitN);
    if (this.headOnly) return { data: null, error: null, count: total };
    return this.finish(this.project(found), total);
  }

  private finish(data: Row[] | null, count?: number): Result {
    if (this.singleMode === 'none') return { data, error: null, count: this.countMode ? count ?? data?.length ?? 0 : null };
    const list = data || [];
    if (list.length === 0) {
      if (this.singleMode === 'maybe') return { data: null, error: null };
      return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
    }
    if (list.length > 1 && this.singleMode === 'single') {
      return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
    }
    return { data: list[0], error: null };
  }
}

// supabase-js exposes single() as a method name; alias it on the prototype without clashing with TS private naming.
(Query.prototype as any).single = function (this: Query) { return this.singleRow(); };

export function createLocalClient(file = path.join(process.cwd(), '.localdb', 'db.json')) {
  const store = new Store(file);
  return {
    from: (table: string) => new Query(store, table) as any,
    __store: store
  };
}
