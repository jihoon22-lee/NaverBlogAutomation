param(
    [Parameter(Mandatory = $true)]
    [string]$TargetUrl,

    [Parameter(Mandatory = $true)]
    [string]$Expression
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Receive-CdpMessage {
    param([System.Net.WebSockets.ClientWebSocket]$Socket)

    $buffer = [System.Array]::CreateInstance([byte], 65536)
    $segment = [System.ArraySegment[byte]]::new($buffer)
    $builder = [System.Text.StringBuilder]::new()
    do {
        $result = $Socket.ReceiveAsync($segment, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
            throw "Chrome DevTools connection closed unexpectedly."
        }
        [void]$builder.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count))
    } while (-not $result.EndOfMessage)
    return $builder.ToString() | ConvertFrom-Json
}

$targets = Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/list" -TimeoutSec 3
$target = @($targets | Where-Object { $_.type -eq "page" -and $_.url -eq $TargetUrl })
if ($target.Count -ne 1) {
    throw "Expected exactly one CDP page matching the supplied URL; found $($target.Count)."
}

$socket = [System.Net.WebSockets.ClientWebSocket]::new()
try {
    $null = $socket.ConnectAsync([Uri]$target[0].webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $request = @{ id = 1; method = "Runtime.evaluate"; params = @{ expression = $Expression; awaitPromise = $true; returnByValue = $true; userGesture = $true } } | ConvertTo-Json -Compress -Depth 8
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($request)
    $null = $socket.SendAsync([System.ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    do {
        $response = Receive-CdpMessage -Socket $socket
    } while ($response.id -ne 1)
    if ($null -ne $response.error) { throw $response.error.message }
    if ($null -ne $response.result.exceptionDetails) { throw $response.result.exceptionDetails.text }
    $response.result.result.value | ConvertTo-Json -Depth 16
} finally {
    if ($socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        try {
            $null = $socket.CloseOutputAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "done", [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        } catch {
            # A page may close its own DevTools target after an approved browser action.
        }
    }
    $socket.Dispose()
}
