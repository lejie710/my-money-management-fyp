# Read-only port ownership snapshot. No process or network configuration is changed.
$ErrorActionPreference = 'Stop'
$wantedPorts = @(9099, 4409, 4500)
$rows = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $wantedPorts -contains $_.LocalPort } | ForEach-Object {
    [ordered]@{ address = $_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess }
})
ConvertTo-Json -InputObject $rows -Depth 3 -Compress
