# outreach-pipeline

A Node.js CLI that automates cold email outreach in four stages:

1. **Apollo.io** — Find 10 lookalike companies from a seed domain
2. **Prospeo** — Find C-suite/VP decision makers and verified work emails per domain
3. **Safety checkpoint** — Review a summary table and confirm before sending
4. **Brevo** — Send personalized cold outreach emails

## Prerequisites

- Node.js 18+
- API keys for [Apollo.io](https://app.apollo.io/), [Prospeo](https://prospeo.io/), and [Brevo](https://www.brevo.com/)
- A verified sender email in Brevo

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

3. Edit `.env`:

```env
APOLLO_API_KEY=your_apollo_api_key
PROSPEO_API_KEY=your_prospeo_api_key
BREVO_API_KEY=your_brevo_api_key
SENDER_EMAIL=you@yourcompany.com
SENDER_NAME=Your Name
```

## Usage

```bash
node index.js <domain>
```

Example:

```bash
node index.js stripe.com
```

## What happens at each stage

### Stage 1 — Apollo.io

- Enriches the seed company to learn industry, keywords, and employee count
- Searches Apollo for similar companies using matching firmographics
- Returns up to 10 company domains (excluding the seed)

### Stage 2 — Prospeo

- Calls `POST /domain-search` once per domain with `{ "url": "domain.com", "limit": 3 }`
- Returns contacts with emails directly (no per-person enrichment calls)
- Filters results to C-suite/VP decision makers client-side

### Stage 3 — Safety checkpoint

- Prints a table of all prospects
- Prompts: `Do you want to send emails to X prospects? (yes/no)`
- Only continues if you type `yes` exactly

### Stage 4 — Brevo

- Sends a personalized email to each prospect via Brevo's transactional API
- Subject: `Quick question about [Company Name]`
- Body references the prospect's first name and company

## Project structure

```
outreach-pipeline/
├── index.js              # CLI entry point
├── stages/
│   ├── apollo.js         # Stage 1: lookalike company search
│   ├── prospeo.js        # Stage 2: domain search + email enrichment
│   └── brevo.js          # Stage 4: transactional email sending
├── .env.example
├── package.json
└── README.md
```

## Error handling

- Retries on rate limits (HTTP 429) and transient server errors
- Skips domains or contacts with missing data instead of crashing the full run
- Clear console messages for auth failures, missing credits, and API errors

## Notes

- Apollo does not expose a dedicated public "lookalike" endpoint; Stage 1 approximates lookalikes using enriched firmographic filters.
- Prospeo domain-search returns up to 3 contacts per domain in a single API call.
- Ensure your `SENDER_EMAIL` is verified in Brevo before running Stage 4.
- Clone the repo, copy .env.example to .env, fill in your own API keys from Apollo, Prospeo, and Brevo dashboards