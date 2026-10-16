<#
  Downloads the small Indian-English Vosk model (~36 MB zip) for the page's "chess ears" and repacks it as
  the .tar.gz that vosk-browser loads: web/models/vosk-model-small-en-in-0.4.tar.gz (git-ignored).
  Usage:  .\scripts\get-vosk-model.ps1 [-Force]
#>
param([switch]$Force)
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"  # Invoke-WebRequest is very slow with the progress bar in PowerShell 5.1
$root = Split-Path -Parent $PSScriptRoot

$name = "vosk-model-small-en-in-0.4"
$url = "https://alphacephei.com/vosk/models/$name.zip"
$models = Join-Path $root "web/models"
$out = Join-Path $models "$name.tar.gz"

if ((Test-Path $out) -and -not $Force) { Write-Host "Already there: $out (use -Force to fetch again)"; exit 0 }

$work = Join-Path ([IO.Path]::GetTempPath()) "vosk-model-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force $work | Out-Null
New-Item -ItemType Directory -Force $models | Out-Null
try {
  $zip = Join-Path $work "$name.zip"
  Write-Host "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  if (-not (Test-Path $zip)) { throw "download failed" }

  Expand-Archive -Path $zip -DestinationPath (Join-Path $work "x") -Force
  if (-not (Test-Path (Join-Path $work "x/$name/am"))) { throw "unexpected zip layout: no $name/am folder" }

  # vosk-browser strips the first path component, so the archive must hold exactly one top folder.
  & "$env:SystemRoot\System32\tar.exe" -czf $out -C (Join-Path $work "x") $name
  if ($LASTEXITCODE -ne 0) { throw "tar failed" }
  Write-Host ("Wrote {0} ({1:N1} MB)" -f $out, ((Get-Item $out).Length / 1MB))
}
catch {
  if (Test-Path $out) { Remove-Item $out -Force -Confirm:$false }
  Write-Error $_
  exit 1
}
finally {
  Remove-Item $work -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
}
