# MCP Server for YNAB

Talk to your YNAB plan from Claude. This is a small server you deploy to **your own Cloudflare account** (the free plan is enough). Once it's added as a custom connector, Claude can read your accounts, categories and spending, and add or edit transactions for you, on the web, the desktop app and your phone.

> **Not affiliated with YNAB.** The names YNAB and You Need A Budget are trademarks of YNAB. They are used here only to say which service this project works with.

## What Claude can do with it

| Tool | What it does |
| --- | --- |
| `list_plans` | Your plans (formerly "budgets") |
| `get_plan_overview` | Ready to Assign, income, assigned, age of money, overspent categories, account balances |
| `list_accounts` | Accounts and balances |
| `list_categories` | Categories for a month: assigned, activity, available, goal progress |
| `list_payees` | Payees, with optional search |
| `list_transactions` | Transactions by date range, account, category or payee; or only uncategorized/unapproved |
| `get_transaction` | One transaction, including splits |
| `create_transactions` | Add up to 50 transactions at once, including split transactions |
| `update_transaction` | Change any field on one transaction |
| `bulk_update_transactions` | Approve, categorize, clear or flag many transactions at once |
| `delete_transaction` | Delete a transaction |
| `assign_to_category` | Set how much is assigned to a category for a month |
| `set_category_target` | Create, change or remove a category's target: amount, weekly/monthly/yearly repeat, needed-by date, set aside or refill |
| `get_month_history` | Income, assigned, activity, Ready to Assign and age of money for each month in a range, with averages |
| `list_scheduled_transactions` | Scheduled (recurring or future) transactions, soonest first; filter by days ahead, account or payee |
| `create_scheduled_transaction` | Add a recurring or one-time future transaction, or a scheduled transfer between accounts |
| `update_scheduled_transaction` | Change fields on a scheduled transaction (not splits) |
| `delete_scheduled_transaction` | Delete a scheduled transaction |

Accounts and categories can be given by name ("Checking", "Groceries", "Everyday: Groceries"), so you can just say *"Add $42.18 at Costco yesterday to Groceries on my Visa."*

## How it keeps your data private

- **It runs on your Cloudflare account.** Nobody else operates it, and your data only flows between Cloudflare, YNAB and Claude.
- **Your YNAB token is a Cloudflare secret.** It is never in the code or in Git.
- **GitHub sign-in, locked to you.** Claude must sign in through GitHub before it can use the server, and only GitHub usernames listed in `ALLOWED_GITHUB_USERS` are accepted. Everyone else is refused before a token is issued, and checked again on every request.
- **No GitHub permissions are requested.** Sign-in only learns your GitHub username.

Each person should deploy **their own copy with their own YNAB token**. Don't run one copy for other people: YNAB's personal access tokens are for the account owner only.

## Setup (about 20 minutes)

You need: a YNAB account, a free [Cloudflare account](https://dash.cloudflare.com/sign-up), a GitHub account, and [Node.js](https://nodejs.org) 20 or newer.

### 1. Get the code

```bash
git clone https://github.com/ryanlbowen/mcp-server-for-ynab.git
cd mcp-server-for-ynab
npm install
npx wrangler login        # opens a browser to sign in to Cloudflare
```

### 2. Create the storage for sign-in sessions

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copy the `id` it prints into `wrangler.jsonc`, replacing `<Add-KV-ID>`.

### 3. Set your GitHub username

In `wrangler.jsonc`, set `ALLOWED_GITHUB_USERS` to your GitHub username, for example `"octocat"`. (Add more, comma-separated, only for people who share this YNAB account.)

### 4. Deploy once to get your URL

```bash
npm run deploy
```

Wrangler prints your URL, like `https://mcp-server-for-ynab.<your-subdomain>.workers.dev`. In `wrangler.jsonc`, set `MCP_RESOURCE` to that URL **plus `/mcp`**, then deploy again:

```bash
npm run deploy
```

### 5. Create a GitHub OAuth app

On GitHub: **Settings → Developer settings → OAuth Apps → New OAuth App**.

- **Application name:** anything, e.g. "My budget connector"
- **Homepage URL:** `https://mcp-server-for-ynab.<your-subdomain>.workers.dev`
- **Authorization callback URL:** `https://mcp-server-for-ynab.<your-subdomain>.workers.dev/callback`

Create it, then click **Generate a new client secret**. Keep the page open for the next step.

### 6. Add your secrets

Each command asks you to paste a value. Nothing is shown on screen or saved in the project.

```bash
npx wrangler secret put GITHUB_CLIENT_ID        # from the GitHub OAuth app
npx wrangler secret put GITHUB_CLIENT_SECRET    # from the GitHub OAuth app
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # paste the output of: openssl rand -hex 32
npx wrangler secret put YNAB_ACCESS_TOKEN       # see below
```

**YNAB token:** in YNAB on the web, go to **Account Settings → Developer Settings → New Token**. If you sign in to YNAB with Google or Apple, you'll need to set a YNAB password first. Copy the token right away; YNAB only shows it once.

### 7. Add it to Claude

In Claude, go to **Settings → Connectors → Add custom connector**:

- **Name:** YNAB
- **URL:** `https://mcp-server-for-ynab.<your-subdomain>.workers.dev/mcp`

Click **Add**, then **Connect** and sign in with GitHub. In a chat, open the **+** menu → **Connectors** and make sure it's turned on. Try: *"Give me an overview of my budget this month."*

## Good to know

- **Rate limit:** YNAB allows 200 API requests per hour per token. Normal use stays well under that.
- **Amounts:** Claude passes positive amounts with a direction (`outflow` or `inflow`), and the server converts them to YNAB's format, so there's no sign confusion.
- **Dates:** transaction lists default to the last 30 days. Ask for a wider range when you need it.
- **Split transactions:** you can create splits. YNAB's API can't change the amount or category of an existing split, so edit those in YNAB.
- **Changing who can sign in:** edit `ALLOWED_GITHUB_USERS` and run `npm run deploy`. Removed users lose access on their next request.
- **Revoking access:** delete the token in YNAB's Developer Settings, or remove the connector in Claude.

## Updating

```bash
git pull
npm install
npm run deploy
```

## Local development

Create a second GitHub OAuth app with Homepage `http://localhost:8788` and callback `http://localhost:8788/callback`, copy `.dev.vars.example` to `.dev.vars`, fill it in, then run `npm run dev`. Test with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector): `npx @modelcontextprotocol/inspector@latest`, then connect to `http://localhost:8788/mcp`.

## Credits and license

MIT licensed. The sign-in flow is adapted from Cloudflare's [remote-mcp-github-oauth](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-github-oauth) demo (also MIT). See [LICENSE](LICENSE).

This project uses the [YNAB API](https://api.ynab.com) but is not endorsed or certified by YNAB.
