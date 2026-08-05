param(
  [string]$NormalizedPhonesPath = "C:\Users\IA_Journal_Hub\whatsapp-bot\logs\audit\contact_phones_normalized.txt",
  [string]$OutCsvPath = "C:\Users\IA_Journal_Hub\whatsapp-bot\logs\contacts_outreach_wave1.csv",
  [string]$OutSummaryPath = "C:\Users\IA_Journal_Hub\whatsapp-bot\logs\audit\contacts_outreach_wave1_summary.json"
)

$ErrorActionPreference = "Stop"

if (!(Test-Path $NormalizedPhonesPath)) {
  Write-Output "NORMALIZED_PHONE_LIST_NOT_FOUND=$NormalizedPhonesPath"
  exit 1
}

$phones = Get-Content $NormalizedPhonesPath |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_ -ne "" } |
  Sort-Object -Unique

function Get-WavePlan {
  param(
    [string]$Phone,
    [string]$CountryHint
  )

  if ($CountryHint -eq "INTL") {
    return [pscustomobject]@{
      priority = "medium"
      segment = "intl-growth"
      target_vertical = "Cross-border SMEs"
      recommended_module = "Alpha 3.0 (Comms & Outreach)"
      recommended_offer = "WhatsApp automation pilot"
    }
  }

  $digit = [int]$Phone.Substring($Phone.Length - 1)
  $bucket = $digit % 10

  if ($bucket -le 3) {
    return [pscustomobject]@{
      priority = "high"
      segment = "construction-ops"
      target_vertical = "Construction firms"
      recommended_module = "Alpha Construction"
      recommended_offer = "Project controls demo"
    }
  }

  if ($bucket -le 6) {
    return [pscustomobject]@{
      priority = "high"
      segment = "health-supply"
      target_vertical = "Healthcare supply chain"
      recommended_module = "KEMSA 3.0"
      recommended_offer = "Supply visibility dashboard pilot"
    }
  }

  if ($bucket -le 8) {
    return [pscustomobject]@{
      priority = "medium"
      segment = "architecture-studio"
      target_vertical = "Architecture studios"
      recommended_module = "Alpha Architect"
      recommended_offer = "AI design workflow demo"
    }
  }

  return [pscustomobject]@{
    priority = "medium"
    segment = "sales-automation"
    target_vertical = "Sales teams"
    recommended_module = "Alpha 3.0 (Comms & Outreach)"
    recommended_offer = "Lead follow-up automation"
  }
}

$rows = for ($i = 0; $i -lt $phones.Count; $i++) {
  $phone = $phones[$i]
  $countryHint = if ($phone -like "254*") { "KE" } elseif ($phone.StartsWith("+")) { "INTL" } else { "UNK" }
  $plan = Get-WavePlan -Phone $phone -CountryHint $countryHint
  $waveBatch = [math]::Floor($i / 26) + 1

  [pscustomobject]@{
    contact_id = "C_" + $phone
    phone = $phone
    country_hint = $countryHint
    status = "queued"
    priority = $plan.priority
    segment = $plan.segment
    target_vertical = $plan.target_vertical
    recommended_module = $plan.recommended_module
    recommended_offer = $plan.recommended_offer
    outreach_channel = "whatsapp"
    outreach_attempt = 0
    last_contact = ""
    response = ""
    outcome = ""
    owner = "David"
    wave_batch = "W1-B$waveBatch"
    next_action = "send_intro"
    notes = ""
  }
}

$rows | Export-Csv -NoTypeInformation -Path $OutCsvPath -Encoding UTF8

$bySegment = $rows | Group-Object -Property segment | ForEach-Object {
  [pscustomobject]@{
    segment = $_.Name
    count = $_.Count
  }
}

$byPriority = $rows | Group-Object -Property priority | ForEach-Object {
  [pscustomobject]@{
    priority = $_.Name
    count = $_.Count
  }
}

$summary = [pscustomobject]@{
  generated_at_utc = (Get-Date).ToUniversalTime().ToString("o")
  total_contacts = $rows.Count
  daily_target_attempts = [math]::Ceiling($rows.Count / 5)
  wave_batches = 5
  by_segment = $bySegment
  by_priority = $byPriority
}

$summary | ConvertTo-Json -Depth 5 | Set-Content -Path $OutSummaryPath

Write-Output "OUTREACH_DATASET_WRITTEN=$OutCsvPath"
Write-Output "OUTREACH_SUMMARY_WRITTEN=$OutSummaryPath"
Write-Output "TOTAL_CONTACTS=$($rows.Count)"
