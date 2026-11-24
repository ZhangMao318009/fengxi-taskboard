[CmdletBinding()]
param([switch]$Open)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 LTS from https://nodejs.org/ first.' }
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    }
    & npm.cmd run build:web
    if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
    $port = if ($env:CODEX_TASKBOARD_PORT) { $env:CODEX_TASKBOARD_PORT } else { '47823' }
    if ($port -notmatch '^\d+$' -or [int]$port -lt 1 -or [int]$port -gt 65535) { throw 'Invalid CODEX_TASKBOARD_PORT.' }
    if ($Open) { Start-Process ('http://127.0.0.1:' + $port) }
    & node (Join-Path $PSScriptRoot 'server\index.mjs')
    exit $LASTEXITCODE
} finally { Pop-Location }
