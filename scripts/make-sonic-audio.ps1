<#
  Test phrases for the Nova 2 Sonic harness (packages/agent: npm run sonic), spoken by Windows' own voice: free, no
  AWS. Writes 16 kHz mono 16-bit WAVs to packages/agent/eval-results/sonic-audio/<n>.wav plus phrases.json.
  Usage:  .\scripts\make-sonic-audio.ps1
#>
Add-Type -AssemblyName System.Speech
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "packages/agent/eval-results/sonic-audio"
New-Item -ItemType Directory -Force $out | Out-Null

$phrases = @(
  "let's play chess",
  "white please",
  "easy",
  "e4",
  "knight f3",
  "so the meeting is on tuesday then, after lunch",
  "what was your last move?",
  "bishop c4",
  "who's winning?",
  "undo",
  "what should I have played?"
)

$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
for ($i = 0; $i -lt $phrases.Count; $i++) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SetOutputToWaveFile((Join-Path $out "$i.wav"), $format)
  $synth.Speak($phrases[$i])
  $synth.Dispose()
}
[IO.File]::WriteAllText((Join-Path $out "phrases.json"), (ConvertTo-Json @($phrases)))
Write-Host "$($phrases.Count) phrases in $out"
