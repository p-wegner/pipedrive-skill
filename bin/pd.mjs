#!/usr/bin/env node
// pd — zero-dependency Pipedrive CLI (Node >=18, uses built-in fetch).
// Auth:   PIPEDRIVE_API_TOKEN + PIPEDRIVE_DOMAIN  (or --token / --domain).
// Deletes: gated behind --yes AND (PIPEDRIVE_ALLOW_DELETE=1 or --allow-delete).
// See `pd help` for the full command surface.

// Reserved global flags, classified so values are typed predictably.
const BOOL_FLAGS = new Set(['all', 'raw', 'compact', 'yes', 'allow-delete', 'dry-run', 'exact-match', 'help', 'h', 'full', 'all-owners', 'mine']);
const NUM_FLAGS = new Set(['limit', 'start', 'days']);
const STR_FLAGS = new Set(['token', 'domain', 'cursor', 'sort', 'sort-by', 'sort-direction', 'output', 'item-types', 'fields', 'body-json']);
const REPEAT_FLAGS = new Set(['field', 'query', 'str', 'num']); // k=v, repeatable
const RESERVED = new Set([...BOOL_FLAGS, ...NUM_FLAGS, ...STR_FLAGS, ...REPEAT_FLAGS]);

// Fields whose values are genuinely numeric — coerced from the generic --kebab path.
// Everything else (names, titles, phones, postal codes, content, custom-field text)
// stays a string, to avoid silently corrupting CRM data.
const NUMERIC_KEY = (k) =>
  /(^|_)id$/.test(k) || /_ids$/.test(k) ||
  ['value', 'amount', 'price', 'item_price', 'sum', 'quantity', 'count', 'duration',
   'tax', 'discount', 'probability', 'position', 'order_nr', 'no_of_installments',
   'monthly_payments', 'stage_id', 'pipeline_id'].includes(k);

const SAFE_INT = (v) => /^-?(0|[1-9]\d*)$/.test(v) && Number.isSafeInteger(Number(v)); // no leading zeros, in-range
const SAFE_FLOAT = (v) => /^-?(0|[1-9]\d*)\.\d+$/.test(v);

// Typed coercion for explicit --field values (user opted in to smart typing).
function smartCoerce(v) {
  if (v === undefined || v === '') return v === '' ? '' : true;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^[[{]/.test(v)) { try { return JSON.parse(v); } catch { /* keep string */ } }
  if (SAFE_INT(v) || SAFE_FLOAT(v)) return Number(v);
  return v;
}
// Conservative coercion for the generic --kebab path: numbers only for numeric-named fields.
function genericCoerce(key, v) {
  if (v === undefined) return true;                       // bare boolean flag
  if (NUMERIC_KEY(key) && (SAFE_INT(v) || SAFE_FLOAT(v))) return Number(v);
  return v;                                               // strings stay strings
}
const splitKV = (val) => { const s = String(val); const i = s.indexOf('='); return i === -1 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]; };

// ---------- arg parsing ----------
function parseArgs(argv) {
  const positional = [];
  const flags = {};        // known/global flags
  const extras = {};       // unknown --kebab flags -> snake_case params
  const fields = {};       // repeatable --field/--str/--num k=v (custom-field hashes etc)
  const query = {};        // repeatable --query k=v

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { for (let j = i + 1; j < argv.length; j++) positional.push(argv[j]); break; }
    if (!a.startsWith('--')) { positional.push(a); continue; }
    let key = a.slice(2), val;
    const eq = key.indexOf('=');
    if (eq !== -1) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    else if (!BOOL_FLAGS.has(key)) {
      // boolean flags never consume the next token (protects following positionals)
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { val = next; i++; }
    }

    if (key === 'field') { const [k, v] = splitKV(val); fields[k] = smartCoerce(v); continue; }
    if (key === 'str')   { const [k, v] = splitKV(val); fields[k] = v; continue; }        // force string
    if (key === 'num')   { const [k, v] = splitKV(val); fields[k] = Number(v); continue; } // force number
    if (key === 'query') { const [k, v] = splitKV(val); query[k] = smartCoerce(v); continue; }

    if (RESERVED.has(key)) {
      if (BOOL_FLAGS.has(key)) flags[key] = val === undefined ? true : val !== 'false';
      else if (NUM_FLAGS.has(key)) flags[key] = (val === undefined || val === '') ? undefined : Number(val);
      else flags[key] = val;   // STR flags: verbatim (e.g. --body-json stays a raw JSON string)
      continue;
    }
    // unknown flag -> snake_case param (body field for writes, query param for reads)
    extras[key.replace(/-/g, '_')] = genericCoerce(key.replace(/-/g, '_'), val);
  }
  return { positional, flags, extras, fields, query };
}

// ---------- config ----------
// Non-fatal: resolves everything it can and reports what's missing (used by `pd status`).
function resolveConfig(flags) {
  const token = flags.token || process.env.PIPEDRIVE_API_TOKEN || null;
  const rawDomain = flags.domain || process.env.PIPEDRIVE_DOMAIN || null;
  // explicit base url override (proxies, self-host, testing): honored verbatim
  const baseOverride = process.env.PIPEDRIVE_BASE_URL ||
    (typeof rawDomain === 'string' && /^https?:\/\//.test(rawDomain) ? rawDomain : null);
  let base = null, domain = null;
  if (baseOverride) base = baseOverride.replace(/\/+$/, '');
  else if (rawDomain) {
    domain = String(rawDomain).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain.includes('.')) domain = `${domain}.pipedrive.com`;
    base = `https://${domain}`;
  }
  const allowDelete = flags['allow-delete'] === true || process.env.PIPEDRIVE_ALLOW_DELETE === '1';
  const dryRun = flags['dry-run'] === true || process.env.PD_DRY_RUN === '1';
  return { token, domain, base, baseOverride, allowDelete, dryRun };
}
function config(flags) {
  const c = resolveConfig(flags);
  if (!c.token) fail('Missing API token. Set PIPEDRIVE_API_TOKEN or pass --token.');
  if (!c.base) fail('Missing domain. Set PIPEDRIVE_DOMAIN (your company subdomain) or pass --domain.');
  return c;
}

// ---------- http ----------
async function request(cfg, method, path, { query, body, rawResp = false } = {}) {
  const url = new URL(cfg.base + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const headers = { 'x-api-token': cfg.token, accept: 'application/json' };
  const init = { method, headers };
  if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  if (cfg.dryRun) {
    const preview = { method, url: url.toString().replace(cfg.token, '***'), body };
    process.stderr.write('[dry-run] ' + JSON.stringify(preview) + '\n');
    // surface the preview on STDOUT too, so an agent reading stdout sees it wasn't a live call
    return { success: true, dry_run: true, data: { dry_run: true, would_send: preview }, additional_data: {} };
  }
  const resp = await fetch(url, init);
  if (rawResp) return resp;
  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { _text: text }; }
  if (!resp.ok || json.success === false) {
    const msg = json.error || json.error_info || json._text || resp.statusText;
    fail(`Pipedrive API ${resp.status}: ${msg}`);
  }
  return json;
}

// ---------- pagination ----------
async function paginate(cfg, ver, path, { query = {}, flags }) {
  const limit = flags.limit ?? 100;
  if (flags.sort && ver === 2) query.sort_by = flags['sort-by'] || flags.sort;
  const collect = [];
  if (ver === 2) {
    let cursor = flags.cursor;
    for (;;) {
      const res = await request(cfg, 'GET', path, { query: { ...query, limit, cursor } });
      const data = res.data || [];
      collect.push(...(Array.isArray(data) ? data : [data]));
      cursor = res.additional_data && res.additional_data.next_cursor;
      if (!flags.all || !cursor) return { data: flags.all ? collect : (res.data || []), envelope: res };
    }
  } else {
    let start = flags.start ?? 0;
    for (;;) {
      const res = await request(cfg, 'GET', path, { query: { ...query, start, limit } });
      const data = res.data || [];
      collect.push(...(Array.isArray(data) ? data : [data]));
      const pag = res.additional_data && res.additional_data.pagination;
      const next = pag && pag.next_start;
      // stop if not paginating, no more items, or next_start is missing/non-advancing (guards infinite loop)
      if (!flags.all || !pag || !pag.more_items_in_collection || typeof next !== 'number' || next <= start) {
        return { data: flags.all ? collect : (res.data || []), envelope: res };
      }
      start = next;
    }
  }
}

// ---------- output ----------
// `value` is either a raw API envelope {success,data,additional_data} or a paginate
// wrapper {data, envelope}. --raw prints the real envelope; otherwise just .data.
function out(value, flags) {
  const envelope = value && value.envelope ? value.envelope : value;
  const data = value && 'data' in value ? value.data : value;
  const payload = flags.raw ? envelope : data;
  process.stdout.write(flags.compact ? JSON.stringify(payload) : JSON.stringify(payload, null, 2));
  process.stdout.write('\n');
  return true;
}
function fail(msg) { process.stderr.write(`error: ${msg}\n`); process.exit(1); }

// ---------- entity registry ----------
// v = API version for CRUD; searchV = version for /search; searchV null => no search.
const ENTITIES = {
  deals:         { v: 2, path: 'deals', searchV: 2, aliases: ['deal'] },
  persons:       { v: 2, path: 'persons', searchV: 2, aliases: ['person', 'people', 'contacts'] },
  organizations: { v: 2, path: 'organizations', searchV: 2, aliases: ['org', 'orgs', 'organization'] },
  activities:    { v: 2, path: 'activities', searchV: null, aliases: ['activity'] },
  products:      { v: 2, path: 'products', searchV: 2, aliases: ['product'] },
  pipelines:     { v: 2, path: 'pipelines', searchV: null, aliases: [] }, // 'pipeline' is the shortcut view
  stages:        { v: 2, path: 'stages', searchV: null, aliases: ['stage'] },
  notes:         { v: 1, path: 'notes', searchV: null, aliases: ['note'] },
  users:         { v: 1, path: 'users', searchV: null, aliases: ['user'] },
  files:         { v: 1, path: 'files', searchV: null, aliases: ['file'] },
  // leads: CRUD v1, search/convert v2 (handled with searchV override below)
  leads:         { v: 1, path: 'leads', searchV: 2, aliases: ['lead'] },
};
function resolveEntity(name) {
  if (ENTITIES[name]) return { key: name, ...ENTITIES[name] };
  for (const [k, e] of Object.entries(ENTITIES)) if (e.aliases.includes(name)) return { key: k, ...e };
  return null;
}
const p = (ver, ...seg) => `/api/v${ver}/${seg.filter(Boolean).join('/')}`;

// ---------- generic entity actions ----------
async function entityAction(cfg, ent, action, args) {
  const { positional, flags, extras, fields, query } = args;
  const mergeWrite = () => ({ ...extras, ...fields });
  const mergeQuery = () => ({ ...query, ...extras });
  switch (action) {
    case 'list': {
      const res = await paginate(cfg, ent.v, p(ent.v, ent.path), { query: mergeQuery(), flags });
      return out(res, flags);
    }
    case 'get': {
      const id = need(positional[0], `${ent.key} get <id>`);
      return out(await request(cfg, 'GET', p(ent.v, ent.path, id), { query: mergeQuery() }), flags);
    }
    case 'search': {
      if (!ent.searchV) fail(`${ent.key} does not support search`);
      const term = need(positional[0], `${ent.key} search <term>`);
      const q = { term, ...mergeQuery() };
      if (flags['exact-match']) q.exact_match = true;
      if (flags.fields) q.fields = flags.fields;
      if (flags.limit) q.limit = flags.limit;
      return out(await request(cfg, 'GET', p(ent.searchV, ent.path, 'search'), { query: q }), flags);
    }
    case 'add': case 'create': {
      const body = flags['body-json'] ? parseBodyJson(flags['body-json']) : {};
      Object.assign(body, mergeWrite());
      return out(await request(cfg, 'POST', p(ent.v, ent.path), { body }), flags);
    }
    case 'update': {
      const id = need(positional[0], `${ent.key} update <id> --field ...`);
      const body = flags['body-json'] ? parseBodyJson(flags['body-json']) : {};
      Object.assign(body, mergeWrite());
      return out(await request(cfg, 'PATCH', p(ent.v, ent.path, id), { body }), flags);
    }
    case 'delete': case 'remove': {
      const id = need(positional[0], `${ent.key} delete <id>`);
      if (!flags.yes) fail('Destructive op requires --yes.');
      if (!cfg.allowDelete) fail('Deletes disabled. Set PIPEDRIVE_ALLOW_DELETE=1 or pass --allow-delete.');
      return out(await request(cfg, 'DELETE', p(ent.v, ent.path, id)), flags);
    }
    default:
      fail(`Unknown action '${action}' for ${ent.key}. Try list|get|search|add|update|delete.`);
  }
}

function need(v, usage) { if (v === undefined) fail(`Missing argument. Usage: pd ${usage}`); return v; }
function parseBodyJson(s) { try { return JSON.parse(s); } catch (e) { fail(`--body-json is not valid JSON: ${e.message}`); } }
const DESTRUCTIVE = new Set(['DELETE']);

// ---------- special commands ----------
async function special(cfg, group, action, args) {
  const { positional, flags, extras, fields } = args;
  const mergeWrite = () => ({ ...extras, ...fields });
  switch (group) {
    case 'me': case 'whoami':
      return out(await request(cfg, 'GET', p(1, 'users/me')), flags);

    case 'status': case 'doctor': { // one-call diagnostic: config + auth, never hard-fails
      const c = resolveConfig(flags);
      const info = {
        base_url: c.base || null,
        domain: c.domain || (c.baseOverride ? '(base-url override)' : null),
        token: c.token ? `present (…${String(c.token).slice(-4)})` : 'ABSENT — set PIPEDRIVE_API_TOKEN',
        dry_run: c.dryRun,
        allow_delete: c.allowDelete,
      };
      if (!c.token || !c.base) {
        info.auth = { ok: false, error: `missing ${[!c.token && 'token', !c.base && 'domain'].filter(Boolean).join(' and ')}` };
      } else if (c.dryRun) {
        info.auth = { checked: false, note: 'PD_DRY_RUN is on — no live call made; unset it to hit the API' };
      } else {
        try {
          const resp = await fetch(c.base + p(1, 'users/me'), { headers: { 'x-api-token': c.token, accept: 'application/json' } });
          const j = await resp.json().catch(() => ({}));
          if (resp.ok && j.success !== false) info.auth = { ok: true, user: j.data && { id: j.data.id, name: j.data.name, email: j.data.email } };
          else info.auth = { ok: false, status: resp.status, error: j.error || j.error_info || resp.statusText };
        } catch (e) { info.auth = { ok: false, error: String((e && e.message) || e) }; }
      }
      return out(info, flags);
    }

    case 'search': { // global item search (v2)
      const term = need(action, 'search <term> [--item-types deal,person] [--fields title]');
      const q = { term };
      if (flags['item-types']) q.item_types = flags['item-types'];
      if (flags.fields) q.fields = flags.fields;
      if (flags['exact-match']) q.exact_match = true;
      if (flags.limit) q.limit = flags.limit;
      Object.assign(q, extras);
      return out(await request(cfg, 'GET', p(2, 'itemSearch'), { query: q }), flags);
    }

    case 'fields': { // custom-field resolution: pd fields deal|person|organization|product|activity
      const map = { deal: 'dealFields', person: 'personFields', organization: 'organizationFields',
                    org: 'organizationFields', product: 'productFields', activity: 'activityFields',
                    note: 'noteFields', lead: 'dealFields' };
      const ent = need(action, 'fields <deal|person|organization|product|activity>');
      const endpoint = map[ent] || map[ent.replace(/s$/, '')];
      if (!endpoint) fail(`Unknown field entity '${ent}'.`);
      const res = await request(cfg, 'GET', p(1, endpoint), { query: { limit: 500 } });
      const slim = (res.data || []).map((f) => ({
        key: f.key, name: f.name, field_type: f.field_type,
        options: f.options ? f.options.map((o) => ({ id: o.id, label: o.label })) : undefined,
      }));
      return out(flags.raw ? res : { data: slim }, flags);
    }

    case 'leads': { // overrides for convert / status (v2)
      if (action === 'convert') {
        const id = need(positional[0], 'leads convert <id> [--...]');
        const body = flags['body-json'] ? parseBodyJson(flags['body-json']) : mergeWrite();
        return out(await request(cfg, 'POST', p(2, 'leads', id, 'convert/deal'), { body: Object.keys(body).length ? body : undefined }), flags);
      }
      if (action === 'conversion-status' || action === 'status') {
        const id = need(positional[0], 'leads conversion-status <lead-id> <conversion-id>');
        const conv = need(positional[1], 'leads conversion-status <lead-id> <conversion-id>');
        return out(await request(cfg, 'GET', p(2, 'leads', id, 'convert/status', conv)), flags);
      }
      return null; // fall through to generic entity handling
    }

    case 'activities': {
      if (action === 'done' || action === 'mark-done') {
        const id = need(positional[0], 'activities done <id>');
        return out(await request(cfg, 'PATCH', p(2, 'activities', id), { body: { done: true } }), flags);
      }
      return null;
    }

    case 'deals': {
      if (action === 'products') {
        const id = need(positional[0], 'deals products <id>');
        return out(await request(cfg, 'GET', p(2, 'deals', id, 'products'), { query: extras }), flags);
      }
      return null;
    }

    case 'files': {
      if (action === 'download') {
        const id = need(positional[0], 'files download <id> --output <path>');
        const dest = need(flags.output, 'files download <id> --output <path>');
        if (cfg.dryRun) { process.stderr.write(`[dry-run] GET ${cfg.base}${p(1, 'files', id, 'download')} -> ${dest}\n`); return true; }
        const resp = await request(cfg, 'GET', p(1, 'files', id, 'download'), { rawResp: true });
        if (!resp.ok) fail(`download failed: ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        (await import('node:fs')).writeFileSync(dest, buf);
        process.stdout.write(`wrote ${buf.length} bytes -> ${dest}\n`);
        return true;
      }
      if (action === 'upload') {
        const file = need(positional[0], 'files upload <path> [--deal-id N] [--person-id N] [--org-id N]');
        return out(await uploadFile(cfg, file, mergeWrite()), flags);
      }
      return null;
    }

    case 'api': { // raw escape hatch: pd api GET /v2/deals --query k=v --body-json '{...}'
      const method = need((action || '').toUpperCase(), "api <GET|POST|PATCH|PUT|DELETE> <path> [--query k=v] [--body-json '{}']");
      let path = need(positional[0], 'api <METHOD> <path>');
      if (!path.startsWith('/api/')) path = path.startsWith('/') ? `/api${path.startsWith('/v') ? '' : '/v1'}${path}` : `/api/v1/${path}`;
      if (DESTRUCTIVE.has(method)) { // same gate as `<entity> delete`
        if (!flags.yes) fail('Destructive api call requires --yes.');
        if (!cfg.allowDelete) fail('Deletes disabled. Set PIPEDRIVE_ALLOW_DELETE=1 or pass --allow-delete.');
      }
      const body = flags['body-json'] ? parseBodyJson(flags['body-json']) : (Object.keys(mergeWrite()).length ? mergeWrite() : undefined);
      return out(await request(cfg, method, path, { query: { ...args.query, ...extras }, body }), flags);
    }
  }
  return null;
}

async function uploadFile(cfg, filePath, extra) {
  const fs = await import('node:fs');
  const pathmod = await import('node:path');
  const data = fs.readFileSync(filePath);
  const name = pathmod.basename(filePath);
  if (cfg.dryRun) {
    process.stderr.write(`[dry-run] POST ${cfg.base}${p(1, 'files')} (multipart: file=${name}, ${JSON.stringify(extra)})\n`);
    return { success: true, data: { dry_run: true } };
  }
  const q = (s) => String(s).replace(/["\r\n]/g, '_'); // sanitize header-injected values
  const boundary = '----pdcli' + data.length.toString(36) + name.length.toString(36);
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, 'utf8'));
  push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${q(name)}"\r\n`);
  push(`Content-Type: application/octet-stream\r\n\r\n`);
  parts.push(data); push('\r\n');
  for (const [k, v] of Object.entries(extra)) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${q(k)}"\r\n\r\n${v}\r\n`);
  }
  push(`--${boundary}--\r\n`);
  const bodyBuf = Buffer.concat(parts);
  const resp = await fetch(cfg.base + p(1, 'files'), {
    method: 'POST',
    headers: { 'x-api-token': cfg.token, 'content-type': `multipart/form-data; boundary=${boundary}`, accept: 'application/json' },
    body: bodyBuf,
  });
  const json = await resp.json();
  if (!resp.ok || json.success === false) fail(`upload failed: ${json.error || resp.status}`);
  return json;
}

// ---------- workflow shortcuts (read-only views composed from the API) ----------
const DAY_MS = 86400000;
const SHORTCUTS = new Set(['my', 'overdue', 'upcoming', 'stale', 'recent', 'followups', 'pipeline']);
async function meId(cfg) { const r = await request(cfg, 'GET', p(1, 'users/me')); return r.data && r.data.id; }
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const todayYMD = () => ymd(Date.now());
const isoAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString().replace(/\.\d+Z$/, 'Z');
const isUndone = (a) => a.done === false || a.done === 0 || a.done === undefined;
const slimDeal = (d) => ({ id: d.id, title: d.title, value: d.value, currency: d.currency, status: d.status, stage_id: d.stage_id, pipeline_id: d.pipeline_id, owner_id: d.owner_id, person_id: d.person_id, org_id: d.org_id, update_time: d.update_time });
const slimAct = (a) => ({ id: a.id, subject: a.subject, type: a.type, due_date: a.due_date, due_time: a.due_time, done: a.done, deal_id: a.deal_id, person_id: a.person_id, org_id: a.org_id, owner_id: a.owner_id });
function emit(arr, flags, slim) {
  const data = flags.full || !slim ? arr : arr.map(slim);
  process.stdout.write((flags.compact ? JSON.stringify(data) : JSON.stringify(data, null, 2)) + '\n');
  return true;
}
async function fetchAll(cfg, ver, path, query) {
  return (await paginate(cfg, ver, path, { query, flags: { all: true, limit: 500 } })).data;
}

async function shortcut(cfg, group, action, args) {
  const { flags, extras } = args;
  const days = flags.days;
  const owner = flags['all-owners'] ? undefined : await meId(cfg);
  const pipelineId = extras.pipeline_id;

  const openDeals = () => {
    const q = { status: 'open', limit: 500 };
    if (owner) q.owner_id = owner;
    if (pipelineId) q.pipeline_id = pipelineId;
    return fetchAll(cfg, 2, p(2, 'deals'), q);
  };
  const myUndoneActs = async () => {
    const q = { limit: 500 };
    if (owner) q.owner_id = owner;
    return (await fetchAll(cfg, 2, p(2, 'activities'), q)).filter(isUndone);
  };
  const byDue = (x, y) => (String(x.due_date) < String(y.due_date) ? -1 : 1);

  switch (group) {
    case 'my': {
      if (action === undefined || action === 'deals' || action === 'open-deals') return emit(await openDeals(), flags, slimDeal);
      if (action === 'activities' || action === 'tasks') return emit((await myUndoneActs()).sort(byDue), flags, slimAct);
      fail(`Unknown 'my ${action}'. Try: my deals | my activities`);
    }
    case 'overdue': {
      const t = todayYMD();
      return emit((await myUndoneActs()).filter((a) => a.due_date && a.due_date < t).sort(byDue), flags, slimAct);
    }
    case 'upcoming': {
      const t = todayYMD(); const until = ymd(Date.now() + (days ?? 7) * DAY_MS);
      return emit((await myUndoneActs()).filter((a) => a.due_date && a.due_date >= t && a.due_date <= until).sort(byDue), flags, slimAct);
    }
    case 'stale': {
      const q = { status: 'open', updated_until: isoAgo(days ?? 30), limit: 500, sort_by: 'update_time', sort_direction: 'asc' };
      if (owner) q.owner_id = owner;
      if (pipelineId) q.pipeline_id = pipelineId;
      return emit(await fetchAll(cfg, 2, p(2, 'deals'), q), flags, slimDeal);
    }
    case 'recent': {
      const q = { updated_since: isoAgo(days ?? 7), limit: 500, sort_by: 'update_time', sort_direction: 'desc' };
      if (owner) q.owner_id = owner;
      return emit(await fetchAll(cfg, 2, p(2, 'deals'), q), flags, slimDeal);
    }
    case 'followups': { // my open deals with no scheduled upcoming activity
      const [deals, acts] = [await openDeals(), await myUndoneActs()];
      const t = todayYMD();
      const haveUpcoming = new Set(acts.filter((a) => a.due_date && a.due_date >= t && a.deal_id != null).map((a) => a.deal_id));
      return emit(deals.filter((d) => !haveUpcoming.has(d.id)), flags, slimDeal);
    }
    case 'pipeline': { // open deals grouped by stage (count + Σ value)
      const sq = {}; if (pipelineId) sq.pipeline_id = pipelineId;
      const stages = await fetchAll(cfg, 2, p(2, 'stages'), sq);
      const deals = await openDeals();
      const rows = new Map();
      for (const s of stages) rows.set(s.id, { stage_id: s.id, stage_name: s.name, pipeline_id: s.pipeline_id, order_nr: s.order_nr, count: 0, total_value: 0 });
      const unknown = { stage_id: null, stage_name: '(unknown stage)', count: 0, total_value: 0 };
      for (const d of deals) { const r = rows.get(d.stage_id) || unknown; r.count++; r.total_value += Number(d.value) || 0; }
      const out2 = [...rows.values()].sort((a, b) => (a.order_nr ?? 0) - (b.order_nr ?? 0));
      if (unknown.count) out2.push(unknown);
      return emit(out2, flags, null);
    }
  }
  return null;
}

// ---------- help ----------
const HELP = `pd — Pipedrive CLI (covers the official MCP surface + safe read extras)

Auth (env or flags):
  PIPEDRIVE_API_TOKEN   personal API token   (or --token)
  PIPEDRIVE_DOMAIN      company subdomain    (or --domain)   e.g. acme  ->  acme.pipedrive.com
  PIPEDRIVE_ALLOW_DELETE=1  enable deletes   (deletes also need --yes)

Entities (list|get <id>|search <term>|add|update <id>|delete <id>):
  deals persons organizations activities notes leads products pipelines stages users files
    pd deals list --status open --limit 50 --all
    pd deals get 42
    pd deals search "acme" --exact-match
    pd deals add --title "New deal" --value 5000 --currency EUR --person-id 7
    pd deals update 42 --stage-id 3 --field <customFieldHash>=Foo
    pd persons add --name "Jane Doe" --email jane@acme.com
    pd deals delete 42 --yes --allow-delete

Workflow views (read-only; --mine is the default, --all-owners for the whole team, --full for full objects):
  pd my deals                        my open deals
  pd my activities                   my open (undone) activities
  pd overdue                         my activities past their due date
  pd upcoming [--days 7]             my activities due within N days
  pd stale [--days 30]               open deals not updated in N days
  pd recent [--days 7]               deals updated in the last N days
  pd followups                       my open deals with no upcoming activity
  pd pipeline [--pipeline-id N]      open deals grouped by stage (count + Σ value)

Shortcuts / extras:
  pd status                          config + auth diagnostic (domain, token?, dry-run?, who am I)
  pd me                              current user (auth check)
  pd search <term> --item-types deal,person,lead        global item search
  pd fields deal|person|organization|product|activity   list field keys + custom-field hashes
  pd deals products <id>             products attached to a deal
  pd activities done <id>            mark an activity done
  pd leads convert <id>              convert a lead to a deal (async job)
  pd leads conversion-status <leadId> <conversionId>
  pd files download <id> --output ./file.pdf
  pd files upload ./file.pdf --deal-id 42

Raw escape hatch (reach any endpoint):
  pd api GET /v2/deals --query status=open
  pd api POST /v1/notes --body-json '{"content":"hi","deal_id":42}'

Global flags:
  --limit N  --all  --cursor C  --start N   pagination (v2 uses cursor, v1 uses start)
  --field k=v   set a body field, smart-typed (repeatable; for 40-char custom-field hashes)
  --str k=v     set a body field forced to string (repeatable)
  --num k=v     set a body field forced to number (repeatable)
  --query k=v   set a query param (repeatable)
  --body-json '{...}'   full JSON body for add/update (raw JSON string)
  --raw         print the full API envelope (not just .data)
  --compact     single-line JSON
  --dry-run     print the composed request without sending it (also PD_DRY_RUN=1)
  --yes --allow-delete   required for any destructive op (incl. 'api DELETE ...')
  Any other --kebab-flag becomes a snake_case field (writes) or query param (reads).
  Values stay strings unless the field is numeric (ids, value, amount, quantity, ...);
  leading-zero and out-of-range numbers stay strings. Use --num/--str to force a type.
`;

// ---------- router ----------
async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const { positional, flags } = args;
  const group = positional.shift();
  const action = positional.shift();

  if (!group || group === 'help' || flags.help || flags.h) { process.stdout.write(HELP); return; }

  // `status`/`doctor` diagnose config itself, so they must not hard-fail on missing creds
  if (group === 'status' || group === 'doctor') {
    await special({ dryRun: resolveConfig(flags).dryRun }, group, action, { ...args, positional });
    return;
  }

  const cfg = config(flags);

  // workflow shortcut views (read-only) — intercept before entity resolution
  if (SHORTCUTS.has(group)) {
    await shortcut(cfg, group, action, { ...args, positional });
    return;
  }

  // non-entity groups (always handled by special())
  if (['me', 'whoami', 'search', 'fields', 'api'].includes(group)) {
    await special(cfg, group, action, { ...args, positional });
    return;
  }

  const ent = resolveEntity(group);
  if (!ent) fail(`Unknown command '${group}'. Run 'pd help'.`);

  // entity-specific special actions (convert, done, products, files upload/download)
  // return truthy when fully handled; null/false to fall through to generic CRUD.
  if (await special(cfg, ent.key, action, { ...args, positional })) return;

  await entityAction(cfg, ent, action || 'list', { ...args, positional });
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
