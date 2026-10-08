param(
  [Parameter(Mandatory = $true)][int]$RootProcessId,
  [string]$VerifyProcessIds = ''
)

$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
if ($VerifyProcessIds) {
  $wantedProcessIds = @($VerifyProcessIds.Split(',') | ForEach-Object { [int]$_ })
  $remaining = @($processes | Where-Object { $wantedProcessIds -contains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId })
  foreach ($processId in $remaining) { Write-Output $processId }
  exit 0
}

$root = $processes | Where-Object { [int]$_.ProcessId -eq $RootProcessId } | Select-Object -First 1
if (-not $root) { exit 0 }
$seen = [System.Collections.Generic.HashSet[int]]::new()
$pending = [System.Collections.Generic.Queue[int]]::new()
[void]$seen.Add($RootProcessId)
$pending.Enqueue($RootProcessId)
while ($pending.Count -gt 0) {
  $parentId = $pending.Dequeue()
  foreach ($child in $processes | Where-Object { [int]$_.ParentProcessId -eq $parentId }) {
    $childId = [int]$child.ProcessId
    if ($seen.Add($childId)) { $pending.Enqueue($childId) }
  }
}
foreach ($processId in ($seen | Sort-Object)) { Write-Output $processId }
