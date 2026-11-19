/**
 * The catalogue importer, checked (2026-11-19).
 *
 * The first run of this parser against a realistic list produced three defects that
 * would have put wrong prices in front of real customers:
 *
 *   1. "Omo 1kg | OMO-1KG | 320 | 12" imported at KES 1, because parseAmount('OMO-1KG')
 *      strips non-digits and returns 1.
 *   2. "OMO-1KG Omo 5kg 1,450 6" imported at KES 6 — the last of two unmarked numbers.
 *   3. The same line pasted twice passed dedupe, because each got a different SKU.
 *
 * Each of those is a test below, and the rule they encode is: refuse and name the fix
 * rather than guess. Run: node scripts/test_catalog_import.mjs
 */
import { readFileSync } from 'fs';
import {
  parseAmount,
  parseLine,
  parsePriceList,
  summarise,
  suggestSku,
  tenantPrefix,
  toProduct
} from '../utils/catalogImport.js';

let pass = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log('PASS  ' + name);
  } else {
    failures.push(name + (extra ? ' — ' + extra : ''));
    console.log('FAIL  ' + name + (extra ? ' — ' + extra : ''));
  }
};

console.log('\n-- numbers');
ok('a plain price', parseAmount('320') === 320);
ok('thousands with a comma', parseAmount('12,500') === 12500);
ok('thousands with a space', parseAmount('12 500') === 12500);
ok('a currency prefix is ignored', parseAmount('KES 1,450') === 1450);
ok('two decimals survive', parseAmount('1,450.75') === 1450.75);

console.log('\n-- the shapes a price list arrives in');
const piped = parseLine('Omo 1kg | OMO-1KG | 320 | 12', { prefix: 'SPRE' });
ok('pipes: name, sku, price, stock', piped.name === 'Omo 1kg' && piped.sku === 'OMO-1KG'
  && piped.price === 320 && piped.stock === 12, JSON.stringify(piped));
ok('pipes: the SKU is not read as a price', piped.price !== 1);

const comma = parseLine('Omo 3kg, 890', { prefix: 'SPRE' });
ok('a comma before the price', comma.name === 'Omo 3kg' && comma.price === 890, JSON.stringify(comma));

const dash = parseLine('Sunlight 500ml - KES 210', { prefix: 'SPRE' });
ok('a dash and a currency word', dash.name === 'Sunlight 500ml' && dash.price === 210, JSON.stringify(dash));

const tabbed = parseLine('Blue Band 250g\t180\t40', { prefix: 'SPRE' });
ok('a spreadsheet paste (tabs)', tabbed.name === 'Blue Band 250g' && tabbed.price === 180
  && tabbed.stock === 40, JSON.stringify(tabbed));

const stocked = parseLine('Omo 1kg 320 x12', { prefix: 'SPRE' });
ok('stock marked with x', stocked.price === 320 && stocked.stock === 12, JSON.stringify(stocked));
const bracketed = parseLine('Omo 1kg KES 320 (6)', { prefix: 'SPRE' });
ok('stock in brackets', bracketed.price === 320 && bracketed.stock === 6, JSON.stringify(bracketed));

const coded = parseLine('OMO-1KG Omo 1kg 320', { prefix: 'SPRE' });
ok('a leading code becomes the SKU', coded.sku === 'OMO-1KG' && coded.name === 'Omo 1kg'
  && coded.price === 320, JSON.stringify(coded));

console.log('\n-- what it refuses, and says why');
const ambiguous = parseLine('OMO-1KG Omo 5kg 1,450 6', { prefix: 'SPRE' });
ok('two unmarked numbers are refused rather than guessed', ambiguous.problems.length === 1
  && /separate the columns/i.test(ambiguous.problems[0]), JSON.stringify(ambiguous));
ok('…and a non-price in the price column is named', (() => {
  const bad = parseLine('Omo 1kg | OMO-1KG | not-a-price | 3', { prefix: 'SPRE' });
  return bad.problems.some((p) => /no price/i.test(p));
})());
ok('a line with no number is reported, not silently dropped',
  parseLine('Mystery item', { prefix: 'SPRE' }).problems.some((p) => /no price/i.test(p)));
ok('a zero price is refused', parseLine('Free sample - 0', { prefix: 'SPRE' }).problems
  .some((p) => /greater than zero/i.test(p)));
ok('a header row is skipped, not imported', parseLine('Name | SKU | Price | Stock', { prefix: 'SPRE' }) === null);
ok('a comment line is skipped', parseLine('# prices from the shop', { prefix: 'SPRE' }) === null);

console.log('\n-- a whole list');
const list = [
  'Name | SKU | Price | Stock',
  'Omo 1kg | OMO-1KG | 320 | 12',
  'Omo 3kg, 890',
  'Sunlight 500ml - KES 210',
  'Omo 1kg | OMO-1KG | 320 | 12',
  'Sunlight 500ml - KES 210',
  'nothing here'
].join('\n');
const plan = parsePriceList(list, { prefix: 'SPRE' });
ok('readable rows are kept', plan.rows.length === 3, String(plan.rows.length));
ok('the duplicate SKU is refused', plan.skipped.some((s) => /duplicate SKU/.test(s.reason)));
ok('the duplicate line with a different SKU is refused too',
  plan.skipped.some((s) => /duplicate of an earlier line/.test(s.reason)));
ok('every refusal carries its line number', plan.skipped.every((s) => Number.isInteger(s.line) && s.line > 0));
ok('the total adds up', plan.total === plan.rows.length + plan.skipped.length);

const stats = summarise(plan);
ok('the summary counts what is readable', stats.readable === 3 && stats.skipped === 3, JSON.stringify(stats));
ok('the summary values the shelf', stats.stock_value === 320 * 12, String(stats.stock_value));
ok('an empty plan does not divide by zero', summarise(parsePriceList('')).cheapest === 0);

console.log('\n-- the row the server would write');
const entity = toProduct(plan.rows[0], { tenantId: 't-1' });
ok('it carries the tenant', entity.bot_tenant_id === 't-1');
ok('it carries the fields POST /tenant/catalog writes',
  ['bot_tenant_id', 'sku', 'name', 'price', 'currency', 'stock_count', 'is_active'].every((k) => k in entity));
ok('the price is a number, not a string', typeof entity.price === 'number');
ok('stock is an integer', Number.isInteger(entity.stock_count));
ok('it is active on arrival, so the bot can sell it', entity.is_active === true);
ok('it records that it was imported', entity.metadata.import_source === 'price_list');

const routeSrc = readFileSync('server.js', 'utf8');
const catalogRoute = routeSrc.slice(
  routeSrc.indexOf('app.post("/tenant/catalog"'),
  routeSrc.indexOf('app.delete("/tenant/catalog"')
);
ok('the server writes the same columns this importer does',
  ['bot_tenant_id', 'sku', 'name', 'price', 'currency', 'stock_count', 'is_active'].every((k) => catalogRoute.includes(k)));
ok('and it matches an existing row the same way the importer does',
  /eq\("bot_tenant_id", tenantId\)/.test(catalogRoute) && /eq\("sku", sku\)/.test(catalogRoute));

if (failures.length) {
  for (const failure of failures) console.error('FAIL ' + failure);
}
console.log(`\n${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

ok('a blank line is skipped', parseLine('   ', { prefix: 'SPRE' }) === null);

ok('nothing is NaN, not zero', Number.isNaN(parseAmount('')));
ok('text with no digits is NaN', Number.isNaN(parseAmount('Omo')));

console.log('\n-- identifiers');
ok('the tenant prefix is four letters', tenantPrefix('Spreadmasters ltd') === 'SPRE', tenantPrefix('Spreadmasters ltd'));
ok('a short name is padded, never empty', tenantPrefix('M-Gas') === 'MGAS', tenantPrefix('M-Gas'));
ok('no name still yields a usable prefix', tenantPrefix('') === 'ITEM');
ok('a generated SKU is readable and zero-padded', suggestSku('x', { prefix: 'SPRE', index: 7 }) === 'SPRE-0007');
