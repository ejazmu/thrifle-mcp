# Thrifle MCP server

**US return policies, price-match rules, discounts, deals, credit-card terms and Amazon buy-or-wait verdicts — as read-only tools for Claude, ChatGPT, Cursor and any MCP client.**

```
https://api.thrifle.com/api/mcp
```

No auth. No signup. 24 tools. Every answer links to the thrifle.com page it comes from.

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Thrifle_MCP-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=thrifle&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fapi.thrifle.com%2Fapi%2Fmcp%22%7D)
[![Add to Cursor](https://img.shields.io/badge/Cursor-Add_Thrifle_MCP-000000?style=flat-square&logo=cursor&logoColor=white)](https://cursor.com/install-mcp?name=thrifle&config=eyJ1cmwiOiJodHRwczovL2FwaS50aHJpZmxlLmNvbS9hcGkvbWNwIn0=)
[![Docs](https://img.shields.io/badge/docs-thrifle.com%2Fmcp-E62E3C?style=flat-square)](https://thrifle.com/mcp)
[![Tests](https://github.com/ejazmu/thrifle-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/ejazmu/thrifle-mcp/actions/workflows/test.yml)

## What you can ask

| Tool | Example |
|---|---|
| `get_return_policy` | What is Costco's return policy on a laptop? |
| `compare_return_policies` | Is it easier to return to Target or Walmart? |
| `search_return_policies` | Which furniture stores offer free returns? |
| `get_price_match_policy` | Does Best Buy price match Amazon? |
| `who_will_price_match` | Who will match this Amazon price on a TV? |
| `get_merchant_discounts` · `search_discounts` | Does Home Depot have a military discount? |
| `get_cancellation_guide` | How do I cancel Planet Fitness? |
| `get_birthday_freebie` · `search_birthday_freebies` | What does Starbucks give you on your birthday? |
| `search_deals` · `get_deal` · `get_deal_of_the_day` · `get_store_deals` | Is there a deal on AirPods Pro right now? |
| `predict_amazon_price` | Should I buy this Amazon product now or wait? |
| `search_credit_cards` · `get_credit_card` · `get_store_credit_cards` | Does the Lowe's card use deferred interest? |
| `get_money_monitor` · `get_price_pulse` | What is the average credit-card APR right now? |
| `check_product_recalls` | Has this product been recalled? |
| `about_thrifle` | What is Thrifle and what does it cover? |

The data behind these tools: a return-policy database covering 2,250 US retailers with an A+–D− grade computed from the policy's own terms, price-match and price-adjustment policies, military/student discount programmes, birthday offers, cancellation guides, a curated deal feed, a credit-card database built from issuer pricing pages, and price history for hundreds of thousands of Amazon products. All of it is editor-verified and every record carries a `last_verified` date.

## Connect it

**Claude.ai / Claude Desktop** (every plan; Free allows one custom connector)
Settings → Connectors → Add custom connector → paste the URL → leave authentication empty.

**Claude Code**
```sh
claude mcp add --transport http thrifle https://api.thrifle.com/api/mcp
```

**ChatGPT** — Settings → Apps & Connectors → Create (developer mode) → paste the URL, no authentication.

**Cursor** — click the badge above, or add to `~/.cursor/mcp.json`:
```json
{ "mcpServers": { "thrifle": { "url": "https://api.thrifle.com/api/mcp" } } }
```

**VS Code** — click the badge above, or `code --add-mcp '{"name":"thrifle","type":"http","url":"https://api.thrifle.com/api/mcp"}'`.

**Perplexity** (+ Custom connector → Remote), **Grok** (grok.com/connectors → Custom), **Mistral Le Chat** (Connectors → Custom MCP Connector), **Gemini CLI** (`httpUrl` under `mcpServers`), **Gemini Enterprise** (Manage team → Connected apps → Add MCP Server) all accept the same URL.

**Claude Code plugin** — this repo is also a Claude Code plugin (`.claude-plugin/plugin.json`, `.mcp.json`, and a `thrifle-shopping` skill that teaches the model which tool answers which question).

## Try it from a terminal

```sh
curl -s https://api.thrifle.com/api/mcp | jq .tools

curl -s -X POST https://api.thrifle.com/api/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_return_policy","arguments":{"merchant":"Costco"}}}'
```

## Run it yourself

```sh
git clone https://github.com/ejazmu/thrifle-mcp && cd thrifle-mcp
npm install
npm start          # http://127.0.0.1:8787/mcp, reading Thrifle's public API
npm test           # 17 protocol + shaping fixtures, no network needed
```

This is the same code that serves `api.thrifle.com/api/mcp`. `THRIFLE_API_BASE` points it at a different API base; `MCP_RATE_PER_MIN` / `MCP_RATE_PER_DAY` set the per-IP limits; `MCP_API_KEYS` (comma-separated) lists keys that bypass them via `Authorization: Bearer`.

## How it is built

- **Stateless Streamable HTTP.** One `McpServer` + transport per request, JSON responses, no sessions — nothing to resume, nothing shared between callers, nothing for a CDN to buffer. `GET` on the endpoint returns a human-readable discovery document.
- **Tools call Thrifle's public REST API, never a database.** That keeps the MCP answer identical to the website's answer: affiliate-link handling, expired-deal rules and serve-time grading all apply automatically. `src/api-client.js` is a 60-line loopback `fetch`.
- **Shapers, not raw payloads.** `src/shape.js` turns each API response into the facts plus the canonical thrifle.com `url` and a `cite` block, and drops internal fields. Pure functions, all covered by fixtures.
- **Read-only by construction.** Every tool declares `readOnlyHint: true`; the catalogue in `src/tools.js` has no write path.
- **Price verdicts never trigger a live fetch** — they read the tracked-price database only.

## Fair use and licensing

Free for assistants answering a person's question: 60 calls a minute and 1,500 a day per address. Bulk or commercial use is licensed — see [thrifle.com/data-licensing](https://thrifle.com/data-licensing); a licence comes with a key that lifts the limits. Deal `buy_url` values are thrifle.com redirects and may be affiliate links.

## Links

Docs: https://thrifle.com/mcp · Return-policy database: https://thrifle.com/return-policy · Price Predict: https://thrifle.com/price-predict · Money: https://thrifle.com/money · Contact: hello@thrifle.com

MIT licensed. © 2026 Thrifle Technologies LLC.
