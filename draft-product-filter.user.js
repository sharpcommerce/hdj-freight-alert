// ==UserScript==
// @name         Hollywood DJ - Draft Order Product Filter
// @namespace    hollywooddj.draftfilter
// @version      1.0.0
// @description  Hides packages, kits, and open-box / B-Stock / C-Stock listings from the product search on Shopify draft orders so single items are easy to find. Add pkg to the search, or click "show everything", to see them.
// @author       Hollywood DJ
// @match        https://admin.shopify.com/store/hollywood-djmi*
// @downloadURL  https://raw.githubusercontent.com/sharpcommerce/hdj-freight-alert/main/draft-product-filter.user.js
// @updateURL    https://raw.githubusercontent.com/sharpcommerce/hdj-freight-alert/main/draft-product-filter.user.js
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @inject-into  page
// @noframes
// ==/UserScript==

/*
 * How it works
 * ------------
 * The "Select products" picker on a draft order sends each search to Shopify as
 * one GET request (operation ProductResourcePicker, audit scope
 * DRAFT_ORDER_PRODUCT_PICKER). This script adds exclusion terms to that
 * request's search string, so Shopify leaves packages, kits, and condition
 * listings out of the results and each page still fills with real items. It
 * then drops the few HDJ kits the search syntax cannot describe (-KIT SKUs,
 * "& Kit" titles, open-box SKUs with plain titles) from the response.
 *
 * Nothing is hidden when the search contains the word "pkg" (or "showall"),
 * which the script removes before the search goes to Shopify, so "K12.2 pkg"
 * lists everything matching K12.2. The "show everything" link adds "pkg" to the
 * search box. Nothing is hidden either when the search asks for a package, kit,
 * or open-box unit by name, or is an exact SKU.
 *
 * Nothing in the catalog changes. Other pickers (collections, discounts,
 * purchase orders) and every other admin page are untouched. If Shopify changes
 * or rejects the request, the script steps aside, the blue note stays away, and
 * the picker behaves exactly as it does without the script.
 */
(function () {
  'use strict';

  const OPERATION = 'ProductResourcePicker';
  const SCOPE = 'DRAFT_ORDER_PRODUCT_PICKER';

  // Sent to Shopify with every draft-order product search. Verified 2026-09-14:
  // each term removes the listings it names and nothing else.
  const EXCLUDE_TERMS = [
    'product_type:"Speaker Package"',
    'product_type:"DJ Package"',
    'product_type:"DJ Lighting Package"',
    'product_type:"Truss Packages"',
    'product_type:"Cable Package"',
    'product_type:"Podcast Bundle"',
    'product_type:"DJ Mixer Packages"',
    'title:pkg',
    'title:package',
    'title:bundle',
    'tag:"Open Box"',
    'tag:"B-stock"',
    'tag:"C-Stock"',
    'tag:"condition-deal"',
  ];
  const EXCLUDE_QUERY = EXCLUDE_TERMS.map((term) => '-' + term).join(' ');

  // Checked in the browser against each result, for what search syntax can't say.
  // Real accessories ("Mount Kit", "Rackmount Kit", "Eyebolt Kit") do not match.
  const HIDE_TITLE = [
    /&\s*kit\b|\bkit\s*&/i, // "... - 6-Pack & Kit", "... - Kit & 3-Pack"
    /\bopen[\s-]?box\b|\b[bc]-stock\b/i, // condition wording in the title
    /\b(pkg|packages?|bundle)\b/i,
  ];
  const KIT_SKU = /-KIT\d*$/i; // H-CHAU-H1600-KIT4
  const CONDITION_SKU = /-(OB|BS|CS)$/i; // H-QSC-K122-OB; model numbers like H-RCF-BS8 don't match

  // "pkg" or "showall" turns the filter off for that search and is removed first.
  const SHOW_ALL_WORD = /(^|\s)(pkgs?|showall)(?=\s|$)/i;
  const hasShowAll = (text) => SHOW_ALL_WORD.test(text);
  const stripShowAll = (text) =>
    String(text).replace(/(^|\s+)(pkgs?|showall)(?=\s|$)/gi, '').trim();

  // A search naming one of these asks for the package, kit, or open-box unit. The
  // words stay in the search; nothing is hidden.
  const WANTS_HIDDEN = /\b(packages?|pack|pak|bundles?|kits?|combo|open\s?box|openbox|[bc]-?stock)\b/i;
  const EXACT_SKU = /(^|[\s:])H(DJ)?-[A-Z0-9]+-/i; // H-QSC-K122..., also after "sku:"

  // What the salesperson typed, minus the filters the picker adds on its own.
  function typedText(searchQuery) {
    return String(searchQuery)
      .replace(/\bstatus:\S+/gi, '')
      .replace(/\bcombined_listing_role:"[^"]*"/gi, '')
      .replace(/\\/g, '') // the picker backslash-escapes punctuation: K12\.2
      .replace(/\s+/g, ' ')
      .trim();
  }

  function wantsEverything(searchQuery) {
    const typed = typedText(searchQuery);
    return WANTS_HIDDEN.test(typed) || EXACT_SKU.test(typed) || /\b(product_type|tag):/i.test(typed);
  }

  function withVariables(u, vars) {
    const params = [];
    u.searchParams.forEach((value, key) => {
      const v = key === 'variables' ? JSON.stringify(vars) : value;
      params.push(encodeURIComponent(key) + '=' + encodeURIComponent(v));
    });
    return u.origin + u.pathname + '?' + params.join('&');
  }

  // null: not the draft-order picker search.
  // {filter: false}: send it unchanged. {filter: false, url}: send url, hide nothing.
  // {filter: true, url}: send url (exclusions added), then trim the response.
  function planRequest(url, base) {
    let u;
    try {
      u = new URL(url, base);
    } catch (e) {
      return null;
    }
    if (u.searchParams.get('operationName') !== OPERATION) return null;
    let vars;
    try {
      vars = JSON.parse(u.searchParams.get('variables'));
    } catch (e) {
      return null;
    }
    if (!vars || vars.auditTrailScope !== SCOPE || typeof vars.productsSearchQuery !== 'string') {
      return null;
    }
    const query = vars.productsSearchQuery;
    if (hasShowAll(typedText(query))) {
      vars.productsSearchQuery = stripShowAll(query);
      return {filter: false, url: withVariables(u, vars)};
    }
    if (wantsEverything(query)) return {filter: false};
    vars.productsSearchQuery = query + ' ' + EXCLUDE_QUERY;
    return {filter: true, url: withVariables(u, vars)};
  }

  function isHiddenProduct(product) {
    if (!product) return false;
    const title = String(product.title || '');
    if (HIDE_TITLE.some((re) => re.test(title))) return true;
    const skus = ((product.variants && product.variants.edges) || [])
      .map((edge) => (edge && edge.node && edge.node.sku) || '')
      .filter(Boolean);
    return skus.length > 0 && skus.every((sku) => KIT_SKU.test(sku) || CONDITION_SKU.test(sku));
  }

  // Drops hidden products from a picker response body in place; returns how many.
  function removeHidden(body) {
    const products = body && body.data && body.data.products;
    if (!products || !Array.isArray(products.edges)) return 0;
    const before = products.edges.length;
    products.edges = products.edges.filter((edge) => !isHiddenProduct(edge && edge.node));
    return before - products.edges.length;
  }

  // Which message the hint shows, from what is in the search box right now.
  function hintState(boxText) {
    const text = String(boxText || '');
    if (hasShowAll(text)) return 'everything';
    if (EXACT_SKU.test(text)) return 'sku';
    if (WANTS_HIDDEN.test(text)) return 'asked';
    return 'hiding';
  }

  if (typeof window === 'undefined') {
    // Loaded by the Node test suite rather than a browser.
    module.exports = {
      EXCLUDE_QUERY,
      typedText,
      wantsEverything,
      planRequest,
      isHiddenProduct,
      removeHidden,
      hintState,
      stripShowAll,
    };
    return;
  }

  // ---------------------------------------------------------------------------
  // Browser wiring
  // ---------------------------------------------------------------------------

  const nativeFetch = window.fetch;
  let intercepting = false; // true once a picker search has passed through this script

  function trimmed(response, runUnfiltered) {
    if (!response.ok) return runUnfiltered();
    return response
      .clone()
      .json()
      .then(
        (body) => {
          try {
            if (!body || !body.data || !body.data.products) return runUnfiltered();
            if (!removeHidden(body)) return response;
            const headers = new Headers(response.headers);
            headers.delete('content-length');
            headers.delete('content-encoding');
            return new Response(JSON.stringify(body), {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          } catch (e) {
            return response;
          }
        },
        () => response,
      );
  }

  window.fetch = function (input, init) {
    let plan = null;
    try {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      if (url && url.indexOf(OPERATION) !== -1) plan = planRequest(url, location.href);
    } catch (e) {
      plan = null;
    }
    if (plan) intercepting = true;
    if (!plan || !plan.url) return nativeFetch.apply(window, arguments);
    const request = input instanceof Request ? new Request(plan.url, input) : plan.url;
    const sent = nativeFetch.call(window, request, init);
    if (!plan.filter) return sent;
    const args = arguments;
    return sent.then((response) => trimmed(response, () => nativeFetch.apply(window, args)));
  };

  const HINT_ID = 'hdj-draft-filter-hint';
  const HINTS = {
    hiding:
      '<b>Packages, kits &amp; open box are hidden.</b> Add <i>pkg</i> to your search to ' +
      'include them, or <button type="button" data-hdj="show">show everything</button>.',
    asked: 'Showing packages, kits &amp; open box because your search asks for them.',
    sku: 'Exact SKU search: nothing is hidden.',
    everything:
      'Showing everything. <button type="button" data-hdj="hide">Hide packages, kits &amp; open box</button>',
  };

  function pickerSearchInput() {
    if (location.pathname.indexOf('/draft_orders') === -1) return null;
    for (const input of document.querySelectorAll('input[placeholder="Search products"]')) {
      const modal = input.closest('s-internal-modal, [role="dialog"]');
      if (modal && modal.textContent.indexOf('Select products') !== -1) return input;
    }
    return null;
  }

  function renderHint() {
    const input = intercepting ? pickerSearchInput() : null;
    let hint = document.getElementById(HINT_ID);
    if (!input) {
      if (hint) hint.remove();
      return;
    }
    const anchor =
      input.closest('.Polaris-InlineStack') ||
      input.closest('.Polaris-Filters__SearchField') ||
      input.parentElement;
    if (!hint) {
      hint = document.createElement('div');
      hint.id = HINT_ID;
      hint.style.cssText =
        'margin:8px 0 2px;padding:7px 10px;border-radius:8px;background:#eaf4ff;' +
        'border:1px solid #c5dffc;color:#123b69;' +
        'font:500 12.5px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;';
      hint.addEventListener('click', onHintClick);
    }
    if (anchor.nextElementSibling !== hint) anchor.insertAdjacentElement('afterend', hint);
    const html = HINTS[hintState(input.value)];
    if (hint.__hdjHtml !== html) {
      hint.innerHTML = html;
      hint.__hdjHtml = html;
      hint.querySelectorAll('button').forEach((b) => {
        b.style.cssText =
          'background:none;border:0;padding:0;margin:0;color:#005bd3;' +
          'text-decoration:underline;cursor:pointer;font:inherit;';
      });
    }
  }

  // Replaces the search box text the way typing would, so the picker searches again.
  function setSearchBox(input, value) {
    input.focus();
    input.select();
    const typed = value
      ? document.execCommand('insertText', false, value)
      : document.execCommand('delete', false);
    if (!typed || input.value !== value) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', {bubbles: true}));
    }
  }

  function onHintClick(event) {
    const action = event.target && event.target.getAttribute && event.target.getAttribute('data-hdj');
    const input = action && pickerSearchInput();
    if (!input) return;
    event.preventDefault();
    event.stopPropagation();
    const typed = stripShowAll(input.value);
    setSearchBox(input, action === 'show' ? (typed + ' pkg').trim() : typed);
    renderHint();
  }

  let queued = false;
  function queueRender() {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      renderHint();
    }, 150);
  }
  new MutationObserver(queueRender).observe(document, {childList: true, subtree: true});
  document.addEventListener('input', queueRender, true);
})();
