/*
 * Loads the generated userscript into a simulated Shopify draft-order page and
 * checks the behaviour that matters: does the banner appear, does it turn red
 * only when the order is actually about to go out at $0, and does the commit
 * gate fire (and only fire) in that case.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const SCRIPT = readFileSync(
  new URL('../freight-alert.user.js', import.meta.url),
  'utf8'
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '\n         ' + detail : ''));
  }
}

// line: a draft-order line item. shipping: the text in the Shipping summary row.
function page({ lines, shipping }) {
  const rows = lines
    .map(
      (l) =>
        `<tr><td><a href="/store/hollywood-djmi/products/${l.id}">${l.title}</a></td>` +
        `<td>${l.sku}</td><td>$${l.price}</td></tr>`
    )
    .join('');
  return `<!doctype html><html><body><main>
    <table><tbody>${rows}</tbody></table>
    <div><span>Subtotal</span><span>$1,000.00</span></div>
    <div><span>Shipping</span><span>${shipping}</span></div>
    <div><span>Total</span><span>$1,000.00</span></div>
    <button type="button">Send invoice</button>
    <button type="button">Add custom item</button>
  </main></body></html>`;
}

async function load(html, { confirmReturns = true } = {}) {
  const dom = new JSDOM(html, {
    url: 'https://admin.shopify.com/store/hollywood-djmi/draft_orders/1234567890',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const calls = [];
  dom.window.confirm = (msg) => {
    calls.push(msg);
    return confirmReturns;
  };
  dom.window.eval(SCRIPT);
  await sleep(400); // the script debounces its first scan by 250ms
  return { dom, w: dom.window, d: dom.window.document, confirms: calls };
}

const GIGBAR = { id: '8105758654717', sku: 'H-CHAU-CHSGBM', title: 'Chauvet DJ CHS-GBM Hard Travel Case', price: '249.99' };
const GIGBAR_CS = { id: '8154395214077', sku: 'H-CHAU-CHSGBM-CS', title: 'C-Stock: Chauvet DJ CHS-GBM Hard Travel Case', price: '199.99' };
const CLEAN = { id: '1111111111111', sku: 'H-FAKE-NOTTAGGED', title: 'Some Untagged Product', price: '99.00' };

console.log('\n1. Excluded item + $0 shipping -> red banner, no dismiss');
{
  const { d } = await load(page({ lines: [GIGBAR_CS], shipping: 'Free shipping' }));
  const b = d.getElementById('hdj-freight-banner');
  check('banner rendered', !!b);
  check('headline names the $0 risk', !!b && /SHIPPING IS \$0/.test(b.textContent), b && b.textContent.slice(0, 120));
  check('banner is red (not the amber heads-up)', !!b && !b.classList.contains('hdj-warn'));
  check('no dismiss control while at risk', !!b && !b.querySelector('.hdj-x'));
  check('tells the rep what to do', !!b && /Get shipping rates/.test(b.textContent));
  check('line is pilled', !!d.querySelector('.hdj-freight-pill'));
}

console.log('\n2. Excluded item + a real shipping rate -> amber heads-up, dismissable');
{
  const { d } = await load(page({ lines: [GIGBAR_CS], shipping: '$110.15' }));
  const b = d.getElementById('hdj-freight-banner');
  check('banner rendered', !!b);
  check('headline is the plain not-eligible warning', !!b && /THIS ORDER IS NOT ELIGIBLE/.test(b.textContent) && !/SHIPPING IS \$0/.test(b.textContent));
  check('banner is amber', !!b && b.classList.contains('hdj-warn'));
  check('dismiss control present', !!b && !!b.querySelector('.hdj-x'));
}

console.log('\n3. No flagged items -> no banner at all');
{
  const { d } = await load(page({ lines: [CLEAN], shipping: 'Free shipping' }));
  check('no banner', !d.getElementById('hdj-freight-banner'));
  check('no pills', !d.querySelector('.hdj-freight-pill'));
}

console.log('\n4. Commit gate fires on Send invoice when shipping is $0');
{
  const { d, confirms } = await load(page({ lines: [GIGBAR_CS], shipping: 'Free shipping' }), { confirmReturns: false });
  const btn = [...d.querySelectorAll('button')].find((b) => /Send invoice/.test(b.textContent));
  let reached = false;
  btn.addEventListener('click', () => { reached = true; });
  btn.click();
  check('confirm was shown', confirms.length === 1, 'confirms=' + confirms.length);
  check('confirm names the item', confirms.length > 0 && /CHS-GBM/.test(confirms[0]));
  check('declining blocks the click', reached === false);
}

console.log('\n5. Confirming lets the click through exactly once');
{
  const { d, confirms } = await load(page({ lines: [GIGBAR_CS], shipping: 'Free shipping' }), { confirmReturns: true });
  const btn = [...d.querySelectorAll('button')].find((b) => /Send invoice/.test(b.textContent));
  let reached = 0;
  btn.addEventListener('click', () => { reached++; });
  btn.click();
  check('confirm was shown once', confirms.length === 1, 'confirms=' + confirms.length);
  check('click reached the page once, no loop', reached === 1, 'reached=' + reached);
}

console.log('\n6. Gate does NOT fire when a real rate is set');
{
  const { d, confirms } = await load(page({ lines: [GIGBAR_CS], shipping: '$110.15' }));
  const btn = [...d.querySelectorAll('button')].find((b) => /Send invoice/.test(b.textContent));
  let reached = false;
  btn.addEventListener('click', () => { reached = true; });
  btn.click();
  check('no confirm', confirms.length === 0);
  check('click passed straight through', reached === true);
}

console.log('\n7. Gate does NOT fire on unrelated buttons');
{
  const { d, confirms } = await load(page({ lines: [GIGBAR_CS], shipping: 'Free shipping' }));
  const btn = [...d.querySelectorAll('button')].find((b) => /Add custom item/.test(b.textContent));
  btn.click();
  check('no confirm on a non-commit button', confirms.length === 0);
}

console.log('\n8. Shipping amount cannot be read -> fails open (no gate), banner still shows');
{
  const html = page({ lines: [GIGBAR_CS], shipping: 'Free shipping' }).replace(
    '<div><span>Shipping</span><span>Free shipping</span></div>',
    '<div><span>Delivery estimate</span><span>unknown</span></div>'
  );
  const { d, confirms } = await load(html);
  const btn = [...d.querySelectorAll('button')].find((b) => /Send invoice/.test(b.textContent));
  let reached = false;
  btn.addEventListener('click', () => { reached = true; });
  btn.click();
  check('banner still warns', !!d.getElementById('hdj-freight-banner'));
  check('no gate when the rate is unreadable', confirms.length === 0);
  check('rep is not blocked', reached === true);
}

console.log('\n9. shippingdiscount item shows the 50% pill, still counts as not-free');
{
  const { d } = await load(page({ lines: [GIGBAR], shipping: 'Free shipping' }));
  const pill = d.querySelector('.hdj-freight-pill');
  check('pill reads 50% SHIPPING', !!pill && pill.textContent === '50% SHIPPING', pill && pill.textContent);
  const b = d.getElementById('hdj-freight-banner');
  check('still flagged as $0 risk', !!b && /SHIPPING IS \$0/.test(b.textContent));
}

console.log('\n10. Shipping estimate is quoted in the banner');
{
  const { d } = await load(page({ lines: [GIGBAR], shipping: 'Free shipping' }));
  const b = d.getElementById('hdj-freight-banner');
  check('banner shows the $110.15 estimate', !!b && /110\.15/.test(b.textContent), b && b.textContent.slice(0, 260));
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'));
process.exit(failures ? 1 : 0);
