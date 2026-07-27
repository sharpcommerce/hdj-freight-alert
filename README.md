# Hollywood DJ - Freight Alert (auto-updating)

Warns the sales team, right inside the Shopify **draft-order editor**, when an
order contains an item that ships by freight (LTL). A red banner appears at the
top of the page and the freight line is outlined in red with a `FREIGHT / LTL`
pill.

The freight list is generated from **every product tagged `freight`,
`freefreight`, or `liftgate`**. A scheduled GitHub Action rebuilds the script
daily; when the list changes, Tampermonkey **auto-updates every installed copy**.
Reps install once from a link and never touch it again.

```
generate.mjs                         ← builds freight-alert.user.js from live Shopify data
.github/workflows/update-freight-alert.yml  ← runs generate.mjs daily, commits on change
freight-alert.user.js                ← the hosted script (created by the first workflow run)
```

---

## One-time setup (~10 minutes)

### 1. Put this folder in a **public** GitHub repo

Create a repo (e.g. `hdj-freight-alert`) and add these files.

> **Why public?** Tampermonkey's auto-update fetches the raw file over the open
> internet, so the file must be publicly reachable. The repo contains only the
> freight SKU list and the script - **no passwords or tokens** (the Shopify
> token lives in encrypted Actions secrets, never in the code).

### 2. Create a Shopify token for the automation

In Shopify admin:

1. **Settings → Apps and sales channels → Develop apps → Create an app**
2. Name it `Freight Alert Sync`
3. **Configure Admin API scopes** → check **`read_products`** → Save
4. **Install app**, then **API credentials → reveal the Admin API access token**
   (starts with `shpat_…`). Copy it.

### 3. Store the token as a repo secret

In the GitHub repo: **Settings → Secrets and variables → Actions → New
repository secret**

- Name: `SHOPIFY_ADMIN_TOKEN`
- Value: the `shpat_…` token

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
SHOPIFY_ADMIN_TOKEN=shpat_xxx SHOPIFY_STORE=hollywood-djmi node generate.mjs
```

Requires Node 18+.
