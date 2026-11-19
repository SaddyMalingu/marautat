# Catalogue import — the ten minutes between "yes" and a shop

**Written:** 2026-11-19 · **Why:** eleven of twelve active tenants have an empty
catalogue, so the bot has nothing to sell and there is nothing to invoice. The campaign
asks each tenant to *send a price list*; this is the step that turns that message into a
live shop without anyone typing 40 rows by hand.

## 1. What to send the tenant (paste this back to them)

> Send it however is easiest — a photo, a note, or a spreadsheet. If you type it, one
> product per line, like this:
>
> ```
> Omo 1kg | 320 | 12
> Omo 3kg, 890
> Blue Band 250g - KES 180
> ```
>
> Name, then the price you sell at, then how many you have (leave the last one off and I
> will put zero). If you have your own codes, put them second: `Omo 1kg | OMO-1KG | 320 | 12`.

A photo works because the transcription is one paste away — but check the prices before
importing; a misread digit is a wrong price in front of a customer.

## 2. Import it

```powershell
# preview: reads the list, writes nothing
npm run catalog:import -- --tenant 254713793488 --from prices.txt

# or straight from the message
npm run catalog:import -- --tenant 254713793488 --text "Omo 1kg | 320 | 12`nOmo 3kg, 890"

# write it once the preview looks right
npm run catalog:import -- --tenant 254713793488 --from prices.txt --apply
```

`--tenant` takes a phone number (last nine digits is enough) or a name, and refuses when
it matches more than one tenant. `--json` returns the same plan for another tool.

## 3. What it accepts

| Shape | Example |
|---|---|
| Pipes (name, sku, price, stock) | `Omo 1kg \| OMO-1KG \| 320 \| 12` |
| Comma | `Omo 3kg, 890` |
| Dash and a currency word | `Sunlight 500ml - KES 210` |
| Spreadsheet paste (tabs) | `Blue Band 250g⇥180⇥40` |
| Stock marked | `Omo 1kg 320 x12`, `Omo 1kg KES 320 (6)` |
| A code in front | `OMO-1KG Omo 1kg 320` |

## 4. What it refuses, and why that matters

- **No price** — a row with content but no number is reported with its line number, not
  dropped. A silent drop is a product the tenant thinks you listed.
- **Zero or negative price** — refused. A KES 0 row sells for nothing and looks like a bug.
- **Two unmarked trailing numbers** (`Omo 5kg 1,450 6`) — refused with "separate the
  columns with | or a tab". The first version of this parser guessed, and guessed KES 6.
- **A SKU in the price column** — refused and named. `parseAmount('OMO-1KG')` strips
  non-digits and returns 1, which imported a product at KES 1 in the first test run.
- **Duplicates** — by SKU and by name+price, because pasting the same line twice generates
  a second SKU and SKU-only dedupe let it through.

Every refusal is printed with the line and a copy of what it could not read, so the reply
to the tenant is "line 6 has no price", not "it didn't work".

## 5. What it writes

The same row `POST /tenant/catalog` writes (`server.js`), so the portal and the importer
cannot drift:

`bot_tenant_id · sku · name · price · currency · stock_count · is_active · metadata`

Upsert is keyed on `(bot_tenant_id, sku)`, so re-running with a corrected list updates the
rows it already created instead of duplicating them. PostgREST applies it as one
statement: a failure writes nothing.

## 6. The pass condition

**Francis's list in, one order out, inside ten minutes.** Concretely:

1. `npm run catalog:import -- --tenant 254713793488 --from prices.txt` → preview reads
   every line, refusals explained.
2. `--apply` → rows land.
3. `npm run money:routine` → *TENANTS* now shows Spreadmasters with a catalogue instead of
   "empty catalogue".
4. One test order through the bot (`/tenant/orders` gains a row), and the KES 1,000 month
   has something behind it.

## 7. Tests

```powershell
npm run test:catalog-import    # 35 checks: parsing, refusals, the entity shape, the route
```

The three defects found by the first real run are each a test in that file, so they
cannot come back quietly.
