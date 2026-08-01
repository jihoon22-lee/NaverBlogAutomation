[CmdletBinding()]
param(
    [string]$ExtensionId,
    [switch]$SkipDependencies,
    [switch]$WithExtension
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

if (-not [string]::IsNullOrWhiteSpace($ExtensionId)) {
    $ExtensionId = $ExtensionId.Trim().ToLowerInvariant()
    if ($ExtensionId -notmatch '^[a-p]{32}$') {
        throw "Extension ID는 a부터 p까지의 영문 소문자 32자여야 합니다."
    }
    $WithExtension = $true
}

Assert-CommandAvailable "uv"
Assert-CommandAvailable "npm"

Push-Location $RepositoryRoot
try {
    if (-not $SkipDependencies) {
        Write-Host "[1/4] Python dependency를 설치합니다."
        Invoke-CheckedCommand "uv" "sync" "--frozen"
        Write-Host "[2/4] 웹앱 dependency와 bundle을 준비합니다."
        Invoke-CheckedCommand "npm" "ci" "--prefix" "client"
        Invoke-CheckedCommand "npm" "--prefix" "client" "run" "build"
        if ($WithExtension) {
            Write-Host "[3/4] 선택한 Chrome extension을 build합니다."
            Invoke-CheckedCommand "npm" "ci" "--prefix" "extension"
            Invoke-CheckedCommand "npm" "--prefix" "extension" "run" "build"
        }
    }

    if ($WithExtension -and [string]::IsNullOrWhiteSpace($ExtensionId)) {
        Write-Host ""
        Write-Host "Chrome에서 chrome://extensions 를 열고 Developer mode를 켜세요."
        Write-Host "Load unpacked에서 다음 folder를 선택하세요:"
        Write-Host "  $(Join-Path $RepositoryRoot 'extension\dist')"
        $ExtensionId = Read-Host "표시된 32자 extension ID"
    }

    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        throw "APPDATA를 찾을 수 없어 private 설정 경로를 결정하지 못했습니다."
    }
    $EnvironmentFile = Join-Path $env:APPDATA "$ApplicationDirectoryName\env"

    if (-not (Test-Path -LiteralPath $EnvironmentFile -PathType Leaf)) {
        Write-Host "[4/4] Private 설정 파일을 만듭니다."
        Invoke-CheckedCommand "uv" "run" "--frozen" "python" "-m" `
            "scripts.init_local_env" "--target" $EnvironmentFile
    }
    else {
        Write-Host "[4/4] 기존 private 설정 파일을 재사용합니다."
    }

    if ($WithExtension) {
        $ExtensionId = $ExtensionId.Trim().ToLowerInvariant()
        if ($ExtensionId -notmatch '^[a-p]{32}$') {
            throw "Extension ID는 a부터 p까지의 영문 소문자 32자여야 합니다."
        }
        Invoke-CheckedCommand "uv" "run" "--frozen" "python" "-m" `
            "scripts.configure_local_env" "--target" $EnvironmentFile `
            "--extension-id" $ExtensionId
    }
    Invoke-CheckedCommand "uv" "run" "--frozen" "--env-file" $EnvironmentFile `
        "python" "-m" "scripts.check_local_setup" "--env-file" $EnvironmentFile

    Write-Host ""
    Write-Host "웹앱 설정이 완료되었습니다. 다음부터 scripts\start-windows.cmd 를 실행하세요."
    if ($WithExtension) {
        Write-Host "기존 Chrome extension도 함께 설정했습니다."
    }
    Write-Host "실제 OpenAI 생성은 README의 안내에 따라 private 설정 파일에서 활성화할 수 있습니다."
}
finally {
    Pop-Location
}
