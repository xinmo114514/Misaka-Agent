param(
    [string]$Python = '',
    [string]$TestPath = 'tests/test_home_governance.py'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Python) { $Python = Join-Path $repoRoot '.venv\Scripts\python.exe' }
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    throw "Python not found: $Python. Run uv sync --frozen --group dev first."
}

# Provision in the ignored development environment, using the native host's
# link support. Keep the fixture for inspection; no link or test is simulated.
$fixtureRoot = Join-Path $repoRoot ('.venv\home-symlink-' + [guid]::NewGuid().ToString('N'))
$target = Join-Path $fixtureRoot 'user\.misaka'
$alias = Join-Path $fixtureRoot 'linked\.misaka'
New-Item -ItemType Directory -Path $target -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $alias) -Force | Out-Null
$link = New-Item -ItemType SymbolicLink -Path $alias -Target $target
if ($link.LinkType -ne 'SymbolicLink') { throw 'Expected a real directory symbolic link.' }

$priorRoot = $env:MISAKA_TEST_HOME_SYMLINK_ROOT
$priorPluginAutoload = $env:PYTEST_DISABLE_PLUGIN_AUTOLOAD
Push-Location -LiteralPath $repoRoot
try {
    $env:MISAKA_TEST_HOME_SYMLINK_ROOT = $fixtureRoot
    $env:PYTEST_DISABLE_PLUGIN_AUTOLOAD = '1'
    & $Python -m pytest -q --tb=short -p pytest_asyncio.plugin -p no:cacheprovider $TestPath
    $testExitCode = $LASTEXITCODE
} finally {
    $env:MISAKA_TEST_HOME_SYMLINK_ROOT = $priorRoot
    $env:PYTEST_DISABLE_PLUGIN_AUTOLOAD = $priorPluginAutoload
    Pop-Location
}
exit $testExitCode
