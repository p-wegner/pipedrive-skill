// End-to-end test: runs the real CLI (child process) against a local mock Pipedrive
// server over real HTTP. Exercises routing, versions, pagination, coercion, gates,
// error handling, search, convert, custom fields, and multipart upload/download.
//
//   node test/e2e.mjs
//
// No credentials or network required.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const PD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'pd.mjs');
const calls = [];            // recorded inbound requests
let PORT;

function body(res, obj, code = 200) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    let parsed;
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json') && raw.length) { try { parsed = JSON.parse(raw.toString()); } catch { parsed = raw.toString(); } }
    const rec = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: parsed, rawLen: raw.length, ct, token: req.headers['x-api-token'] };
    calls.push(rec);
    const q = url.searchParams;
    const pth = url.pathname;

    // ----- workflow-shortcut fixtures -----
    if (req.method === 'GET' && pth === '/api/v1/users/me') return body(res, { success: true, data: { id: 99, name: 'Me' } });
    if (req.method === 'GET' && pth === '/api/v2/stages' && !q.get('cursor'))
      return body(res, { success: true, data: [{ id: 1, name: 'Lead', order_nr: 1, pipeline_id: 1 }, { id: 2, name: 'Won', order_nr: 2, pipeline_id: 1 }] });
    if (req.method === 'GET' && pth === '/api/v2/activities' && q.get('owner_id') === '99') {
      const ms = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
      return body(res, { success: true, data: [
        { id: 1, subject: 'past', due_date: '2000-01-01', done: false, deal_id: 1, owner_id: 99 },
        { id: 2, subject: 'soon', due_date: ms(3), done: false, deal_id: 2, owner_id: 99 },
        { id: 3, subject: 'donepast', due_date: '2000-01-01', done: true, deal_id: 3, owner_id: 99 },
        { id: 4, subject: 'far', due_date: ms(60), done: false, deal_id: null, owner_id: 99 },
      ] });
    }
    // shortcut deals (owner-scoped); distinct from the plain-list pagination fixture below
    if (req.method === 'GET' && pth === '/api/v2/deals' && q.get('owner_id') === '99') {
      if (q.get('updated_until')) return body(res, { success: true, data: [{ id: 9, title: 'stale', stage_id: 1, value: 50, status: 'open', currency: 'EUR' }] });
      if (q.get('updated_since')) return body(res, { success: true, data: [{ id: 7, title: 'fresh', stage_id: 1, value: 10, status: 'open', currency: 'EUR' }] });
      return body(res, { success: true, data: [
        { id: 1, title: 'D1', stage_id: 1, value: 100, status: 'open', currency: 'EUR' },
        { id: 2, title: 'D2', stage_id: 2, value: 200, status: 'open', currency: 'EUR' },
      ] });
    }

    // pagination — v2 cursor
    if (req.method === 'GET' && pth === '/api/v2/deals') {
      if (!q.get('cursor')) return body(res, { success: true, data: [{ id: 1, title: 'A' }], additional_data: { next_cursor: 'CUR2' } });
      return body(res, { success: true, data: [{ id: 2, title: 'B' }], additional_data: { next_cursor: null } });
    }
    // pagination — v1 offset
    if (req.method === 'GET' && pth === '/api/v1/notes') {
      const start = Number(q.get('start') || 0);
      if (start === 0) return body(res, { success: true, data: [{ id: 11 }], additional_data: { pagination: { more_items_in_collection: true, next_start: 1 } } });
      return body(res, { success: true, data: [{ id: 12 }], additional_data: { pagination: { more_items_in_collection: false } } });
    }
    if (req.method === 'GET' && pth === '/api/v2/deals/42') return body(res, { success: true, data: { id: 42, title: 'The Deal' } });
    if (req.method === 'GET' && pth === '/api/v2/deals/search') return body(res, { success: true, data: { items: [{ item: { id: 1 } }] } });
    if (req.method === 'POST' && pth === '/api/v2/deals') return body(res, { success: true, data: { id: 100, ...parsed } });
    if (req.method === 'POST' && pth === '/api/v2/persons') return body(res, { success: true, data: { id: 101, ...parsed } });
    if (req.method === 'PATCH' && pth === '/api/v2/deals/42') return body(res, { success: true, data: { id: 42, ...parsed } });
    if (req.method === 'DELETE' && pth === '/api/v2/deals/42') return body(res, { success: true, data: { id: 42 } });
    if (req.method === 'PATCH' && pth === '/api/v2/activities/9') return body(res, { success: true, data: { id: 9, done: parsed.done } });
    if (req.method === 'POST' && pth === '/api/v2/leads/11/convert/deal') return body(res, { success: true, data: { conversion_id: 'job1' } });
    if (req.method === 'GET' && pth === '/api/v2/leads/11/convert/status/job1') return body(res, { success: true, data: { status: 'completed', deal_id: 55 } });
    if (req.method === 'GET' && pth === '/api/v2/itemSearch') return body(res, { success: true, data: { items: [] } });
    if (req.method === 'GET' && pth === '/api/v1/dealFields') return body(res, { success: true, data: [{ key: 'abc123hashkey', name: 'My Custom', field_type: 'enum', options: [{ id: 7, label: 'X' }] }] });
    if (req.method === 'POST' && pth === '/api/v1/files') return body(res, { success: true, data: { id: 5, name: 'uploaded' } });
    if (req.method === 'GET' && pth === '/api/v1/files/5/download') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.from('PDFBYTES')); }
    if (req.method === 'GET' && pth === '/api/v1/auth-fail') return body(res, { success: false, error: 'bad token' }, 401);

    return body(res, { success: true, data: parsed ?? [] });
  });
});

// ---------- harness ----------
let pass = 0, failn = 0;
const results = [];
// Async spawn so the in-process mock server's event loop stays free to serve the child.
function run(args, { extraEnv = {}, keepCreds = true, noToken = false } = {}) {
  calls.length = 0;
  const env = { ...process.env, ...extraEnv };
  if (keepCreds) { env.PIPEDRIVE_BASE_URL = `http://localhost:${PORT}`; env.PIPEDRIVE_API_TOKEN = 'testtoken'; }
  if (noToken) delete env.PIPEDRIVE_API_TOKEN;
  delete env.PD_DRY_RUN;
  if (extraEnv.PD_DRY_RUN) env.PD_DRY_RUN = extraEnv.PD_DRY_RUN;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PD, ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { failn++; results.push(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}
const lastCall = () => calls[calls.length - 1];

server.listen(0, async () => {
  PORT = server.address().port;
  try { await main(); } catch (e) { results.push('  THREW ' + (e && e.stack ? e.stack : e)); failn++; } finally {
    server.close();
    process.stdout.write('\n' + results.join('\n') + `\n\n${pass} passed, ${failn} failed\n`);
    process.exit(failn ? 1 : 0);
  }
});

async function main() {
  // 1. v2 cursor pagination: --all follows next_cursor
  let r = await run(['deals', 'list', '--all']);
  let data = JSON.parse(r.stdout);
  check('deals list --all follows cursor (2 items)', Array.isArray(data) && data.length === 2 && data[1].id === 2, JSON.stringify(data));

  // 2. no --all returns only first page
  r = await run(['deals', 'list']);
  data = JSON.parse(r.stdout);
  check('deals list (no --all) = first page only (1 item)', Array.isArray(data) && data.length === 1, JSON.stringify(data));

  // 3. v1 offset pagination
  r = await run(['notes', 'list', '--all']);
  data = JSON.parse(r.stdout);
  check('notes list --all follows v1 offset (2 items)', Array.isArray(data) && data.length === 2, JSON.stringify(data));

  // 4. get by id, unwraps .data object
  r = await run(['deals', 'get', '42']);
  check('deals get 42 -> data.title', JSON.parse(r.stdout).title === 'The Deal');

  // 5. add: correct path, method, numeric coercion of value + id
  r = await run(['deals', 'add', '--title', 'Big', '--value', '5000', '--person-id', '7']);
  let c = lastCall();
  check('deals add -> POST /api/v2/deals', c.method === 'POST' && c.path === '/api/v2/deals');
  check('deals add coerces value & person_id to numbers', c.body.value === 5000 && c.body.person_id === 7, JSON.stringify(c.body));
  check('deals add keeps title as string', c.body.title === 'Big');

  // 6. ADVERSARIAL: all-digit name must stay a string, not become a number
  r = await run(['persons', 'add', '--name', '12345']);
  c = lastCall();
  check('persons add --name 12345 stays STRING', c.body.name === '12345', 'got ' + JSON.stringify(c.body.name) + ' (' + typeof c.body.name + ')');

  // 7. ADVERSARIAL: leading-zero phone must not lose the zero
  r = await run(['persons', 'add', '--name', 'Zed', '--phone', '0012345']);
  c = lastCall();
  check('persons add --phone 0012345 preserves leading zeros', c.body.phone === '0012345', 'got ' + JSON.stringify(c.body.phone));

  // 8. ADVERSARIAL: custom-field value containing '='
  r = await run(['deals', 'add', '--title', 'x', '--field', 'abc123hashkey=a=b']);
  c = lastCall();
  check('custom --field hash=a=b keeps full value', c.body.abc123hashkey === 'a=b', JSON.stringify(c.body));

  // 9. ADVERSARIAL: negative numeric value
  r = await run(['deals', 'update', '42', '--value', '-500']);
  c = lastCall();
  check('deals update --value -500 parsed as -500', c.method === 'PATCH' && c.body.value === -500, JSON.stringify(c.body));

  // 10. list extras -> query params (not body)
  r = await run(['deals', 'list', '--status', 'open', '--stage-id', '3']);
  c = lastCall();
  check('list extras become query params', c.query.status === 'open' && c.query.stage_id === '3', JSON.stringify(c.query));

  // 11. search -> v2 /deals/search with term
  r = await run(['deals', 'search', 'acme', '--exact-match']);
  c = lastCall();
  check('deals search -> /api/v2/deals/search', c.path === '/api/v2/deals/search' && c.query.term === 'acme' && c.query.exact_match === 'true');

  // 12. entity without search support errors
  r = await run(['activities', 'search', 'x']);
  check('activities search rejected (no searchV)', r.code === 1 && /does not support search/.test(r.stderr), r.stderr);

  // 13. leads convert -> v2 convert path
  r = await run(['leads', 'convert', '11']);
  c = lastCall();
  check('leads convert -> POST /api/v2/leads/11/convert/deal', c.method === 'POST' && c.path === '/api/v2/leads/11/convert/deal');
  check('leads convert returns conversion_id', JSON.parse(r.stdout).conversion_id === 'job1');

  // 14. conversion status
  r = await run(['leads', 'conversion-status', '11', 'job1']);
  check('conversion-status -> deal_id 55', JSON.parse(r.stdout).deal_id === 55);

  // 15. activities done -> PATCH done:true
  r = await run(['activities', 'done', '9']);
  c = lastCall();
  check('activities done -> PATCH done:true', c.method === 'PATCH' && c.body.done === true);

  // 16. fields resolver slims output
  r = await run(['fields', 'deal']);
  data = JSON.parse(r.stdout);
  check('fields deal returns key+name+options', data[0].key === 'abc123hashkey' && data[0].options[0].id === 7, JSON.stringify(data));

  // 17. error handling: 401 -> exit 1, message
  r = await run(['api', 'GET', '/v1/auth-fail']);
  check('401 -> exit 1 + message', r.code === 1 && /Pipedrive API 401: bad token/.test(r.stderr), JSON.stringify({ code: r.code, err: r.stderr }));

  // 18. delete gating
  r = await run(['deals', 'delete', '42']);
  check('delete without --yes blocked', r.code === 1 && /requires --yes/.test(r.stderr));
  r = await run(['deals', 'delete', '42', '--yes']);
  check('delete without allow-delete blocked', r.code === 1 && /Deletes disabled/.test(r.stderr));
  r = await run(['deals', 'delete', '42', '--yes', '--allow-delete']);
  c = lastCall();
  check('delete with both gates -> DELETE sent', r.code === 0 && c && c.method === 'DELETE' && c.path === '/api/v2/deals/42', JSON.stringify({ code: r.code }));

  // 19. token sent as header
  check('token passed via x-api-token header', lastCall().token === 'testtoken');

  // 20. raw envelope
  r = await run(['deals', 'get', '42', '--raw']);
  check('--raw prints full envelope', JSON.parse(r.stdout).success === true);

  // 21. api escape hatch: GET works ungated (reads are free)
  r = await run(['api', 'GET', '/v2/deals/42']);
  check('api GET works ungated', r.code === 0 && lastCall().method === 'GET');

  // 22. multipart upload
  const tmp = path.join(os.tmpdir(), 'pd-e2e-upload.txt');
  fs.writeFileSync(tmp, 'hello upload');
  r = await run(['files', 'upload', tmp, '--deal-id', '42']);
  c = lastCall();
  check('files upload -> multipart POST /api/v1/files', c.method === 'POST' && c.path === '/api/v1/files' && c.ct.includes('multipart/form-data'));
  check('files upload response parsed', JSON.parse(r.stdout).id === 5);
  fs.unlinkSync(tmp);

  // 23. file download writes bytes
  const dl = path.join(os.tmpdir(), 'pd-e2e-download.bin');
  r = await run(['files', 'download', '5', '--output', dl]);
  check('files download writes file bytes', fs.existsSync(dl) && fs.readFileSync(dl).toString() === 'PDFBYTES', r.stdout + r.stderr);
  if (fs.existsSync(dl)) fs.unlinkSync(dl);

  // 24. unknown command
  r = await run(['frobnicate']);
  check('unknown command -> exit 1', r.code === 1 && /Unknown command/.test(r.stderr));

  // 25. help without creds
  r = await run(['help'], { keepCreds: false });
  check('help works without credentials', r.code === 0 && /Pipedrive CLI/.test(r.stdout));

  // 26. --body-json supplies a full JSON body
  r = await run(['notes', 'add', '--body-json', '{"content":"hi","deal_id":42}']);
  c = lastCall();
  check('--body-json sends parsed body', c && c.body && c.body.content === 'hi' && c.body.deal_id === 42, JSON.stringify(r.stderr || (c && c.body)));

  // 27. flags BEFORE positional id must not swallow it
  r = await run(['deals', 'delete', '--yes', '--allow-delete', '42']);
  check('flags-before-id: delete 42 still works', r.code === 0 && lastCall() && lastCall().method === 'DELETE', JSON.stringify({ code: r.code, err: r.stderr }));

  // 28. api DELETE should be gated (safety consistency)
  r = await run(['api', 'DELETE', '/v2/deals/42']);
  check('api DELETE is gated without --yes/--allow-delete', r.code === 1 && /--yes|Deletes disabled/.test(r.stderr), JSON.stringify({ code: r.code, err: r.stderr }));

  // 29. --raw on list prints the real API envelope (not internal wrapper)
  r = await run(['deals', 'list', '--raw']);
  data = JSON.parse(r.stdout);
  check('--raw list -> real envelope (success + additional_data)', data.success === true && 'additional_data' in data && !('envelope' in data), JSON.stringify(Object.keys(data)));

  // 30. dry-run upload must NOT actually send
  const tmp2 = path.join(os.tmpdir(), 'pd-e2e-dry.txt'); fs.writeFileSync(tmp2, 'x');
  r = await run(['files', 'upload', tmp2, '--deal-id', '42'], { extraEnv: { PD_DRY_RUN: '1' } });
  check('dry-run upload sends nothing', calls.length === 0, 'calls=' + calls.length);
  fs.unlinkSync(tmp2);

  // 31. explicit string escape: a numeric-named field forced to string via --str
  r = await run(['deals', 'add', '--title', 'Num', '--str', 'value=12345']);
  c = lastCall();
  check('--str forces numeric-named field to string', c && c.body.value === '12345', JSON.stringify(c && c.body));

  // ---- workflow shortcuts ----
  // 32. my deals -> my open deals, slimmed
  r = await run(['my', 'deals']);
  data = JSON.parse(r.stdout);
  check('my deals -> 2 open deals (slim)', Array.isArray(data) && data.length === 2 && data[0].id === 1 && data[0].value === 100, r.stderr || JSON.stringify(data));

  // 33. my activities -> undone only, sorted by due
  r = await run(['my', 'activities']);
  data = JSON.parse(r.stdout);
  check('my activities -> 3 undone (excludes done)', Array.isArray(data) && data.length === 3 && data.every((a) => a.done !== true), JSON.stringify(data.map((a) => a.id)));

  // 34. overdue -> only past-due undone
  r = await run(['overdue']);
  data = JSON.parse(r.stdout);
  check('overdue -> [id 1] (past & undone)', data.length === 1 && data[0].id === 1, JSON.stringify(data.map((a) => a.id)));

  // 35. upcoming (default 7 days) -> due within window
  r = await run(['upcoming']);
  data = JSON.parse(r.stdout);
  check('upcoming -> [id 2] (due in 3d, not the +60d one)', data.length === 1 && data[0].id === 2, JSON.stringify(data.map((a) => a.id)));

  // 36. stale -> hits updated_until, returns stale deal
  r = await run(['stale', '--days', '45']);
  c = lastCall();
  data = JSON.parse(r.stdout);
  check('stale -> deal 9 via updated_until', data.length === 1 && data[0].id === 9 && c.query.updated_until && c.query.status === 'open', JSON.stringify({ q: c.query, data }));

  // 37. recent -> hits updated_since
  r = await run(['recent']);
  data = JSON.parse(r.stdout);
  check('recent -> deal 7 via updated_since', data.length === 1 && data[0].id === 7, JSON.stringify(data));

  // 38. followups -> open deals with no upcoming activity
  r = await run(['followups']);
  data = JSON.parse(r.stdout);
  check('followups -> [deal 1] (deal 2 has an upcoming activity)', data.length === 1 && data[0].id === 1, JSON.stringify(data.map((d) => d.id)));

  // 39. pipeline -> grouped by stage with counts + sums
  r = await run(['pipeline']);
  data = JSON.parse(r.stdout);
  check('pipeline -> 2 stages, correct counts/sums',
    data.length === 2 && data[0].stage_name === 'Lead' && data[0].count === 1 && data[0].total_value === 100 && data[1].total_value === 200,
    r.stderr || JSON.stringify(data));

  // 40. --all-owners drops the owner_id filter
  r = await run(['my', 'deals', '--all-owners']);
  c = lastCall();
  check('--all-owners omits owner_id', c && c.path === '/api/v2/deals' && !('owner_id' in c.query), JSON.stringify(c && c.query));

  // 41. 'pipelines' (plural) still resolves to the entity list, not the shortcut
  r = await run(['pipelines', 'list']);
  check('pipelines entity still works', r.code === 0 && lastCall().path === '/api/v2/pipelines');

  // ---- status / doctor + dry-run visibility ----
  // 42. status with good creds -> auth ok + resolved user
  r = await run(['status']);
  data = JSON.parse(r.stdout);
  check('status reports auth ok + user', r.code === 0 && data.auth.ok === true && data.auth.user.id === 99 && data.base_url.includes('localhost') && /present/.test(data.token), r.stderr || JSON.stringify(data));

  // 43. status without a token -> graceful (no crash), token ABSENT, auth not ok
  r = await run(['status'], { noToken: true });
  data = JSON.parse(r.stdout);
  check('status without token is graceful', r.code === 0 && /ABSENT/.test(data.token) && data.auth.ok === false, JSON.stringify(data));

  // 44. status under dry-run -> reports dry-run, makes no live call
  r = await run(['status'], { extraEnv: { PD_DRY_RUN: '1' } });
  data = JSON.parse(r.stdout);
  check('status under dry-run skips the live call', r.code === 0 && data.dry_run === true && data.auth.checked === false && calls.length === 0, JSON.stringify({ data, calls: calls.length }));

  // 45. 'doctor' is an alias for 'status'
  r = await run(['doctor']);
  check('doctor aliases status', r.code === 0 && JSON.parse(r.stdout).auth.ok === true);

  // 46. dry-run surfaces the composed request on STDOUT
  r = await run(['deals', 'add', '--title', 'X', '--value', '5'], { extraEnv: { PD_DRY_RUN: '1' } });
  data = JSON.parse(r.stdout);
  check('dry-run stdout shows would_send (no live call)', data.dry_run === true && data.would_send.method === 'POST' && /\/api\/v2\/deals$/.test(data.would_send.url) && calls.length === 0, JSON.stringify(data));
}
