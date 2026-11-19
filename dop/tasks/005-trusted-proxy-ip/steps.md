1. Trace the stored value back to its source: `::1` is loopback, the address of the proxy running inside the instance, not a visitor.
2. Name the setting that decides how the address is resolved at all.
3. Give that setting the hop count of one, as a number, not as the boolean.
4. Reject the boolean form: trusting every hop believes a header the client writes, so any visitor can spoof the address.
5. Place the setting before `express.json()` and before the request logger, or early requests keep the old address.
6. Explain why a well-formed loopback value read as normal for six months rather than as a fault.
7. Use the traffic itself — ten media clips and a track-visit — to show the peer was a person, not a health checker.
8. State what the fix still cannot identify (VPN, NAT, carrier) and what it leaves broken (favicon, media).
