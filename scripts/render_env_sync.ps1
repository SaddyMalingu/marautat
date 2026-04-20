param(
  [Parameter(Mandatory = $true)] [string]$RenderApiKey,
  [Parameter(Mandatory = $true)] [string]$ServiceId,
  [Parameter(Mandatory = $false)] [string]$SbUrl = "https://twxmfdwemchrswxzjstp.supabase.co",
  [Parameter(Mandatory = $true)] [string]$SbServiceRoleKey,
  [Parameter(Mandatory = $false)] [switch]$ApplyAliases,
  [Parameter(Mandatory = $false)] [switch]$DeleteOptional
)

$ErrorActionPreference = "Stop"

function Invoke-RenderApi {
  param(
    [Parameter(Mandatory = $true)] [ValidateSet("GET","POST","PUT","DELETE")] [string]$Method,
    [Parameter(Mandatory = $true)] [string]$Path,
    [Parameter(Mandatory = $false)] $Body
  )

  $headers = @{
    Authorization = "Bearer $RenderApiKey"
  }

  $uri = "https://api.render.com/v1$Path"

  if ($null -ne $Body) {
    $json = $Body | ConvertTo-Json -Depth 8 -Compress
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -ContentType "application/json" -Body $json
  }

  return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers
}

function Get-EnvVars {
  $all = @()
  $cursor = $null

  while ($true) {
    $path = "/services/$ServiceId/env-vars"
    if ($cursor) {
      $path = "$path?cursor=$([uri]::EscapeDataString($cursor))"
    }

    $page = Invoke-RenderApi -Method GET -Path $path
    $rows = @()
    if ($page -is [System.Array]) {
      $rows = $page
    } elseif ($null -ne $page) {
      if ($page.envVars) {
        $rows = @($page.envVars)
      } else {
        $rows = @($page)
      }
    }

    if ($rows.Count -eq 0) { break }

    $all += $rows
    $lastCursor = [string]$rows[-1].cursor
    if (-not $lastCursor) { break }

    # Defensive break: if cursor does not advance, stop to avoid infinite loop
    if ($cursor -and $cursor -eq $lastCursor) { break }
    $cursor = $lastCursor
  }

  return $all
}

Write-Host "Fetching current Render env vars..." -ForegroundColor Green
$current = Get-EnvVars

# Normalize array shape
$items = @()
if ($current -is [System.Array]) {
  $items = $current
} elseif ($null -ne $current) {
  if ($current.envVars) {
    $items = @($current.envVars)
  } else {
    $items = @($current)
  }
}

# Build current map from response shape: [{ envVar: { key, value }, cursor }]
$envMap = @{}
foreach ($row in $items) {
  if ($row.envVar -and $row.envVar.key) {
    $envMap[[string]$row.envVar.key] = [string]$row.envVar.value
  } elseif ($row.key) {
    $envMap[[string]$row.key] = [string]$row.value
  }
}

# Required vars this app depends on
$requiredKeys = @(
  "SB_URL",
  "SB_SERVICE_ROLE_KEY",
  "VERIFY_TOKEN",
  "WHATSAPP_TOKEN",
  "PHONE_NUMBER_ID",
  "ADMIN_PASS",
  "TENANT_DASHBOARD_PASS",
  "OPENAI_API_KEY",
  "MPESA_CONSUMER_KEY",
  "MPESA_CONSUMER_SECRET",
  "MPESA_SHORTCODE",
  "MPESA_PASSKEY",
  "MPESA_CALLBACK_URL",
  "MPESA_ENV",
  "PORT"
)

# Optional vars that are safe to keep; can be deleted with -DeleteOptional
$optionalKeys = @(
  "POSTGRES_URL",
  "BASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "HF_API_KEY",
  "HF_MODEL",
  "DEFAULT_BRAND_ID",
  "ADMIN_NUMBERS",
  "SUBSCRIPTION_ACCOUNT_REF",
  "SUBSCRIPTION_AMOUNT"
)

# 1) Canonical updates in-memory
Write-Host "Updating canonical Supabase keys..." -ForegroundColor Cyan
$envMap["SB_URL"] = $SbUrl
$envMap["SB_SERVICE_ROLE_KEY"] = $SbServiceRoleKey

if ($ApplyAliases) {
  $envMap["SUPABASE_URL"] = $SbUrl
  $envMap["SUPABASE_SERVICE_ROLE_KEY"] = $SbServiceRoleKey
}

# 2) Optional cleanup in-memory
if ($DeleteOptional) {
  Write-Host "Removing optional keys from desired set..." -ForegroundColor Yellow
  foreach ($k in $optionalKeys) {
    if ($envMap.ContainsKey($k)) {
      [void]$envMap.Remove($k)
    }
  }
}

# 3) Apply full merged env set (Render PUT replaces full set)
$payload = @()
foreach ($k in ($envMap.Keys | Sort-Object)) {
  $payload += @{ key = $k; value = $envMap[$k] }
}

Write-Host ("Applying full env set with {0} keys..." -f $payload.Count) -ForegroundColor Green
[void](Invoke-RenderApi -Method PUT -Path "/services/$ServiceId/env-vars" -Body $payload)

# Refresh to validate checklist against live state
$items = @(Get-EnvVars)

# 4) Trigger deploy
Write-Host "Triggering deploy..." -ForegroundColor Green
[void](Invoke-RenderApi -Method POST -Path "/services/$ServiceId/deploys")

Write-Host "Done. Verify endpoints:" -ForegroundColor Green
Write-Host "  https://alphadome.onrender.com/admin/health?key=YOUR_ADMIN_PASS"
Write-Host "  https://alphadome.onrender.com/admin/api/ops-overview?key=YOUR_ADMIN_PASS"
Write-Host "  https://alphadome.onrender.com/admin/api/wf/stats?key=YOUR_ADMIN_PASS"

Write-Host "Required keys checklist (must exist):" -ForegroundColor Cyan
$missing = @()
foreach ($key in $requiredKeys) {
  $exists = $false
  foreach ($row in $items) {
    if ($row.envVar -and [string]$row.envVar.key -eq $key) { $exists = $true; break }
    if ([string]$row.key -eq $key) { $exists = $true; break }
  }
  if (-not $exists -and $key -notin @("SB_URL", "SB_SERVICE_ROLE_KEY")) {
    $missing += $key
  }
}

if ($missing.Count -gt 0) {
  Write-Host "Missing required keys (add these in Render dashboard/API):" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "  - $_" }
} else {
  Write-Host "All required keys present or upserted." -ForegroundColor Green
}
