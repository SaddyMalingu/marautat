"""DOP-005 common mistake C: blame the platform and raise a support ticket. A real
engineer does this first, and it leaves the app exactly as it was. Writes the same
/app/answer.txt."""
from pathlib import Path

VALUES = {
    "setting": "ask the host to enable X-Forwarded-For forwarding",
    "value": "host-side",
    "ordering": "not a code change",
}

REASONING = """
Render's proxy is not forwarding the client address, so the app can only see ::1.

The application looks correct; the header simply never arrives from the platform. The
address stays wrong until the platform answers.
""".strip()

lines = [f"{k}: {v}" for k, v in VALUES.items()]
Path("/app/answer.txt").write_text("\n".join(lines) + "\n\n" + REASONING + "\n")
