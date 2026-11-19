"""DOP-005 common mistake A: the standard Express advice, applied without checking
what it trusts. Writes the same /app/answer.txt as the correct answer."""
from pathlib import Path

VALUES = {
    "setting": "app.set('trust proxy', true)",
    "value": "true",
    "ordering": "at the top of the file",
}

REASONING = """
The reverse proxy address is being recorded instead of the visitor, so the ip columns
fill with ::1. The proxy sends the real address in a header the app ignores, so req.ip
stays as the socket peer.

Nothing else needs to change: this is the standard Express setting when you are behind
a proxy.
""".strip()

lines = [f"{k}: {v}" for k, v in VALUES.items()]
Path("/app/answer.txt").write_text("\n".join(lines) + "\n\n" + REASONING + "\n")
