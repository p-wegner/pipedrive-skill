# Pipedrive API notes (endpoint & version map)

The CLI picks the API version per entity. Pipedrive is migrating to v2; some resources are v2,
some remain v1 only, and leads are mixed.

| Command group | CRUD version | Search version | Base paths |
|---|---|---|---|
| deals | v2 | v2 | `/api/v2/deals`, `/api/v2/deals/search` |
| persons | v2 | v2 | `/api/v2/persons`, `/api/v2/persons/search` |
| organizations | v2 | v2 | `/api/v2/organizations`, `/api/v2/organizations/search` |
| activities | v2 | — | `/api/v2/activities` |
| products | v2 | v2 | `/api/v2/products`, `/api/v2/products/search` |
| pipelines | v2 | — | `/api/v2/pipelines` |
| stages | v2 | — | `/api/v2/stages` |
| notes | v1 | — | `/api/v1/notes` |
| users | v1 | — | `/api/v1/users`, `/api/v1/users/me` |
| files | v1 | — | `/api/v1/files` (+ `/download`, upload multipart) |
| leads | **v1** (CRUD) | **v2** (search) | `/api/v1/leads`, `/api/v2/leads/search` |

Special / verified endpoints:

- Lead → deal conversion (async): `POST /api/v2/leads/{id}/convert/deal` returns a conversion job id.
- Conversion status: `GET /api/v2/leads/{id}/convert/status/{conversion_id}`.
- Global item search: `GET /api/v2/itemSearch?term=&item_types=&fields=&exact_match=` (costs 20 credits).
- Custom-field definitions: `GET /api/v1/{deal,person,organization,product,activity}Fields`.
  Custom fields are addressed by 40-char hex keys, resolved via `pd fields <entity>`.

Auth: `x-api-token` header carries the personal API token. Host is `https://<domain>.pipedrive.com`.

Response envelope: `{ success, data, additional_data, error, error_info }`. The CLI prints `.data`
by default; `--raw` prints the whole envelope.

Pagination:
- v2 — cursor based: request `limit` + `cursor`; follow `additional_data.next_cursor`.
- v1 — offset based: request `start` + `limit`; follow `additional_data.pagination.next_start`
  while `more_items_in_collection` is true.

Sources: official MCP tool list (support.pipedrive.com/en/article/mcp-tools), Pipedrive Developers
API v1/v2 reference (developers.pipedrive.com).
