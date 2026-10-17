<#
  Builds and deploys the whole stack, then publishes the website.
  Usage:  .\scripts\deploy.ps1 [-ModelId global.amazon.nova-2-lite-v1:0] [-SkipBuild] [-VocabularyOnly]
  -VocabularyOnly only creates/updates the Transcribe custom vocabulary (infra/transcribe/vocabulary.txt) and exits.
#>
param(
  [string]$ModelId = "global.amazon.nova-2-lite-v1:0",  # always passed: CloudFormation otherwise keeps the previous value
  [string]$Profile = "default",
  [string]$Region = "ap-south-1",
  [string]$StackName = "alexa-chess",
  [switch]$SkipBuild,
  [switch]$VocabularyOnly,
  [string]$VocabularyName = "alexa_chess_vocabulary",
  [string]$ArtifactBucket = "alexa-chess-cloudformation-bucket"
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

# Amazon Transcribe custom vocabularies have no CloudFormation resource: upload the table to S3, then create or
# update the vocabulary and wait until it is READY (or FAILED, with the reason).
function Update-TranscribeVocabulary {
  node scripts/build-vocabulary.mjs --check
  if ($LASTEXITCODE -ne 0) { throw "infra/transcribe/vocabulary.txt is invalid or out of date" }
  $key = "transcribe/vocabulary.txt"
  aws s3 cp infra/transcribe/vocabulary.txt "s3://$ArtifactBucket/$key" --region $Region --profile $Profile
  if ($LASTEXITCODE -ne 0) { throw "could not upload the vocabulary to s3://$ArtifactBucket/$key" }
  $uri = "s3://$ArtifactBucket/$key"
  aws transcribe get-vocabulary --vocabulary-name $VocabularyName --region $Region --profile $Profile *> $null
  $verb = if ($LASTEXITCODE -eq 0) { "update-vocabulary" } else { "create-vocabulary" }
  aws transcribe $verb --vocabulary-name $VocabularyName --language-code en-IN --vocabulary-file-uri $uri --region $Region --profile $Profile | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "aws transcribe $verb failed" }
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 5
    $state = aws transcribe get-vocabulary --vocabulary-name $VocabularyName --region $Region --profile $Profile --query "VocabularyState" --output text
    if ($LASTEXITCODE -ne 0) { throw "get-vocabulary failed" }
    Write-Host "Vocabulary $VocabularyName : $state"
    if ($state -eq "READY") { return }
    if ($state -eq "FAILED") {
      $why = aws transcribe get-vocabulary --vocabulary-name $VocabularyName --region $Region --profile $Profile --query "FailureReason" --output text
      throw "Vocabulary $VocabularyName FAILED: $why"
    }
  }
  throw "Vocabulary $VocabularyName was not READY after 5 minutes"
}

if ($VocabularyOnly) { Update-TranscribeVocabulary; return }

# Lock CORS to the CloudFront origin once the distribution exists.
$existing = Get-StackOutputs
$overrides = @()
if ($ModelId) { $overrides += "BedrockModelId=$ModelId" }
if ($existing -and $existing.WebsiteUrl) { $overrides += "AllowedOrigin=$($existing.WebsiteUrl)" }

foreach ($pkg in "packages/mcp-server", "packages/agent", "packages/transcribe-url") {
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
Update-TranscribeVocabulary

[IO.File]::WriteAllText((Join-Path $root "web/config.json"), (@{ agentUrl = $out.AgentUrl; transcribeUrl = $out.TranscribeUrl } | ConvertTo-Json))

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
Write-Host "Ears    : $($out.TranscribeUrl)"
Write-Host "MCP     : $($out.McpServerUrl)"
Write-Host "Token   : aws secretsmanager get-secret-value --secret-id $($out.McpAuthSecretArn) --query SecretString --output text --region $Region --profile $Profile"
