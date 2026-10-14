$ErrorActionPreference = 'Stop'
$taskName = 'HorseBook-DailySnapshot-kdnhvunmtfqfkhcxtlqp'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $taskName
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Output 'Removed the automatic HorseBook backup task. Existing snapshots were retained.'
} else {
  Write-Output 'No automatic HorseBook backup task is installed on this PC.'
}
