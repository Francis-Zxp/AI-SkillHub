# Fixed recipe actions only. Called with paths resolved by Rust, never scripts
# supplied by a repository or the webview. No project, page, or data operations.
$ErrorActionPreference = 'Stop'
$processes = @(Get-Process -Name Origin64 -ErrorAction SilentlyContinue)
if ($processes.Count -ne 1) { throw 'Keep exactly one Origin window open, then retry.' }
$apps = $env:SKILLHUB_ORIGIN_APPS
$action = $env:SKILLHUB_ORIGIN_ACTION
if ($action -notin @('register', 'start')) { throw 'Unsupported bridge action.' }
if ($apps -match '["%;\r\n]') { throw 'This path requires manual registration.' }
$origin = New-Object -ComObject Origin.ApplicationSI
try {
    $current = @(Get-Process -Name Origin64)
    if ($current.Count -ne 1 -or $current[0].Id -ne $processes[0].Id) { throw 'Origin process changed; no command executed.' }
    if ($action -eq 'register') {
        $registryPath = Join-Path $apps 'OPXList.xml'
        foreach ($name in @('Origin MCP Bridge Start', 'Origin MCP Bridge Stop')) {
            $registered = $false
            if (Test-Path -LiteralPath $registryPath) {
                $xml = New-Object Xml.XmlDocument
                $xml.XmlResolver = $null
                $xml.Load($registryPath)
                $registered = @($xml.SelectNodes('/OriginStorage/Package') | Where-Object { $_.GetAttribute('Label') -eq $name }).Count -gt 0
            }
            if ($registered) { continue }
            $opx = Join-Path $apps ($name + '.opx')
            if (-not $origin.Execute(('mkOPX app:="' + $name + '" opx:="' + $opx + '";'), [Type]::Missing)) { throw 'App packaging failed.' }
            if (-not (Test-Path -LiteralPath $opx)) { throw 'App package was not created.' }
            Write-Output ('Registering ' + $name + '; confirm the Origin dialog if displayed.')
            if (-not $origin.Execute(('instOPX fname:="' + $opx + '";'), [Type]::Missing)) { throw 'App registration failed.' }
        }
    } else {
        $entry = Join-Path $apps 'Origin MCP Bridge Start\start_bridge.py'
        if (-not (Test-Path -LiteralPath $entry)) { throw 'Bridge entry point is missing.' }
        # The author's foreground bridge pumps the Origin message loop. This
        # call returns when the bridge stops. Rust retains this helper while it
        # is running, rather than terminating the user's Origin process.
        if (-not $origin.Execute(('run -pyf "' + $entry + '";'), [Type]::Missing)) { throw 'Bridge start failed.' }
    }
} finally {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($origin)
}
