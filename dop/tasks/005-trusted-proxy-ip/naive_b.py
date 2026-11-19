"""DOP-005 common mistake B: skip the framework setting and parse the forwarded
header by hand. Careful-looking, spoofable, and leaves every other reader of the
address inconsistent. Writes the same /app/answer.txt."""
from pathlib import Path

VALUES = {
    "setting": "read req.headers['x-forwarded-for'].split(',')[0] as the client address",
    "value": "leftmost",
    "ordering": "in the analytics writer, before the insert",
}

REASONING = """
The app reads the socket peer instead of the forwarded header, so it records ::1
behind the proxy. The page line shows ::1 while the same peer pulled ten media clips
and posted analytics, which only a browser does.

Nothing errored; a well-formed loopback address was stored as if it were the visitor,
so it silently looked like local traffic.

It still cannot identify VPN or corporate NAT users.
""".strip()

lines = [f"{k}: {v}" for k, v in VALUES.items()]
Path("/app/answer.txt").write_text("\n".join(lines) + "\n\n" + REASONING + "\n")
