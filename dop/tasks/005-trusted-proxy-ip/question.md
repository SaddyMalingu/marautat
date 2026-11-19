# Every visitor shows up from the same address, and it is not theirs

Our analytics are useless. On the admin dashboard every visit is recorded from the
same address, so the map shows one pin and the city breakdown is one city. The
page-load lines in our own log say the same value, and they have said it since
April — I only noticed now because a demo link opened on a phone in Nakuru was
logged from that same address, and the person was nowhere near the office.

I am not asking you to add a geolocation service or to buy a database. I am asking
why the address the app stores is not the visitor's, and what should change so it
is.

What I have is in `/app/data/files` — three text files:

* `bot-log-excerpt-2026-04-18.txt` — our own log, two dates, two surfaces.
* `analytics-ip-column.txt` — what the columns actually contain.
* `health-checker-note.txt` — what I was watching in the host log at the time.

Write your answer to `/app/answer.txt`: the values on their own `label: value` lines,
then the reasoning in plain sentences underneath.

Labels I need:

* `setting` — the change, written the way it would go into the code.
* `value` — the exact value that change takes, as a number.
* `ordering` — where the change has to sit relative to the rest of the app.

Underneath those, in sentences: what the stored address actually is and why it is
that value; the lines that prove it, with the numbers; why this read as normal for
six months instead of as a bug; the tempting form of the same change that must never
be used and the harm it does; and what this restores and what it still cannot tell
you.

Write plainly, in sentences. Naming the right line without saying why it produces
that value is not an answer.
