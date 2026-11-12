# WhatsApp demand audit — what the 11,869 rows actually are (2026-11-12)

_Read-only analysis of `public.conversations` (11,869 rows, 2025-10-24 → 2026-11-12 03:21 UTC).
No row was written or changed._

## The headline correction

The table holds **11,869 rows, but only 792 are inbound messages from humans, from 83
distinct senders.** Of the 11,077 outbound rows, **10,212 are the literal string
`WHATSAPP_STATUS:failed`** — delivery-status webhooks stored as if they were messages.

| Measure | Count |
|---|---|
| Rows in `conversations` | 11,869 |
| Inbound messages with text | **792** |
| Distinct people who ever typed | **83** |
| Outbound rows that are status events | **10,320** (`failed` 10,212, `sent` 91, `read` 12, `delivered` 5) |
| Real outbound messages | ~750 (welcome copy 154, catalogue refusal 38, greetings ~50, the rest) |
| `intent` column filled | **0 of 11,869 (0%)** |
| `entities` non-empty | **0** |

The earlier "11,785 conversations = biggest asset" read was wrong, and this audit corrects
it. The asset is smaller and more interesting: **83 human conversations, about a dozen of
them with real buying or build intent, and not one of them converted.**

## The bug: a failed-send loop, written to the wrong column

`server.js` (lines ~10812–10848) writes every Meta status callback as a conversation row:

```js
message_text: `WHATSAPP_STATUS:${statusCode}`,
direction: "outgoing",
```

Meta repeats a `failed` status for every failed send. One contact —
`e9cf4e12-57d3-4186-a216-ec08c4035997` — received **10,157 of those failures**, at a
metronomic ~110 per day since 2026-08-06: `2026-11-01T00:01`, `00:14`, `00:27`, `00:53`…
That interval matches the boot log's `Interval follow-up automation scheduled every 13
minutes (batch=1, cooldown=24h, dry_run=false)`.

So the follow-up automation has been trying to send to one number every 13 minutes for
three months, failing 100% of the time, and logging the failure as if it were a message.
Two consequences: **the conversation analytics are unusable**, and **the business number
has a standing pattern of failed sends that puts it at risk of a quality-rating block**.

## What the 792 real messages say

Intent buckets (a message can match several) and the top exact texts:

| Bucket | Messages | Share |
|---|---:|---:|
| Greeting / small talk | 398 | 52% |
| Service enquiry (website, bot, automation) | 24 | 3% |
| Catalogue question | 20 | 3% |
| Support / complaint | 14 | 2% |
| Asked for a human | 14 | 2% |
| Payment / receipt language | 8 | 1% |
| Price | 7 | 1% |
| Order or buy | 4 | 0.5% |
| AI-work / referral | 2 | 0.3% |

Top texts: `hello` 167, `hi` 114, `hey` 18, `who are you` 14, `guitar` 8, `are you on` 7.
Median message length is **10 characters** — people open, greet, and leave.

Swahili/Sheng markers: 2% of inbound. The audience writes English, short.

## The dozen conversations that were worth money

These are real, dated, and each one is a lost or open opportunity:

| Date | What the person asked for |
|---|---|
| 2025-11-09 | "Can you crawl the internet for opportunities, then reach out with proposals, tender applications… I need my brand to make me money online" |
| 2025-11-09 | "Advise me how best I can leverage tech for my brand, Malingu Global Supplies" |
| 2025-11-23 | "I am a relationships officer in a microfinance company… I need to recruit clients and disburse loans. Can you help" |
| 2025-11-23 | "Help me with strategies of recruiting clients to build my loan portfolio" |
| 2026-02 | "WritersFlow: I want to pitch my organic coffee beans to local restaurants" (×5) |
| 2026-02 | "Do you have pictures of the same" |
| 2026-02 | "What products do you have in your catalog" (×2) |
| 2026-03-26 | "I manage Kenya Airways (KQ)… tell me how Alphadome will help us" |
| 2026-03-28 | "Sawa, tuache utani… Alphadome inafanya nini? Itanisaidia aje kwa biashara yangu? Mi ni meneja KQ" |
| 2026-03 | "I want to launch a system for my business" |
| 2026-03 | "I want your system to help engage my customers" |
| 2026-02 | "How do exports work / how can I make export documentation" |
| 2026-02 | "Can you do any agentic tasks" |

Every one of these landed in a conversation with no offer, no follow-up and no record of
what happened next.

## What has to change, in order

1. **Stop the loop.** Set `FOLLOWUP_AUTOMATION_ENABLED=false` (or `FOLLOWUP_AUTOMATION_MODE=dry_run`)
   before anything else, then add a guard: never retry a contact whose last send failed,
   cap attempts per contact per day, and respect the 24-hour customer-service window.
2. **Separate status from messages.** Status callbacks get their own table (or a
   `direction='status'` value), never `message_text`. Every funnel report needs
   `WHERE message_text NOT LIKE 'WHATSAPP_STATUS:%'` until the write site is fixed.
3. **Classify at ingest.** `intent` is 0% filled and `entities` 0% — the classification
   step never wrote. Fill both, or analytics stay impossible.
4. **Work the dozen.** They are named, dated, and still warm enough to answer. This is the
   cheapest revenue in the repository: 13 replies, not a new product.
5. **Give the bot something to sell.** The most common non-greeting question is "what do
   you do / what do you have" — the answer should be a link to `/drops` and `/build`, not
   a paragraph. The catalogue refusal ("I can only answer from the brand catalog…") fired
   38 times; that is the bot correctly refusing because no offer was loaded for that tenant.
