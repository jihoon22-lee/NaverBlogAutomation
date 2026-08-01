[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
    throw "APPDATA를 찾을 수 없어 private 설정 경로를 결정하지 못했습니다."
}
$EnvironmentFile = Join-Path $env:APPDATA "NaverBlogAssistant\env"

if (-not (Get-Command "uv" -ErrorAction SilentlyContinue)) {
    throw "'uv' 명령을 찾을 수 없습니다. README의 Windows 요구 사항을 확인해 주세요."
}
if (-not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
    throw "설정 파일이 없습니다. 먼저 scripts\setup-windows.cmd 를 실행해 주세요."
}

Push-Location $RepositoryRoot
try {
    & uv run --frozen --env-file $EnvironmentFile python -m scripts.check_local_setup `
        --env-file $EnvironmentFile
    if ($LASTEXITCODE -ne 0) {
        throw "시작 전 설정 검사에 실패했습니다. 위 안내를 확인해 주세요."
    }

    Write-Host "Local API를 시작합니다. 이 창은 사용하는 동안 닫지 마세요."
    Write-Host "종료하려면 Ctrl+C를 누르세요."
    & uv run --frozen --env-file $EnvironmentFile python -m scripts.start_webapp `
        --env-file $EnvironmentFile
    if ($LASTEXITCODE -ne 0) {
        throw "Local API가 오류와 함께 종료되었습니다."
    }
}
finally {
    Pop-Location
}
