$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'cli\taskctl.mjs') @args
exit $LASTEXITCODE
