# Remove o registro do host do Claude Asker.
$hostName = "com.claude_asker.host"
$browsers = @(
  "HKCU\Software\Google\Chrome\NativeMessagingHosts\$hostName",
  "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\$hostName",
  "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$hostName"
)
foreach ($key in $browsers) {
  reg delete $key /f 2>$null | Out-Null
}
Write-Host "Host removido."
