---
name: pipedrive
description: Pipedrive CRM from the terminal via a bundled zero-dependency Node CLI (bin/pd.mjs) — read/create/update deals, persons, organizations, activities, leads and notes; search; convert leads; pipeline/stage views; resolve custom fields; or run any raw API call. Use for Pipedrive/CRM tasks like "my deals", "create a deal", "search contacts", "log an activity", "convert this lead", "pipeline stages".
---

# Pipedrive skill

`bin/pd.mjs` — a zero-dependency Node (≥18) CLI over the Pipedrive REST API, covering the
official Pipedrive MCP surface plus safe extras. Prefer it over hand-rolled `curl`.
Run `node bin/pd.mjs help` for the exhaustive command list.

## Setup

Env vars (or `--token` / `--domain`):
- `PIPEDRIVE_API_TOKEN` — personal API token (Settings → Personal preferences → API).
- `PIPEDRIVE_DOMAIN` — company subdomain (`acme` → `acme.pipedrive.com`).

Check config + auth in one call: `node bin/pd.mjs status` (reports domain, token present?,
dry-run on/off, and who you're authenticated as). If creds are unset, ask the user — never
invent a token.

## Usage

`node bin/pd.mjs <group> <action> [args] [flags]` → prints the response `.data` as JSON.
`--dry-run` (or `PD_DRY_RUN=1`) previews without sending — it prints the composed request on
stdout as `{dry_run, would_send}` and makes no live call. `--raw` full envelope; `--compact`
one line. Errors print `error: …` and exit 1.

Entities — `list | get <id> | search <term> | add | update <id> | delete <id>`:
`deals persons organizations activities notes leads products pipelines stages users files`
```
pd deals list --status open --all
pd deals add --title "New deal" --value 5000 --currency EUR --person-id 7
pd persons search "acme" --exact-match
pd notes add --content "Called" --deal-id 42
```
Also: `status` (config+auth check), `me`, `search <term>` (global), `fields <entity>`, `activities done <id>`,
`leads convert <id>`, `files upload|download`, and `api <METHOD> <path>` (raw — any endpoint).
Read-only views: `my deals`, `my activities`, `overdue`, `upcoming`, `stale`, `recent`,
`followups`, `pipeline` (owner-scoped; `--all-owners`, `--full`). Full list: `pd help`.

## Writing fields (non-obvious)

- An unknown `--kebab value` flag → snake_case body field (writes) or query param (reads).
- **Values stay strings** unless the field is numeric-named (`*_id`, `value`, `amount`, …);
  leading-zero / out-of-range numbers stay strings, so phones, postcodes and numeric names
  aren't corrupted. Force a type with `--num k=v` or `--str k=v`.
- **Custom fields** use 40-char hex keys: run `pd fields <entity>` to get the key + option ids,
  then `--field <hash>=<value>`. `--field` also escapes a field name that clashes with a flag.
- `--body-json '{...}'` supplies a full raw JSON body.

## Safety

- Reads / creates / updates run without confirmation (matches the official MCP).
- **Deletes need BOTH `--yes` AND `--allow-delete`** (or `PIPEDRIVE_ALLOW_DELETE=1`) — for
  `<entity> delete` and `api DELETE`. Changes are live to the whole team: delete only when
  asked, and echo the target first.
- **Data-residency guard (opt-in).** Set `PD_ALLOWED_ENDPOINTS` (comma allowlist of provider
  tokens like `bedrock:eu-*`, `vertex:eu`, hosts, or `residency:eu` for a multi-region gateway
  whose session exports `CLAUDE_MODEL_RESIDENCY`) to make the CLI refuse to run unless Claude
  Code targets an approved model endpoint. Unset = off. Local bypass `--skip-endpoint-check`
  works only with `PD_ALLOW_ENDPOINT_OVERRIDE=1`. `pd status` reports the verdict. See README →
  "Restricting to an approved model endpoint".

Endpoint/version map + pagination details: `reference/api-notes.md`.
