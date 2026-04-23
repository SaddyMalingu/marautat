#!/usr/bin/env python3
import requests
import json

base_url = "https://alphadome.onrender.com"
key = "myverify123"

print("=" * 60)
print("CHECKING LIVE RENDER DEPLOYMENT STATUS")
print("=" * 60)
print()

# Health check
print("📊 Health Status:")
try:
    r = requests.get(f"{base_url}/admin/health?key={key}", timeout=10)
    if r.status_code == 200:
        data = r.json()
        print(f"  ✅ Server is Up")
        print(f"  Status: {data.get('status', 'unknown')}")
    else:
        print(f"  ❌ Error: {r.status_code}")
except Exception as e:
    print(f"  ❌ Failed: {str(e)}")

print()

# Ops Overview (Revenue)
print("💰 Revenue & Outreach Metrics:")
try:
    r = requests.get(f"{base_url}/admin/ops-overview?key={key}", timeout=10)
    if r.status_code == 200:
        ops = r.json()
        print(f"  Revenue (KES): {ops.get('revenue_kes', 0):,.0f}")
        print(f"  Attempts (7d): {ops.get('attempts_7d', 0)}")
        print(f"  Conversion Rate: {ops.get('conversion_rate_pct', 0)}%")
        print(f"  Incoming Messages (24h): {ops.get('incoming_24h', 0)}")
        print(f"  Hot Leads: {ops.get('hot_leads_count', 0)}")
        print(f"  Failed Payments: {ops.get('failed_count', 0)}")
        print(f"  Pending Payments: {ops.get('pending_count', 0)}")
        print(f"  COD Queue: {ops.get('cod_count', 0)}")
        print()
        print("  Operations Summary:")
        ops_ops = ops.get('operations', [])
        if ops_ops:
            for item in ops_ops[:5]:
                print(f"    - {item}")
        else:
            print("    (No operations yet)")
    else:
        print(f"  ❌ Error: {r.status_code}")
        print(f"  Response: {r.text[:200]}")
except Exception as e:
    print(f"  ❌ Failed: {str(e)}")

print()

# Performance Report
print("📈 Performance Report (Daily):")
try:
    r = requests.get(f"{base_url}/admin/performance-report?key={key}&period=daily", timeout=10)
    if r.status_code == 200:
        report = r.json()
        band = report.get('performance_band', 'unknown')
        summary = report.get('summary', {})
        
        print(f"  Band: {band}")
        print(f"  Revenue: KES {summary.get('revenue_kes', 0):,.0f}")
        print(f"  Conversion: {summary.get('conversion_rate_pct', 0)}%")
        print(f"  Hot Leads: {summary.get('hot_leads_count', 0)}")
        print()
        print("  Action Plan (top 3):")
        actions = report.get('action_plan', [])
        if actions:
            for action in actions[:3]:
                print(f"    ▪ {action}")
        else:
            print("    (No actions)")
    else:
        print(f"  ❌ Error: {r.status_code}")
except Exception as e:
    print(f"  ❌ Failed: {str(e)}")

print()
print("=" * 60)
