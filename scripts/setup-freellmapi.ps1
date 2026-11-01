param(
  [string]$GatewayUrl = "http://127.0.0.1:31415",
  [string]$Model = "auto"
)

$ErrorActionPreference = "Stop"
$gateway = $GatewayUrl.TrimEnd("/")
if ([string]::IsNullOrWhiteSpace($env:FREELLMAPI_API_KEY)) {
  $secureKey = Read-Host "FreeLLMAPI unified inference key" -AsSecureString
  if ($secureKey.Length -eq 0) {
    throw "A FreeLLMAPI unified inference key is required."
  }
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  try {
    $env:FREELLMAPI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  }
} else {
  $env:FREELLMAPI_API_KEY = $env:FREELLMAPI_API_KEY.Trim()
  Write-Host "Using FREELLMAPI_API_KEY already set in this PowerShell session."
}

$env:ORCHESTRATOR_OPENAI_BASE_URL = "$gateway/v1"
$env:ORCHESTRATOR_OPENAI_MODEL = $Model.Trim()

try {
  $models = Invoke-RestMethod -Uri "$gateway/v1/models" -Headers @{ Authorization = "Bearer $env:FREELLMAPI_API_KEY" }
} catch {
  $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { "unavailable" }
  throw "FreeLLMAPI gateway authentication failed (HTTP $status). Use its unified inference key from the dashboard Keys page."
}

$modelCount = @($models.data).Count
Write-Host "FreeLLMAPI connected; model catalog contains $modelCount entries."

$setupOutput = npx freellmapi setup-generic --url $gateway --dry-run 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "FreeLLMAPI generic setup preview failed."
}
Write-Host "FreeLLMAPI generic client setup preview:"
$safeSetupOutput = ([string]$setupOutput).Replace($env:FREELLMAPI_API_KEY, "[REDACTED]")
$safeSetupOutput | ForEach-Object { Write-Host $_ }

npm run build
if ($LASTEXITCODE -ne 0) {
  throw "Orchestrator build failed."
}

$revision = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $revision) {
  throw "Could not determine the source revision for the trial record."
}
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$trialOutput = "experiments/results/freellmapi-smoke-$stamp.json"
node experiments/runners/run-freellmapi-smoke.mjs --output $trialOutput --source-revision $revision
if ($LASTEXITCODE -ne 0) {
  throw "The FreeLLMAPI smoke trial failed."
}

Write-Host "Setup is ready in this PowerShell session. Run 'npm start' here to launch Orchestrator."
