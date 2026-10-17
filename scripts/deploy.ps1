<#
  Builds and deploys the whole stack, then publishes the website.
  Usage:  .\scripts\deploy.ps1 [-ModelId global.amazon.nova-2-lite-v1:0] [-SkipBuild]
  (No Amazon Transcribe any more: the page uses Chrome's own speech recognition, removed 2026-10-17 for cost.)
#>
param(
  [string]$ModelId = "global.amazon.nova-2-lite-v1:0",  # always passed: CloudFormation otherwise keeps the previous value
  [string]$Profile = "default",
  [string]$Region = "ap-south-1",
  [string]$StackName = "alexa-chess",
  [switch]$SkipBuild
)
# sam/aws write progress to stderr, which Windows PowerShell 5.1 turns into errors under "Stop".
# Keep "Continue" and check $LASTEXITCODE after every native call instead.
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Get-StackOutputs {
  $json = aws cloudformation describe-stacks --stack-name $StackName --region $Region --profile $Profile --query "Stacks[0].Outputs" --output json 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  $map = @{}
  foreach ($o in ($json | ConvertFrom-Json)) { $map[$o.OutputKey] = $o.OutputValue }
  return $map
}

function Invoke-Sam([string[]]$SamArgs) {
  & sam @SamArgs
  if ($LASTEXITCODE -ne 0) { throw "sam $($SamArgs -join ' ') failed" }
}

# Lock CORS to the CloudFront origin once the distribution exists.
$existing = Get-StackOutputs
$overrides = @()
if ($ModelId) { $overrides += "BedrockModelId=$ModelId" }
if ($existing -and $existing.WebsiteUrl) { $overrides += "AllowedOrigin=$($existing.WebsiteUrl)" }

foreach ($pkg in "packages/mcp-server", "packages/agent") {
  if (-not (Test-Path "$pkg/node_modules")) {
    Push-Location $pkg; npm install --no-audit --no-fund; Pop-Location
  }
}

if (-not $SkipBuild) { Invoke-Sam @("build") }

$deployArgs = @("deploy")
if ($overrides.Count -gt 0) { $deployArgs += "--parameter-overrides"; $deployArgs += $overrides }
Invoke-Sam $deployArgs

$out = Get-StackOutputs
if (-not $out) { throw "Could not read stack outputs" }

# First deploy: CloudFront URL was unknown, so redeploy once to restrict CORS.
if (-not ($existing -and $existing.WebsiteUrl)) {
  Write-Host "First deploy - redeploying with AllowedOrigin=$($out.WebsiteUrl)"
  $again = @("deploy", "--parameter-overrides", "AllowedOrigin=$($out.WebsiteUrl)")
  if ($ModelId) { $again += "BedrockModelId=$ModelId" }
  Invoke-Sam $again
}

# WriteAllText writes UTF-8 without the BOM that PowerShell 5.1's Out-File adds.
[IO.File]::WriteAllText((Join-Path $root "web/config.json"), (@{ agentUrl = $out.AgentUrl } | ConvertTo-Json))

# models/ (the chess-ears Vosk model, ~36 MB) is excluded here and uploaded separately below; excluded
# paths are also safe from --delete.
aws s3 sync web/ "s3://$($out.WebsiteBucketName)" --delete --exclude "models/*" --region $Region --profile $Profile
if ($LASTEXITCODE -ne 0) { throw "s3 sync failed" }
# Re-upload every file with no-cache (sync skips unchanged ones): browsers then revalidate with a cheap
# ETag check instead of guessing a lifetime, so a deploy is picked up on the next page load.
aws s3 cp web/ "s3://$($out.WebsiteBucketName)" --recursive --exclude "models/*" --cache-control "no-cache" --region $Region --profile $Profile
if ($LASTEXITCODE -ne 0) { throw "s3 cp failed" }
# Model files are versioned by name and never change: cache them for a year. Explicit content type, so
# nothing adds a Content-Encoding that would make the browser unzip the .tar.gz before vosk-browser does.
if (Test-Path "web/models") {
  aws s3 sync web/models/ "s3://$($out.WebsiteBucketName)/models/" --delete --cache-control "max-age=31536000, immutable" --content-type "application/gzip" --region $Region --profile $Profile
  if ($LASTEXITCODE -ne 0) { throw "s3 sync of models failed" }
} else {
  Write-Host "No web/models/ - chess ears stay off on the site (run scripts/get-vosk-model.ps1 to add the model)"
}
aws cloudfront create-invalidation --distribution-id $out.DistributionId --paths "/*" --profile $Profile | Out-Null

Write-Host ""
Write-Host "Website : $($out.WebsiteUrl)"
Write-Host "Agent   : $($out.AgentUrl)"
Write-Host "MCP     : $($out.McpServerUrl)"
Write-Host "Token   : aws secretsmanager get-secret-value --secret-id $($out.McpAuthSecretArn) --query SecretString --output text --region $Region --profile $Profile"
