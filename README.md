# Hollywood DJ - Shipping Alert (auto-updating)

Warns the sales team, right inside the Shopify **draft-order editor**, when an
order contains an item the website would **not** ship free. A banner appears at
the top of the page, each offending line is outlined and pilled, and typing $0
shipping on such an order is gated behind a confirm.

Draft orders bypass every website shipping rule, so the rep's typed rate is the
only control. This puts the rule back in front of them at the moment it matters.

### What it flags

| Tag | Pill | What the website does |
|---|---|---|
| `freight` / `freefreight` / `liftgate` | `FREIGHT / LTL` | ships LTL, rep must quote freight |
| `nofreeshipping` | `NO FREE SHIPPING` | charges the full shipping rate |
| `condition-deal` | `DEAL - NO FREE SHIP` | B-Stock / C-Stock / Open Box, also excluded |
| `shippingdiscount` | `50% SHIPPING` | charges half the rate |
| `freeshipping` | `SHIPS FREE` | overrides every exclusion, whole cart ships free |
| `nofreeshipping` + `shippingdiscount` | `50% SHIPPING (TAG CONFLICT)` | behaves as 50%; the tags should be cleaned up |

**One excluded item removes free shipping from the whole cart**, so the banner
warns at order level, not just on the line.

Where a SellerCloud shipping estimate exists, the banner quotes it
("est. $110.15 to ship"). A rep arguing with a customer about shipping needs a
number, not a prohibition.

### The $0 gate

Clicking **Send invoice** / **Create order** / **Collect payment** while
shipping reads $0 and the order holds an excluded item raises a confirm listing
the items and the estimated cost. The rep can always continue - it exists so it
cannot happen by reflex.

It deliberately **fails open**: if the shipping amount cannot be read off the
page, no gate fires. Shopify reshuffles this markup without notice, and a gate
that failed closed would stop reps quoting.

```
generate.mjs                                ← builds freight-alert.user.js from live Shopify data
catalog-cache.json                          ← snapshot for credential-free rebuilds
shipping-cost.json                          ← SKU -> SellerCloud shipping estimate
test/shipping-alert.test.mjs                ← jsdom behaviour tests (npm test)
.github/workflows/update-freight-alert.yml  ← runs generate.mjs daily, commits on change
freight-alert.user.js                       ← the hosted script the sales team installs
```

The filename and `@namespace` are unchanged from the freight-only version on
purpose: every copy already installed auto-updates into this one, so nobody has
to reinstall.

### Rebuilding

```bash
npm test                                          # jsdom behaviour tests
node generate.mjs                                 # live, needs Shopify credentials
node generate.mjs --from-cache catalog-cache.json # offline, no credentials
```

---

## One-time setup (~10 minutes)

### 1. Put this folder in a **public** GitHub repo

Create a repo (e.g. `hdj-freight-alert`) and add these files.

> **Why public?** Tampermonkey's auto-update fetches the raw file over the open
> internet, so the file must be publicly reachable. The repo contains only the
> freight SKU list and the script - **no passwords or tokens** (the Shopify
> token lives in encrypted Actions secrets, never in the code).

### 2. Create the Shopify app for the automation

> **Not the old "Develop apps" flow.** Shopify retired admin-created custom
> apps — you can no longer make one, and there is no **API credentials** tab
> and no pasteable `shpat_…` token. Apps now live in the **Dev Dashboard** and
> authenticate with the client credentials grant, exchanging a Client ID +
> Secret for a 24-hour token on each run. `generate.mjs` does that exchange.

In the [Dev Dashboard](https://dev.shopify.com/dashboard):

1. **Apps → Create app**, name it `Freight Alert Sync`
2. On the app's **version**, select the **`read_products`** scope, then release it
3. **Install app** onto the store — it must be in the **same Shopify org** as the
   app, or the token exchange fails with `shop_not_permitted`
4. **App settings → Credentials** → copy the **Client ID** and the **Secret**

> Ignore the **App automation token** panel on that page. Despite saying "for
> CI/CD workflows", it authenticates the *Shopify CLI*, not Admin API requests.
> Using it (or the Secret directly) gives `Invalid API key or access token`.

### 3. Store the secret in the repo

The **Client ID is not a secret** (Shopify documents it as safe to expose) and
is set directly in `.github/workflows/update-freight-alert.yml`. Only the Secret
needs protecting.

In the GitHub repo: **Settings → Secrets and variables → Actions → New
repository secret**

- Name: `SHOPIFY_CLIENT_SECRET`
- Value: the **Secret** from App settings → Credentials

If you ever rotate the Secret in the Dev Dashboard, update this secret to match.

### 4. Build it once

Go to the repo's **Actions** tab → **Update Freight Alert** → **Run workflow**.
This creates `freight-alert.user.js` with the correct auto-update links.

### 5. Get the install link

Open `freight-alert.user.js` in the repo → click **Raw** → copy that URL. It
looks like:

```
https://raw.githubusercontent.com/<you>/hdj-freight-alert/main/freight-alert.user.js
```

That link is what the sales team installs (see below). From now on it stays
current on its own.

---

## Rolling it out to the sales team

Each rep, once per computer:

1. Install the **Tampermonkey** Chrome extension.
2. Turn on **Developer mode** at `chrome://extensions` (top-right toggle).
3. **Click the install link** from step 5 above → Tampermonkey opens an install
   page → click **Install**.

Done. It auto-updates daily - no reinstalling when the freight list changes.

*(The `Sales Team Install` folder has a printable guide; once you have the
install link, that guide's Step 3 becomes "click this link" instead of copy/paste.)*

---

## How updates work

- The Action runs daily (`cron` in the workflow - currently 13:00 UTC / ~6am PT).
- `generate.mjs` re-queries Shopify. If the freight set is **unchanged**, it does
  nothing. If it **changed**, it bumps the `@version` and commits.
- Tampermonkey checks the `@updateURL` about once a day and pulls new versions
  automatically.
- To force an update immediately: Actions tab → **Run workflow**, then in
  Tampermonkey → dashboard → the script → **Check for updates**.

## Running the generator locally (optional)

```bash
SHOPIFY_CLIENT_ID=xxx SHOPIFY_CLIENT_SECRET=yyy node generate.mjs
```

Requires Node 18+. `SHOPIFY_STORE` defaults to `hollywood-djmi`.

Writes `last-checked.json` on every run (the heartbeat that proves the sync is
alive) and rewrites `freight-alert.user.js` only when the freight list actually
changed.

---

## Draft Order Product Filter

A second, separate script for the same sales team. `draft-product-filter.user.js`
keeps packages, kits, and open-box / B-Stock / C-Stock listings out of the
product search on draft orders, so reps can find the single item they need.
Adding `pkg` to a search, or clicking "show everything" in the blue note the
script adds, shows everything again. Nothing in Shopify changes.

It works from rules (product types, title words, tags, SKU suffixes), so unlike
the freight list it needs no Shopify token and no scheduled rebuild.

Install link (with Tampermonkey installed, opening it shows the install page):

```
https://raw.githubusercontent.com/sharpcommerce/hdj-freight-alert/main/draft-product-filter.user.js
```

To ship a change: update the script, bump its `@version`, and push it here.
Installed copies update within about a day.
