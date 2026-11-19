"""
DOP-005 golden answer: writes /app/answer.txt.

Values go on `label: value` lines; the reasoning is plain sentences underneath.
Every sentence below is the author's, carried over from
dop/tasks/005-trusted-proxy-ip/answer.json without rewording.
"""
from pathlib import Path

VALUES = {
    "setting": "app.set('trust proxy', 1)",
    "value": 1,
    "ordering": "above everything that reads the address, before express.json() parses a body and before the request logger records req.ip",
}

REASONING = """
All requests land on '::1' regardless of the user behind a session. By storing the
proxy's address instead of the visitor, 'req.ip' reports the socket peer. It's fair
to note that 'trust proxy' was never set, so nothing corrects it.

The page lines say `::1` on 2026-04-18 and again on 2026-10-11. When taken into
perspective, these are identical values on two different pages, six months apart.
This peer pulled ten media clips, about 40 MB in 13 seconds, and posted a
track-visit, something a health checker does not attain. Also noteworthy are the
distinct session ids under a similar address row, reading `::1`. Requests collapse
into one visitor.

Nothing errored. The app wrote a well-formed address, and it happened to be loopback,
which reads as local traffic rather than as a bug. Note that since every other column
is filled from the same value, the analytics stayed internally consistent (one city,
one pin).

If it lands after either of them, the early requests in a deploy are still written
with the proxy's address.

It must not be set as `true`. Such a move leads it to trust every hop in the chain,
and thus, expose addresses to spoofing, and possible systemic attack. This happens
because the leftmost forwarded value is taken as fact, and that value is supplied by
the client. The correct value is the hop count of one, because there is exactly one
proxy in front of the app.

Someone on a `VPN`, behind a corporate NAT or sharing a carrier address cannot be
identified as the connection still shows a single address. It also doesn't touch the
favicon 404s or the 40 MB of media the landing page pulls... those are separate
problems I noted and did not fix.
""".strip()

lines = [f"{k}: {v}" for k, v in VALUES.items()]
Path("/app/answer.txt").write_text("\n".join(lines) + "\n\n" + REASONING + "\n")
