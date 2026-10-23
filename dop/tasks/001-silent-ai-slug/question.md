# Share and Review keep taking half a minute, then say the AI tier is unavailable

On the Writers tab, **Share** and **Review** sometimes come back in under a second,
and sometimes sit there for 15 to 32 seconds and then report
`AI tier unavailable — copy unchanged`. Tenants click again, so a three-click
session can hang for most of a minute. Nothing in the UI says what it was waiting
for.

We are not asking you to buy credits or rotate keys. We are asking why the click
waits, and what should change so it stops waiting.

The host log for one such session is in `./files/production-log-2026-10-23.txt`.
`./files/blogManager-provider-notes.txt` is the comment block the writer carries
about its provider list, so you can see what it already handles.

Write your answer to `./answer.json`, exactly this shape:

```json
{
  "culprit": "",
  "evidence": "",
  "why_it_was_missed": "",
  "fix": {
    "retire_after_empty_boxes": 0,
    "probe_timebox_ms": 0,
    "scope": ""
  },
  "must_not_retire": "",
  "does_not_fix": ""
}
```

* `culprit` — the exact model slug (or provider) the click was waiting on.
* `evidence` — the lines that prove it, in your own words, with the numbers.
* `why_it_was_missed` — what the existing fallback logic already handles, and why
  this case slipped through it.
* `fix.retire_after_empty_boxes` — how many fair attempts with no bytes before the
  slug is dropped.
* `fix.probe_timebox_ms` — the time box for the probe attempt after that.
* `fix.scope` — how long the drop lasts.
* `must_not_retire` — the case that looks identical in the log but must never be
  punished the same way.
* `does_not_fix` — what this change does and does not restore.

The reasoning fields are read, so write plain sentences. Naming the slug without
saying why it is the cause scores low, and so does a fix that would also punish a
provider that is merely slow.
