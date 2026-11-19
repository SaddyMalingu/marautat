# The AI tier is missing keys that are sitting in the dashboard

The writers are answering "AI tier unavailable" on this host, and I was about to
start re-provisioning keys. Then I opened the environment list: the OpenRouter key
and the Groq key are both there, both with values, both the same keys we use
everywhere else. The boot log says otherwise.

Before anybody rotates a credential or buys credits, tell me why the app cannot see
keys that are present, and what should change so that this does not come back next
month wearing a different hat.

What I have is in `./files`:

* `boot-log-2026-10-23.txt` — what the app printed about itself at startup.
* `render-env-names-2026-10-23.txt` — the names exactly as the host has them.
* `gateway-notes-2026-10-22.txt` — the notes from the last time this class of
  failure hid in plain sight.

Write your answer to `./answer.json`, exactly this shape:

```json
{
  "invisible_keys": [],
  "evidence": "",
  "why_it_was_missed": "",
  "fix": {
    "one_place": "",
    "canonical_first": false,
    "match_rule": "",
    "probe_reports": ""
  },
  "must_not": "",
  "does_not_fix": ""
}
```

* `invisible_keys` — the names, exactly as the host has them, of the keys the app
  cannot see.
* `evidence` — the lines that prove it, in your own words, with the names.
* `why_it_was_missed` — why a person read this as provisioning rather than as a bug.
* `fix.one_place` — where the decision about a key's name should live, and who must
  share it.
* `fix.canonical_first` — whether the preferred spelling is tried before the others.
* `fix.match_rule` — how a name is accepted or refused, precisely enough to argue
  about.
* `fix.probe_reports` — what the operator must be told back when a key is checked.
* `must_not` — the tempting version of this change that must never be made, and the
  harm it does.
* `does_not_fix` — what the tempting one-off fix would have left behind.

Write plainly, in sentences. Naming the two variables without saying why the app
could not see them is not an answer.
