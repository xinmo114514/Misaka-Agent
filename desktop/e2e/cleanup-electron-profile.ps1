param(
  [Parameter(Mandatory = $true)][string]$TempRoot,
  [Parameter(Mandatory = $true)][string]$Profile
)

$resolvedRoot = [System.IO.Path]::GetFullPath($TempRoot).TrimEnd('\') + '\'
$resolvedProfile = [System.IO.Path]::GetFullPath($Profile)
$profileParent = [System.IO.Path]::GetDirectoryName($resolvedProfile).TrimEnd('\') + '\'
$profileName = [System.IO.Path]::GetFileName($resolvedProfile)

if ($profileParent -ne $resolvedRoot -or -not $profileName.StartsWith('misaka-electron-e2e-', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to clean a profile outside this Electron smoke test temp root.'
}

if (Test-Path -LiteralPath $resolvedProfile) {
  Remove-Item -LiteralPath $resolvedProfile -Recurse -Force -ErrorAction Stop
}
if (Test-Path -LiteralPath $resolvedProfile) {
  throw 'Electron smoke profile still exists after cleanup.'
}
