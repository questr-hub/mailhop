# Mailhop

**Mailhop** — lightweight email alias relay using **Cloudflare Workers** and **D1**.

Mailhop allows you to create simple forwarding aliases under your own domain
(e.g., `you@example.com`) that automatically route to your real inbox.

It consists of:
- 🧩 **mailhop-api** — REST API for alias management (stored in D1)
- 📬 **mailhop-email** — Email Routing Worker (Cloudflare MX forwarding)
- 💻 **mailhop CLI** — Command-line tool to manage aliases

---

## 🚀 Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/questr-hub/mailhop.git
cd mailhop
```

### 2. Copy and configure local Wrangler files

Each worker (API and Email) includes a `wrangler.example.jsonc` file.
Copy and rename it to `wrangler.local.jsonc` before deploying:

```bash
cp workers/api/wrangler.example.jsonc workers/api/wrangler.local.jsonc
cp workers/email/wrangler.example.jsonc workers/email/wrangler.local.jsonc
```

Then edit each `wrangler.local.jsonc` to include your:
- Cloudflare D1 database ID
- Domain name (e.g., `example.com`)

### 3. Run preflight check

Before deploying, confirm both workers are configured correctly:

```bash
mh-preflight
```

### 4. Deploy both workers

```bash
mh-deploy-all
```

This publishes:
- The **API Worker** (`mailhop-api`)
- The **Email Worker** (`mailhop-email`)

### 5. Use the CLI to manage aliases

You can create, list, and delete email aliases using the CLI:

```bash
# List all aliases
mailhop list

# Create a new alias
mailhop create hello@example.com you@inbox.example.net "Personal alias"

# View details
mailhop inspect hello@example.com

# Update alias settings
mailhop update hello@example.com --allow-plus=false

# Delete an alias
mailhop delete hello@example.com
```

### 6. Check recent email routing logs

```bash
mailhop logs 20
```

---

## ⚙️ Requirements

- [Node.js](https://nodejs.org/) v18 or later
- [Cloudflare Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) CLI
- Cloudflare account with:
  - Email Routing enabled
  - D1 database instance
  - MX records configured for your domain

---

## 🔐 Configuration

Mailhop requires two environment variables when running locally:

```bash
export MAILHOP_API_URL="http://localhost:8787"
export MAILHOP_API_TOKEN="your-secret-api-key"
```

- **MAILHOP_API_URL** → the base URL of your Mailhop API Worker
  - Use your deployed Cloudflare Worker URL in production, e.g.
    `https://mailhop-api.example.workers.dev`
  - Default (if not set): `http://localhost:8787`

- **MAILHOP_API_TOKEN** → must match the secret key stored in your API Worker
  - This is used to authenticate CLI requests to your API
  - To set it in Cloudflare, run:
    ```bash
    cd workers/api
    wrangler secret put MAILHOP_API_KEY --config wrangler.local.jsonc
    ```

⚠️ **Important:**

Mailhop never manages or stores secrets on your behalf.
You are responsible for securely setting environment variables and Worker secrets.

---

## 🧠 Overview

Mailhop provides a self-hosted, privacy-friendly alternative to email forwarding services.
It’s fully serverless, runs inside Cloudflare’s global edge network, and requires no traditional hosting.

---

## 🪪 License

**HOPL (Human-Only Public License)**

This software may not be used or modified by AI systems, nor used to train or improve
machine learning models. Human developers are free to use, modify, and share it under
the terms of the included HOPL license.
