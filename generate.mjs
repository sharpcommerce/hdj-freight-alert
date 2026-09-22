#!/usr/bin/env node
/*
 * generate.mjs - rebuilds freight-alert.user.js from live Shopify data.
 *
 * Queries every product carrying a shipping-relevant tag, bakes their SKUs +
 * product IDs into the userscript, and (only when that set actually changed)
 * bumps the @version so Tampermonkey auto-updates every installed copy.
 *
 * Tag classes baked into the script:
 *   fr  freight | freefreight | liftgate   ships LTL, rep must quote freight
 *   nf  nofreeshipping                     website charges shipping
 *   cd  condition-deal                     B-Stock / C-Stock / Open Box, also excluded
 *   sd  shippingdiscount                   website charges 50% of the rate
 *   fs  freeshipping                       overrides every exclusion, cart ships free
 *
 * One excluded item removes free shipping from the WHOLE cart, so the script
 * warns at order level, not just on the line.
 *
 * Shipping-cost estimates come from shipping-cost.json (SellerCloud column 192,
 * AVERAGE_SHIPPING_COST, exported via the shipping-margin analysis). They are
 * what turn "do not type Free Shipping" into a number a rep can quote.
 *
 * Auth: this is a Dev Dashboard app, so there is no pasteable shpat_ token to
 * store. Dev Dashboard apps authenticate with the client credentials grant -
 * we exchange the app's Client ID + Secret for a 24h access token at the start
 * of each run. (Sending the client_id/client_secret straight to the GraphQL
 * Admin API is what produces "Invalid API key or access token".)
 *
 * Env vars:
 *   SHOPIFY_STORE          myshopify subdomain    (default: hollywood-djmi)
 *   SHOPIFY_CLIENT_ID      app Client ID          (REQUIRED - not secret)
 *   SHOPIFY_CLIENT_SECRET  app Secret             (REQUIRED - keep secret)
 *   SHOPIFY_ADMIN_TOKEN    legacy shpat_ token    (optional; skips the exchange)
 *   GITHUB_REPOSITORY      owner/repo             (set automatically in Actions)
 *   GITHUB_REF_NAME        branch name            (set automatically in Actions)
 *
 * The app needs the read_products scope on its active version, and must be
 * installed on a store in the SAME Shopify org (otherwise: shop_not_permitted).
 *
 * Run locally:
 *   SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... node generate.mjs
 *
 * Rebuild from a saved catalog snapshot, no credentials needed:
 *   node generate.mjs --from-cache catalog-cache.json
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const STORE = process.env.SHOPIFY_STORE || 'hollywood-djmi';
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const LEGACY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = '2026-07';

// Every tag that changes what the website charges for shipping.
const TAG_QUERY =
  '(tag:nofreeshipping OR tag:condition-deal OR tag:shippingdiscount OR ' +
  'tag:freeshipping OR tag:freight OR tag:freefreight OR tag:liftgate) AND status:active';

// Tag -> short flag baked into the script. Keep these short; they repeat ~2,100 times.
const TAG_FLAGS = {
  nofreeshipping: 'nf',
  'condition-deal': 'cd',
  shippingdiscount: 'sd',
  freeshipping: 'fs',
};
const FREIGHT_TAGS = new Set(['freight', 'freefreight', 'liftgate']);

const OUT_FILE = 'freight-alert.user.js';
const HEARTBEAT_FILE = 'last-checked.json';
const COST_FILE = 'shipping-cost.json';

// Auto-update URLs (self-configuring from the repo it runs in).
const REPO = process.env.GITHUB_REPOSITORY || 'YOUR_GITHUB_USER/hdj-freight-alert';
const BRANCH = process.env.GITHUB_REF_NAME || 'main';
const RAW_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${OUT_FILE}`;

const ENDPOINT = `https://${STORE}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;
const TOKEN_ENDPOINT = `https://${STORE}.myshopify.com/admin/oauth/access_token`;

// Access token for this run. Valid 24h, so one exchange covers the whole job.
let cachedToken = LEGACY_TOKEN || null;

async function getAccessToken() {
  if (cachedToken) return cachedToken;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    // shop_not_permitted means the app and store are in different Shopify orgs.
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${body}`);
  }

  const { access_token, scope, expires_in } = JSON.parse(body);
  if (!access_token) throw new Error(`Token endpoint returned no access_token: ${body}`);

  // scope is a readback of the active app version's scopes - catches the case
  // where the app was installed before read_products was added.
  if (scope && !scope.split(/[,\s]+/).includes('read_products')) {
    throw new Error(
      `App is missing the read_products scope (granted: "${scope}"). ` +
        'Add it to the app version in the Dev Dashboard and approve it on the store.'
    );
  }

  console.log(`Got access token (scope: ${scope || 'unknown'}, expires in ${expires_in || '?'}s).`);
  cachedToken = access_token;
  return cachedToken;
}

export function hashData({ bySku, byId }) {
  return createHash('sha256')
    .update(JSON.stringify({ bySku, byId }))
    .digest('hex')
    .slice(0, 12);
}

async function gql(query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': await getAccessToken(),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error('Shopify GraphQL error: ' + JSON.stringify(json.errors));
  return json.data;
}

// Turn a product's tag list into the sorted flag string baked into the script.
export function flagsFor(tags) {
  const lower = new Set((tags || []).map((t) => String(t).trim().toLowerCase()));
  const flags = new Set();
  for (const [tag, flag] of Object.entries(TAG_FLAGS)) if (lower.has(tag)) flags.add(flag);
  for (const t of FREIGHT_TAGS) if (lower.has(t)) flags.add('fr');
  return [...flags].sort().join(',');
}

// products[] -> { bySku, byId }. Shared by the live fetch and the cache path so
// both produce byte-identical output (and therefore the same DATA-HASH).
export function indexProducts(products) {
  const bySku = {};
  const byId = {};
  for (const p of products) {
    const flags = p.flags !== undefined ? p.flags : flagsFor(p.tags);
    if (!flags) continue;
    byId[p.id] = flags;
    for (const raw of p.skus || []) {
      const sku = String(raw).trim().toUpperCase();
      if (!sku) continue;
      // A SKU seen twice (duplicate listing) keeps the union of its flags, so a
      // warning is never lost to whichever listing happened to be read last.
      bySku[sku] = bySku[sku]
        ? [...new Set([...bySku[sku].split(','), ...flags.split(',')])].sort().join(',')
        : flags;
    }
  }
  const sortKeys = (o) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { bySku: sortKeys(bySku), byId: sortKeys(byId) };
}

async function fetchProducts() {
  const products = [];
  let after = null;
  let page = 0;
  const PAGE_QUERY = `
    query($after: String) {
      products(first: 250, query: ${JSON.stringify(TAG_QUERY)}, after: $after) {
        edges { node { legacyResourceId tags variants(first: 50) { edges { node { sku } } } } }
        pageInfo { hasNextPage endCursor }
      }
    }`;
  do {
    const data = await gql(PAGE_QUERY, { after });
    const conn = data.products;
    for (const { node } of conn.edges) {
      products.push({
        id: node.legacyResourceId,
        tags: node.tags,
        skus: node.variants.edges.map((v) => v.node.sku).filter(Boolean),
      });
    }
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    page++;
    console.log(`  page ${page}: ${conn.edges.length} products (running total ${products.length})`);
  } while (after);
  return products;
}

// Shipping estimates are optional: a missing file just means the banner shows
// the warning without a dollar figure, which is still worth showing.
function loadCosts(bySku) {
  if (!existsSync(COST_FILE)) {
    console.warn(`No ${COST_FILE}; banner will omit shipping estimates.`);
    return {};
  }
  const all = JSON.parse(readFileSync(COST_FILE, 'utf8'));
  const out = {};
  for (const [sku, cost] of Object.entries(all)) {
    const key = sku.toUpperCase();
    // Only ship estimates for SKUs the script can actually match, so the baked
    // map does not carry hundreds of rows the userscript will never look up.
    if (key in bySku) out[key] = cost;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function buildScript({ bySku, byId }, version, dataHash, costs = {}) {
  // One key per line keeps the generated file reviewable in a diff.
  const j = (o) =>
    '{\n' +
    Object.entries(o)
      .map(([k, v]) => '    ' + JSON.stringify(k) + ': ' + JSON.stringify(v))
      .join(',\n') +
    '\n  }';
  return `// ==UserScript==
// @name         Hollywood DJ - Shipping Alert (Draft Orders)
// @namespace    hollywooddj.freight
// @version      ${version}
// @description  Warns the sales team when a draft order / order contains an item the website does NOT ship free - freight (LTL), nofreeshipping, B-Stock/C-Stock/Open Box, or 50%-rate items - and gates $0 shipping behind a confirm. Auto-updates.
// @author       Hollywood DJ
// @match        https://admin.shopify.com/store/*/draft_orders*
// @match        https://admin.shopify.com/store/*/orders*
// @downloadURL  ${RAW_URL}
// @updateURL    ${RAW_URL}
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Auto-generated by generate.mjs from live Shopify data.
 * DO NOT hand-edit; changes are overwritten on the next scheduled build.
 * DATA-HASH: ${dataHash}
 */

(function () {
  'use strict';

  // --- Baked shipping catalog: SKU -> flags -----------------------------------
  // fr freight/LTL | nf nofreeshipping | cd condition-deal | sd 50% | fs ships free
  const SHIP_SKUS = ${j(bySku)};

  // --- Baked shipping catalog: product ID -> flags -----------------------------
  const SHIP_IDS = ${j(byId)};

  // --- SellerCloud shipping estimates (AVERAGE_SHIPPING_COST) ------------------
  const SHIP_COST = ${j(costs)};

  const BANNER_ID = 'hdj-freight-banner';
  const PILL_CLASS = 'hdj-freight-pill';
  const ROW_CLASS = 'hdj-freight-row';
  // A few real SKUs contain a space or a '+' (H-CHAU SLIMPARPROQZ12USB-BS,
  // H-MACK-BIGKNOBSTUDIO+-BS), so the separator class has to allow both. That
  // makes the match greedy enough to swallow the words printed after a SKU,
  // which skusIn() trims back off.
  const SKU_RE = /H-[A-Z0-9]+(?:[-\\/+ ][A-Z0-9.+]+)*/gi;

  // Every SKU present in a piece of line text, resolved against the baked map.
  function skusIn(text) {
    const out = [];
    let m;
    SKU_RE.lastIndex = 0;
    while ((m = SKU_RE.exec(text))) {
      let cand = m[0].toUpperCase();
      // Trim from the right at separator boundaries until it is a real SKU, so
      // "H-QSC-CB10 Compact Battery" still resolves to H-QSC-CB10. The longest
      // match wins, so H-QSC-CB10-BS is never mistaken for H-QSC-CB10.
      while (cand.length > 2) {
        if (SHIP_SKUS[cand]) { out.push(cand); break; }
        let cut = -1;
        for (const sep of ['-', '/', '+', ' ']) cut = Math.max(cut, cand.lastIndexOf(sep));
        if (cut <= 1) break;
        cand = cand.slice(0, cut);
      }
    }
    return out;
  }

  // Worst-first: the pill a line shows when it carries several flags.
  const PILLS = {
    fr: { text: 'FREIGHT / LTL', tone: 'red' },
    nf: { text: 'NO FREE SHIPPING', tone: 'red' },
    cd: { text: 'DEAL - NO FREE SHIP', tone: 'orange' },
    sd: { text: '50% SHIPPING', tone: 'amber' },
    fs: { text: 'SHIPS FREE', tone: 'green' }
  };
  const ORDER = ['fr', 'nf', 'cd', 'sd', 'fs'];
  // Any of these on a line means the website would NOT ship this order free.
  const EXCLUDING = ['fr', 'nf', 'cd', 'sd'];

  function injectStyle() {
    if (document.getElementById('hdj-freight-style')) return;
    const s = document.createElement('style');
    s.id = 'hdj-freight-style';
    s.textContent = \`
      #\${BANNER_ID}{position:sticky;top:0;z-index:2147483000;
        background:#b3261e;color:#fff;font:600 14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;
        padding:12px 16px;box-shadow:0 2px 6px rgba(0,0,0,.25);display:flex;gap:10px;align-items:flex-start}
      #\${BANNER_ID}.hdj-warn{background:#8a5400}
      #\${BANNER_ID} .hdj-x{margin-left:auto;cursor:pointer;font-weight:700;opacity:.85;padding:0 4px}
      #\${BANNER_ID} .hdj-x:hover{opacity:1}
      #\${BANNER_ID} ul{margin:4px 0 0;padding-left:18px;font-weight:500}
      #\${BANNER_ID} .hdj-do{margin-top:6px;font-weight:700}
      .\${ROW_CLASS}{outline:2px solid #b3261e !important;outline-offset:-2px;border-radius:4px}
      .\${ROW_CLASS}.hdj-tone-orange{outline-color:#b35c00 !important}
      .\${ROW_CLASS}.hdj-tone-amber{outline-color:#8a6d00 !important}
      .\${ROW_CLASS}.hdj-tone-green{outline-color:#0b7a3b !important}
      .\${PILL_CLASS}{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:10px;
        background:#b3261e;color:#fff;font:700 10px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;
        letter-spacing:.4px;vertical-align:middle}
      .\${PILL_CLASS}.hdj-tone-orange{background:#b35c00}
      .\${PILL_CLASS}.hdj-tone-amber{background:#8a6d00}
      .\${PILL_CLASS}.hdj-tone-green{background:#0b7a3b}
    \`;
    document.head.appendChild(s);
  }

  function onOrderPage() {
    const p = location.pathname;
    return /\\/draft_orders(\\/|$)/.test(p) || /\\/orders(\\/|$)/.test(p);
  }

  function findHits() {
    const hits = [];
    const seenRows = new Set();
    // Never scan our own banner (its labels contain SKUs and would re-match).
    const banner = document.getElementById(BANNER_ID);
    const inBanner = (el) => !!(banner && el && banner.contains(el));
    // Add one hit per line-item row. A single line can match by BOTH its SKU and
    // its product-ID link; deduping on the row keeps it counted once.
    function add(row, sku, label, flags) {
      if (!flags) return;
      if (row && seenRows.has(row)) return;
      if (row) seenRows.add(row);
      hits.push({ sku: sku, el: row, label: label, flags: flags.split(',') });
    }
    // Strategy 1: match by SKU text shown on the line.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue;
      if (!t || t.indexOf('H-') === -1) continue;
      if (inBanner(n.parentElement)) continue;
      for (const sku of skusIn(t)) {
        add(rowFor(n.parentElement), sku, labelFor(n.parentElement, sku), SHIP_SKUS[sku]);
      }
    }
    // Strategy 2: match by product-ID link (catches lines not already flagged by SKU).
    document.querySelectorAll('a[href*="/products/"]').forEach((a) => {
      if (inBanner(a)) return;
      const m = a.getAttribute('href').match(/\\/products\\/(\\d+)/);
      if (m && SHIP_IDS[m[1]]) {
        add(rowFor(a), null, (a.textContent || '').trim() || ('product ' + m[1]), SHIP_IDS[m[1]]);
      }
    });
    return hits;
  }

  function worstFlag(flags) {
    for (const f of ORDER) if (flags.indexOf(f) !== -1) return f;
    return null;
  }

  function rowFor(el) {
    let cur = el, best = el;
    for (let i = 0; i < 12 && cur && cur !== document.body; i++) {
      const r = cur.getBoundingClientRect ? cur.getBoundingClientRect() : null;
      if (r && r.height > 28 && r.height < 220 && r.width > 260) best = cur;
      if (cur.matches && cur.matches('tr, li, [role="row"]')) return cur;
      cur = cur.parentElement;
    }
    return best;
  }

  function labelFor(el, sku) {
    const row = rowFor(el);
    let txt = (row && row.textContent || '').replace(/\\s+/g, ' ').trim();
    if (txt.length > 90) txt = txt.slice(0, 90) + '\\u2026';
    return txt || sku;
  }

  function decorateRows(hitList) {
    hitList.forEach((h) => {
      if (!h.el || !h.el.nodeType) return;
      const worst = worstFlag(h.flags);
      if (!worst) return;
      const tone = PILLS[worst].tone;
      if (!h.el.classList.contains(ROW_CLASS)) h.el.classList.add(ROW_CLASS, 'hdj-tone-' + tone);
      if (!h.el.querySelector('.' + PILL_CLASS)) {
        const pill = document.createElement('span');
        pill.className = PILL_CLASS + ' hdj-tone-' + tone;
        // A line carrying both nofreeshipping and shippingdiscount behaves as
        // 50% on the website. Flagging it here is how the tag conflict surfaces.
        pill.textContent =
          h.flags.indexOf('nf') !== -1 && h.flags.indexOf('sd') !== -1
            ? '50% SHIPPING (TAG CONFLICT)'
            : PILLS[worst].text;
        (h.el.querySelector('a,span,div') || h.el).appendChild(pill);
      }
    });
  }

  /*
   * Read the shipping amount off the order summary.
   *
   * Deliberately conservative: when the amount cannot be read the gate does not
   * fire. Shopify reshuffles this markup without notice, and a gate that failed
   * closed would stop reps quoting. Failing open only costs us the confirm.
   */
  function readShipping() {
    const banner = document.getElementById(BANNER_ID);
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();

    // Find the leaf element whose whole text is the label "Shipping", then read
    // the value off the row containing it. Matching on the row's combined text
    // instead does not work: Shopify renders the label and the value as
    // adjacent elements, so they concatenate to "ShippingFree shipping" with no
    // separator and no word boundary between them.
    const labels = [];
    document.querySelectorAll('span, div, td, th, p, dt, dd').forEach((el) => {
      if (banner && banner.contains(el)) return;
      if (el.children.length) return;
      if (/^shipping$/i.test(clean(el.textContent))) labels.push(el);
    });

    for (const label of labels) {
      let cur = label.parentElement;
      for (let i = 0; i < 4 && cur; i++, cur = cur.parentElement) {
        if (banner && banner.contains(cur)) break;
        const txt = clean(cur.textContent);
        if (txt.length > 200) break;
        if (/free shipping/i.test(txt)) return { found: true, free: true, amount: 0 };
        const m = txt.match(/\\$\\s*([\\d,]+\\.\\d{2})/);
        if (m) {
          const amount = parseFloat(m[1].replace(/,/g, ''));
          return { found: true, free: amount === 0, amount: amount };
        }
      }
    }
    return { found: false, free: false, amount: null };
  }

  function estimateFor(hitList) {
    let total = 0, known = 0;
    for (const h of hitList) {
      const c = h.sku && SHIP_COST[h.sku];
      if (c) { total += c; known++; }
    }
    return { total: total, known: known };
  }

  function money(n) { return '$' + n.toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','); }

  function renderBanner(hitList, ship) {
    let banner = document.getElementById(BANNER_ID);
    if (!hitList.length) { if (banner) banner.remove(); clearRows(); return; }

    const excluded = hitList.filter((h) => h.flags.some((f) => EXCLUDING.indexOf(f) !== -1));
    const override = hitList.some((h) => h.flags.indexOf('fs') !== -1);
    const est = estimateFor(excluded);
    // Red when the order is actually about to go out underpriced; amber when it
    // is only a heads-up, so a red banner keeps meaning "stop and look".
    const atRisk = excluded.length > 0 && ship.found && ship.free;

    const listItems = excluded.map((h) => {
      const worst = worstFlag(h.flags);
      const cost = h.sku && SHIP_COST[h.sku];
      const label = PILLS[worst] ? PILLS[worst].text : '';
      return '<li>' + esc(h.label) + ' \\u2014 <b>' + esc(label) + '</b>' +
        (cost ? ' \\u2014 est. <b>' + money(cost) + '</b> to ship' : '') + '</li>';
    }).join('');

    let headline;
    if (!excluded.length) {
      headline = 'This order ships free (' + hitList.length + ' item' + (hitList.length > 1 ? 's' : '') + ' tagged freeshipping).';
    } else if (atRisk) {
      headline = 'SHIPPING IS $0 AND THIS ORDER IS NOT ELIGIBLE FOR FREE SHIPPING';
    } else {
      headline = 'THIS ORDER IS NOT ELIGIBLE FOR FREE SHIPPING';
    }

    const note = excluded.length
      ? '<div>One excluded item removes free shipping from the whole cart, so the website would charge for this order.' +
        (override ? ' An item tagged <b>freeshipping</b> is also present, which overrides the exclusion on the website.' : '') +
        '</div>'
      : '';

    const advice = excluded.length
      ? '<div class="hdj-do">Use <u>Get shipping rates</u>. Do not type Free Shipping or $0.' +
        (est.known ? ' Estimated cost for the flagged item' + (est.known > 1 ? 's' : '') + ': <b>' + money(est.total) + '</b>.' : '') +
        '</div>'
      : '';

    const html =
      '<div style="font-size:20px;line-height:1">\\u26A0</div>' +
      '<div><div>' + headline + '</div>' + note +
      '<ul>' + listItems + '</ul>' + advice + '</div>' +
      // No dismiss when the order is actually at risk: that is the one case
      // where hiding the banner is the same as ignoring it.
      (atRisk ? '' : '<div class="hdj-x" title="Hide">\\u2715</div>');

    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      const host = document.querySelector('main') || document.body;
      host.insertBefore(banner, host.firstChild);
    }
    banner.classList.toggle('hdj-warn', !atRisk);
    if (banner.__html !== html) { banner.innerHTML = html; banner.__html = html; }
    const x = banner.querySelector('.hdj-x');
    if (x) x.onclick = () => banner.remove();
  }

  function clearRows() {
    document.querySelectorAll('.' + ROW_CLASS).forEach((e) => {
      e.classList.remove(ROW_CLASS, 'hdj-tone-orange', 'hdj-tone-amber', 'hdj-tone-green');
    });
    document.querySelectorAll('.' + PILL_CLASS).forEach((e) => e.remove());
  }

  function esc(s) { return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /*
   * Soft gate on the buttons that commit the order. Not a hard block: the rep
   * can always continue. It exists so $0 shipping on an excluded item cannot
   * happen by reflex.
   */
  const COMMIT_RE = /^(send invoice|create order|collect payment|mark as paid|charge)/i;

  function onCommitClick(ev) {
    if (!onOrderPage()) return;
    const btn = ev.target && ev.target.closest && ev.target.closest('button, [role="button"], a[href]');
    if (!btn) return;
    const label = (btn.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!COMMIT_RE.test(label)) return;

    const hits = findHits();
    const excluded = hits.filter((h) => h.flags.some((f) => EXCLUDING.indexOf(f) !== -1));
    if (!excluded.length) return;
    const ship = readShipping();
    if (!ship.found || !ship.free) return; // cannot read it, or a real rate is set

    const est = estimateFor(excluded);
    const lines = excluded.slice(0, 6).map((h) => {
      const c = h.sku && SHIP_COST[h.sku];
      return '  \\u2022 ' + h.label.slice(0, 70) + (c ? '  (est. ' + money(c) + ')' : '');
    }).join('\\n');
    const msg =
      'Shipping on this order is $0, but ' + excluded.length + ' item' + (excluded.length > 1 ? 's are' : ' is') +
      ' not eligible for free shipping on the website:\\n\\n' + lines +
      (excluded.length > 6 ? '\\n  \\u2026 and ' + (excluded.length - 6) + ' more' : '') +
      (est.known ? '\\n\\nEstimated shipping cost: ' + money(est.total) : '') +
      '\\n\\nContinue anyway?';

    // confirm() blocks the event dispatch while the dialog is open, so on OK we
    // simply return and the original click carries on to Shopify's own handler.
    // Cancelling first and re-dispatching with btn.click() does not work: the
    // DOM spec's "click in progress" flag makes the nested call a no-op, so the
    // rep would confirm and nothing would happen.
    if (!window.confirm(msg)) {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
    }
  }
  document.addEventListener('click', onCommitClick, true);

  let scheduled = false;
  function scan() {
    scheduled = false;
    if (!onOrderPage()) { const b = document.getElementById(BANNER_ID); if (b) b.remove(); clearRows(); return; }
    injectStyle();
    clearRows();
    const hits = findHits();
    decorateRows(hits);
    renderBanner(hits, readShipping());
  }
  function schedule() { if (!scheduled) { scheduled = true; setTimeout(scan, 250); } }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(schedule, 1500);
  schedule();
})();
`;
}

// --- main --------------------------------------------------------------------
async function main() {
  const cacheArg = process.argv.indexOf('--from-cache');
  const cacheFile = cacheArg !== -1 ? process.argv[cacheArg + 1] : null;

  let products;
  if (cacheFile) {
    // Offline rebuild: lets the script be regenerated (and reviewed) without
    // handing Shopify credentials to whoever is doing the rebuild.
    console.log(`Reading catalog snapshot from ${cacheFile} ...`);
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    products = cache.products.map((p) => ({ id: p.id, flags: (p.f || []).join(','), skus: p.skus }));
  } else {
    if (!LEGACY_TOKEN && !(CLIENT_ID && CLIENT_SECRET)) {
      console.error(
        'ERROR: no credentials. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET ' +
          '(Dev Dashboard > your app > App settings > Credentials), or ' +
          'SHOPIFY_ADMIN_TOKEN for a legacy shpat_ token. ' +
          'To rebuild without credentials: node generate.mjs --from-cache catalog-cache.json'
      );
      process.exit(1);
    }
    console.log(`Fetching shipping-tagged products from ${STORE}.myshopify.com ...`);
    products = await fetchProducts();
  }

  const data = indexProducts(products);
  const nProducts = Object.keys(data.byId).length;
  const nSkus = Object.keys(data.bySku).length;
  const counts = {};
  for (const f of Object.values(data.byId)) for (const k of f.split(',')) counts[k] = (counts[k] || 0) + 1;
  console.log(
    `Total: ${nProducts} products, ${nSkus} SKUs ` +
      `(freight ${counts.fr || 0}, nofreeshipping ${counts.nf || 0}, condition-deal ${counts.cd || 0}, ` +
      `50% ${counts.sd || 0}, freeshipping ${counts.fs || 0}).`
  );

  const costs = loadCosts(data.bySku);
  console.log(`Shipping estimates matched to ${Object.keys(costs).length} of ${nSkus} SKUs.`);

  const dataHash = hashData(data);

  // Decide version: keep it identical if the data is unchanged, else bump the
  // last segment so Tampermonkey sees a newer version.
  let version = '1.2.0';
  let changed = true;
  if (existsSync(OUT_FILE)) {
    const prev = readFileSync(OUT_FILE, 'utf8');
    const prevHash = (prev.match(/DATA-HASH:\s*([0-9a-f]+)/) || [])[1];
    const prevVer = (prev.match(/@version\s+([0-9.]+)/) || [])[1] || '1.2.0';
    if (prevHash === dataHash) {
      console.log('No change in shipping list - nothing to do.');
      changed = false;
      version = prevVer;
    } else {
      const seg = prevVer.split('.');
      seg[seg.length - 1] = String((parseInt(seg[seg.length - 1], 10) || 0) + 1);
      version = seg.join('.');
      console.log(`Shipping list changed - bumping ${prevVer} -> ${version}.`);
    }
  }

  if (changed) {
    writeFileSync(OUT_FILE, buildScript(data, version, dataHash, costs), 'utf8');
    console.log(`Wrote ${OUT_FILE} (v${version}). Auto-update URL: ${RAW_URL}`);
  } else {
    console.log('Output left unchanged.');
  }

  // Heartbeat: proves the sync actually ran. Kept in a separate file on purpose -
  // stamping a date into the userscript would change it every day, churning
  // @version and pushing pointless Tampermonkey updates to the whole sales team.
  writeFileSync(
    HEARTBEAT_FILE,
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        products: nProducts,
        skus: nSkus,
        byFlag: counts,
        costs: Object.keys(costs).length,
        version: version,
        dataHash: dataHash,
        listChanged: changed,
        source: cacheFile ? `cache:${cacheFile}` : 'shopify',
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  console.log(
    `Heartbeat: ${nProducts} products, ${nSkus} SKUs, list ${changed ? 'CHANGED' : 'unchanged'}.`
  );
}

// Run only when executed directly (not when imported).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
