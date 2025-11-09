# Mailhop

**Mailhop** — lightweight email alias relay using **Cloudflare Workers** and **D1**.

Mailhop allows you to create simple forwarding aliases under your own domain
(e.g., `you@example.com`) that automatically route to your real inbox.

It consists of:
- 🧩 **mailhop-api** — REST API for alias management (stored in D1)
- 📬 **mailhop-email** — Email Routing Worker (Cloudflare MX forwarding)
- 💻 **mailhop CLI** — Command-line tool to manage aliases and deployments

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

### 3. Configure environment variables for the CLI

```bash
export MAILHOP_API_URL="http://localhost:8787"
export MAILHOP_API_TOKEN="your-secret-api-key"
export MAILHOP_ROOT="$HOME/proj/mailhop"
```

- `MAILHOP_API_URL` → base URL of your Mailhop **API Worker**
  - Local development: `http://localhost:8787` (Wrangler dev)
  - Production: your deployed Cloudflare Worker URL (e.g. `https://mailhop-api.example.workers.dev`)
- `MAILHOP_API_TOKEN` → must match the `MAILHOP_API_KEY` secret in your Cloudflare Worker
- `MAILHOP_ROOT` → path to your Mailhop project root (default: current directory)

### 4. Run preflight checks

```bash
mailhop preflight
```

This validates your worker configurations and confirms that your database IDs and domains are set correctly.

### 5. Deploy both workers

```bash
mailhop deploy-all
```

This publishes:
- The **API Worker** (`mailhop-api`)
- The **Email Worker** (`mailhop-email`)

### 6. Manage aliases using the CLI

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

### 7. View recent email routing logs

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

Mailhop requires environment variables for the CLI to connect to your **API Worker**:

```bash
export MAILHOP_API_URL="https://mailhop-api.example.workers.dev"
export MAILHOP_API_TOKEN="your-secret-api-key"
```

- **MAILHOP_API_URL** → the base URL of your *Mailhop API Worker*
  (This is the URL Cloudflare assigns when you deploy the API Worker.)
  Example: `https://mailhop-api.example.workers.dev`

- **MAILHOP_API_TOKEN** → must match the secret key (`MAILHOP_API_KEY`) set in your API Worker
  To set it in Cloudflare, run:
  ```bash
  cd workers/api
  wrangler secret put MAILHOP_API_KEY --config wrangler.local.jsonc
  ```

> You do **not** need to configure an environment variable for the Email Worker — Cloudflare automatically routes incoming email to it once your MX records are configured.

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
