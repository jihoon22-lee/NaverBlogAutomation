[CmdletBinding()]
param(
    [switch]$SkipDependencies
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ApplicationDirectoryName = "NaverBlogAssistant"

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "명령 실행에 실패했습니다: $Command"
    }
}

function Assert-CommandAvailable {
    param([Parameter(Mandatory = $true)][string]$Command)

    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "'$Command' 명령을 찾을 수 없습니다. README의 Windows 요구 사항을 확인해 주세요."
    }
}

Assert-CommandAvailable "uv"
Assert-CommandAvailable "npm"

Push-Location $RepositoryRoot
try {
    if (-not $SkipDependencies) {
        Write-Host "[1/3] Python dependency를 설치합니다."
        Invoke-CheckedCommand "uv" "sync" "--frozen"
        Write-Host "[2/3] 웹앱 dependency와 bundle을 준비합니다."
        Invoke-CheckedCommand "npm" "ci" "--prefix" "client"
        Invoke-CheckedCommand "npm" "--prefix" "client" "run" "build"
    }

    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        throw "APPDATA를 찾을 수 없어 private 설정 경로를 결정하지 못했습니다."
    }
    $EnvironmentFile = Join-Path $env:APPDATA "$ApplicationDirectoryName\env"

    if (-not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
        Write-Host "[3/3] Private 설정 파일을 만듭니다."
        Invoke-CheckedCommand "uv" "run" "--frozen" "python" "-m" `
            "scripts.init_local_env" "--target" $EnvironmentFile
    }
    else {
        Write-Host "[3/3] 기존 private 설정 파일을 재사용합니다."
    }
    Invoke-CheckedCommand "uv" "run" "--frozen" "--env-file" $EnvironmentFile `
        "python" "-m" "scripts.check_local_setup" "--env-file" $EnvironmentFile

    Write-Host ""
    Write-Host "웹앱 설정이 완료되었습니다. 다음부터 scripts\start-windows.cmd 를 실행하세요."
    Write-Host "실제 OpenAI 생성은 README의 안내에 따라 private 설정 파일에서 활성화할 수 있습니다."
}
finally {
    Pop-Location
}
