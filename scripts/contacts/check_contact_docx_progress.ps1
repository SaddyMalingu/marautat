param(
  [string]$DocPath = "C:\Users\I.A Journal hub\Documents\now we are on 7th July 2026.docx",
  [string]$OutDir = "C:\Users\IA_Journal_Hub\whatsapp-bot\logs\audit"
)

$ErrorActionPreference = "Stop"

if (!(Test-Path $DocPath)) {
  Write-Output "DOCX_FOUND=NO"
  exit 1
}

if (!(Test-Path $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir | Out-Null
}

$tmp = Join-Path $OutDir "tmp_docx_audit"
if (Test-Path $tmp) {
  Remove-Item $tmp -Recurse -Force
}
New-Item -ItemType Directory -Path $tmp | Out-Null

Copy-Item $DocPath "$tmp\source.docx"
Rename-Item "$tmp\source.docx" "source.zip"
Expand-Archive "$tmp\source.zip" "$tmp\unzipped" -Force

$xmlPath = "$tmp\unzipped\word\document.xml"
if (!(Test-Path $xmlPath)) {
  Write-Output "DOCX_XML_NOT_FOUND"
  exit 1
}

[xml]$xml = Get-Content $xmlPath -Raw
$ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
$ns.AddNamespace('w','http://schemas.openxmlformats.org/wordprocessingml/2006/main')
$texts = $xml.SelectNodes('//w:t',$ns) | ForEach-Object { $_.'#text' }
$joined = ($texts -join ' ')

$pattern = '(?i)(\+?\d[\d\s\-]{7,}\d)'
$phones = [regex]::Matches($joined,$pattern) |
  ForEach-Object { $_.Groups[1].Value.Trim() } |
  Sort-Object -Unique

$normalized = $phones | ForEach-Object {
  $p = ($_ -replace '[^0-9+]', '')
  if ($p -match '^\+?254') { $p -replace '^\+', '' }
  elseif ($p -match '^0\d{9,}$') { "254" + $p.Substring(1) }
  else { $p }
} | Sort-Object -Unique

$rawPhonesPath = Join-Path $OutDir "contact_phones_raw.txt"
$normalizedPhonesPath = Join-Path $OutDir "contact_phones_normalized.txt"
$normalizedJsonPath = Join-Path $OutDir "contact_phones_normalized.json"

$phones | Set-Content $rawPhonesPath
$normalized | Set-Content $normalizedPhonesPath
$normalized | ConvertTo-Json | Set-Content $normalizedJsonPath

$record = [pscustomobject]@{
  timestamp = (Get-Date).ToString("o")
  doc_path = $DocPath
  text_chars = $joined.Length
  unique_phone_candidates_raw = $phones.Count
  unique_phone_candidates_normalized = $normalized.Count
  sample_first_20 = ($normalized | Select-Object -First 20)
}

$record | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $OutDir "contact_progress_latest.json")
$line = ($record | ConvertTo-Json -Depth 5 -Compress)
Add-Content -Path (Join-Path $OutDir "contact_progress_history.jsonl") -Value $line

Write-Output "DOCX_FOUND=YES"
Write-Output "DOCX_TEXT_CHARS=$($joined.Length)"
Write-Output "DOCX_UNIQUE_PHONE_CANDIDATES_RAW=$($phones.Count)"
Write-Output "DOCX_UNIQUE_PHONE_CANDIDATES_NORMALIZED=$($normalized.Count)"
Write-Output "CONTACT_PROGRESS_WRITTEN=$(Join-Path $OutDir 'contact_progress_latest.json')"
Write-Output "CONTACT_PHONES_RAW_WRITTEN=$rawPhonesPath"
Write-Output "CONTACT_PHONES_NORMALIZED_WRITTEN=$normalizedPhonesPath"
Write-Output "CONTACT_PHONES_NORMALIZED_JSON_WRITTEN=$normalizedJsonPath"
