# Mailhop

**Mailhop** — lightweight email alias relay using **Cloudflare Workers** and **D1**.

Mailhop allows you to create simple forwarding aliases under your own domain  
(e.g., `you@example.com`) that automatically route to your real inbox.

It consists of:
- 🧩 **mailhop-api** — REST API for alias management (stored in D1)
- 📬 **mailhop-email** — Email Routing Worker (Cloudflare MX forwarding)
- 💻 **mailhop CLI** — Command-line tool to manage aliases

---

### License

**HOPL (Human-Only Public License)**  
This software may not be used or modified by AI systems, nor used to train or improve
machine learning models. Human developers are free to use, modify, and share it under
the terms of the included HOPL license.
