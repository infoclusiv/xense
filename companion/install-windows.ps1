param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId,
  [string]$CodexPath,
  [switch]$Edge
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$folder = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $folder 'host.mjs'
if (-not (Test-Path $script)) { throw 'No se encontró companion/host.mjs.' }

# Chrome on Windows can launch the host via a .cmd wrapper.
$launcher = Join-Path $folder 'xense-native.cmd'
$lines = @('@echo off')
if ($CodexPath) {
  $resolvedCodex = (Resolve-Path -LiteralPath $CodexPath -ErrorAction Stop).ProviderPath
  if (-not (Test-Path -LiteralPath $resolvedCodex -PathType Leaf)) {
    throw 'El ejecutable de Codex seleccionado no existe.'
  }
  # The resolved path is inserted into a batch launcher; reject CMD metacharacters.
  if ($resolvedCodex -match '["%&|<>!^\r\n]') {
    throw 'La ruta del CLI contiene caracteres incompatibles con el lanzador de Windows.'
  }
  $lines += ('set "XENSE_CODEX_PATH={0}"' -f $resolvedCodex)
}
$lines += ('"{0}" "{1}"' -f $node, $script)
[IO.File]::WriteAllLines($launcher, $lines, [Text.Encoding]::ASCII)

$manifest = Join-Path $folder 'com.infoclusiv.xense.json'
$json = @{
  name = 'com.infoclusiv.xense'
  description = 'Xense native AI bridge'
  path = $launcher
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($manifest, $json, (New-Object Text.UTF8Encoding($false)))

$browser = if ($Edge) { 'Microsoft\Edge' } else { 'Google\Chrome' }
$key = "HKCU:\Software\$browser\NativeMessagingHosts\com.infoclusiv.xense"
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifest
Write-Host 'XENSE_NATIVE_HOST_REGISTERED' -ForegroundColor Green
Write-Host "Host: $manifest"
Write-Host "Extension ID: $ExtensionId"
if ($CodexPath) { Write-Host "Codex seleccionado: $resolvedCodex" }
Write-Host 'Reabre Xense y pulsa Comprobar conexión.'
