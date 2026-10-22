# Registra o host do Claude Asker para Chrome, Edge e Brave (só para o seu usuário).
# Uso: powershell -ExecutionPolicy Bypass -File host\install.ps1
$ErrorActionPreference = "Stop"

$hostName = "com.claude_asker.host"
$hostDir = $PSScriptRoot
$node = (Get-Command node).Source
$claude = (Get-Command claude).Source
$extensionId = (& $node (Join-Path $hostDir "extension-id.mjs")).Trim()

# Arquivo .bat que o navegador executa (aponta para node e claude com caminho completo).
$batPath = Join-Path $hostDir "claude_asker_host.bat"
$bat = "@echo off`r`nset `"CLAUDE_BIN=$claude`"`r`n`"$node`" `"%~dp0host.js`" %*`r`n"
[IO.File]::WriteAllText($batPath, $bat, (New-Object Text.ASCIIEncoding))

# Manifesto do host (o navegador lê este JSON para saber o que executar).
$manifestPath = Join-Path $hostDir "$hostName.json"
$manifest = [ordered]@{
  name            = $hostName
  description     = "Claude Asker - ponte para o Claude Code"
  path            = $batPath
  type            = "stdio"
  allowed_origins = @("chrome-extension://$extensionId/")
} | ConvertTo-Json
[IO.File]::WriteAllText($manifestPath, $manifest, (New-Object Text.UTF8Encoding $false))

$browsers = @(
  "HKCU\Software\Google\Chrome\NativeMessagingHosts\$hostName",
  "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\$hostName",
  "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$hostName"
)
foreach ($key in $browsers) {
  reg add $key /ve /t REG_SZ /d $manifestPath /f | Out-Null
}

Write-Host "Host instalado."
Write-Host "  ID da extensao: $extensionId"
Write-Host "  node:   $node"
Write-Host "  claude: $claude"
