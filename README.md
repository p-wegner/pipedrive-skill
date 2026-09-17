# pipedrive-skill

A small command-line tool for your [Pipedrive](https://www.pipedrive.com/) CRM, packaged as an
agent **skill** for Claude Code. One self-contained file (`bin/pd.mjs`) lets you search, read,
create and update deals, contacts, organizations, activities, leads and notes straight from the
terminal — and lets an AI assistant do the same on your behalf.

It mirrors everything Pipedrive's own [MCP server](https://www.pipedrive.com/en/features/mcp-server)
can do, and adds a few conveniences on top (pipelines, products, files, custom-field lookup,
global search, ready-made "what needs my attention today" views, and a raw escape hatch to any
API endpoint).

**No dependencies.** It needs only Node.js 18+ (for the built-in `fetch`) — no `npm install`,
nothing to build.

## Install

Clone it anywhere:

```bash
git clone https://github.com/p-wegner/pipedrive-skill.git
cd pipedrive-skill
```

### As a Claude Code skill

Drop it into your Claude Code skills directory so the assistant can use it on your behalf:

```bash
git clone https://github.com/p-wegner/pipedrive-skill.git ~/.claude/skills/pipedrive-skill
```

Claude Code reads `SKILL.md` and picks the skill up automatically. Then just ask things like
"show my open deals" or "log a call on deal 42".

## Getting started

1. Grab your personal API token in Pipedrive: **Settings → Personal preferences → API**.
2. Note your company subdomain — the `acme` in `acme.pipedrive.com`.
3. Point the tool at them:

```bash
export PIPEDRIVE_API_TOKEN=your-token-here
export PIPEDRIVE_DOMAIN=acme

node bin/pd.mjs me            # confirms your token works (prints your user)
node bin/pd.mjs help          # the full command list
```

Tip: alias it so you can just type `pd`:

```bash
alias pd='node /path/to/pipedrive-skill/bin/pd.mjs'
```

## Everyday examples

```bash
pd deals list --status open --all               # every open deal
pd deals search "acme corp"                      # find a deal
pd deals add --title "New deal" --value 5000 --currency EUR --person-id 7
pd persons add --name "Jane Doe" --email jane@acme.com
pd notes add --content "Called, keen to talk" --deal-id 42
pd leads convert 11                              # turn a lead into a deal
```

### "What needs my attention?" views

```bash
pd my deals              # my open deals
pd overdue               # my activities that are past due
pd upcoming --days 7     # my activities due this week
pd stale --days 30       # open deals nobody has touched in a month
pd followups             # my open deals with no next step scheduled
pd pipeline              # open deals grouped by stage, with totals
```

These are read-only and scoped to you by default (add `--all-owners` for the whole team).

## Good to know

- **Preview first.** Add `--dry-run` to any command to see exactly what it would send, without
  sending it.
- **Deletes are protected.** Deleting anything requires both `--yes` and `--allow-delete`
  (or `PIPEDRIVE_ALLOW_DELETE=1`) — you won't remove records by accident.
- **Your data stays intact.** Phone numbers, postcodes and other text keep their exact value
  (no dropped leading zeros); use `--str`/`--num` if you ever need to force a type.
- **Custom fields** show up as cryptic keys. Run `pd fields deal` (or `person`, `organization`,
  …) to see friendly names and the keys to use.

## Restricting to an approved model endpoint (data residency)

If you only want the CLI to run when Claude Code is pointed at an approved model backend — AWS
Bedrock, Google Vertex, an EU-hosted gateway, etc. — set an allowlist. When
`PD_ALLOWED_ENDPOINTS` is **unset the guard is off** (default behaviour is unchanged); set it to
turn the guard on:

```bash
# only run when Claude Code targets Bedrock in an EU region, or an EU gateway host
export PD_ALLOWED_ENDPOINTS="bedrock:eu-*,vertex:eu,*.eu.acme.internal"
```

Each comma-separated entry is a **provider token** (`bedrock`, `vertex`, `foundry`, `mantle`,
`custom`), optionally with a `:region-glob` (`bedrock:eu-*`), or a **host** matched against
`ANTHROPIC_BASE_URL` / `ANTHROPIC_BEDROCK_BASE_URL` / `ANTHROPIC_VERTEX_BASE_URL` (globs and
`:port` allowed). The guard reads the provider env vars Claude Code exports
(`CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, `CLOUD_ML_REGION`, …), which propagate into the CLI
subprocess. On a non-matching endpoint the command refuses to run before any Pipedrive call.

A fourth entry type, **`residency:<region>`** (e.g. `residency:eu`), is for a gateway that serves
several regions under **one** host, where the host alone proves nothing. It matches when the
session's environment carries `CLAUDE_MODEL_RESIDENCY=<region>` (comma list allowed). That
variable is meant to be written by whatever configures the session **after** checking that every
model the session can reach is served in that region (a profile writer for the gateway, for
example); a person can of course set it by hand, which is the same caveat as for every other
entry, see the disclaimer below.

- Run `pd status` to see the current verdict (`ok` / `BLOCKED` / `off`) and the detected endpoint.
- **Local-dev bypass:** `--skip-endpoint-check` (or `PD_SKIP_ENDPOINT_CHECK=1`) is honored **only**
  when `PD_ALLOW_ENDPOINT_OVERRIDE=1`. Pin `PD_ALLOWED_ENDPOINTS` in managed/enterprise
  `settings.json` and leave the override unset so it can't be bypassed from the session.

> **Disclaimer — what this guard is and isn't.** It reads *configuration* (the endpoint env vars
> Claude Code exports), **not** attested session state, and there is no cryptographic proof of
> which model backend actually served a request. It therefore stops **misconfiguration and casual
> misuse** — e.g. silently falling back to the default Anthropic API — but it does **not** stop a
> determined user who controls their own environment (anyone who can set `CLAUDE_CODE_USE_BEDROCK=1`
> or point `ANTHROPIC_BASE_URL` anywhere can satisfy the check without a real approved backend
> behind it). Treat it as a compliance guardrail, not a security boundary. For stronger,
> fleet-wide enforcement, pin the allowlist in **managed** settings (highest precedence, users
> can't override) and/or pair it with a `PreToolUse` hook — and enforce data residency at the
> gateway/network layer, which is the only place it can be guaranteed.

## Anything not covered?

The raw escape hatch reaches any Pipedrive endpoint:

```bash
pd api GET  /v2/deals --query status=open
pd api POST /v1/notes --body-json '{"content":"hi","deal_id":42}'
```

## What's in the box

| File | Purpose |
|------|---------|
| `bin/pd.mjs` | The CLI — the whole tool, one file. |
| `SKILL.md` | Instructions the AI assistant reads. |
| `reference/api-notes.md` | Which endpoints/versions each command uses, and how paging works. |
| `test/e2e.mjs` | Test suite — 47 checks against a local mock Pipedrive server (`node test/e2e.mjs`; no account or network needed). |

## Development

```bash
node test/e2e.mjs        # run the full test suite
```

The tests spin up a local stand-in for Pipedrive and drive the real CLI against it, covering
routing, API versions, pagination, value handling, the safety gates, error handling, search,
lead conversion, file upload/download, and the workflow views.

## License

[MIT](LICENSE) © Peter Wegner

Not affiliated with or endorsed by Pipedrive. "Pipedrive" is a trademark of its respective owner.
