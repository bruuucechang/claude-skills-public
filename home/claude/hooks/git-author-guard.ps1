#Requires -Version 5.1
<#
  PreToolUse (matcher: Bash) - 擋下作者身分錯誤的 git commit。

  這是 mac 上那條 jq 版掛勾的 PowerShell 對應。存在的理由見同目錄 README：
  Windows 上 Claude Code 用 PowerShell 5.1 跑掛勾，POSIX shell 的寫法會直接剖析失敗，
  而失敗訊息會插進 TUI 的重繪裡。

  輸入：stdin 一段 JSON（Claude Code 給的），要看的是 .tool_input.command
  輸出：身分不對時印一段 JSON 要求 deny；其餘情況什麼都不印、exit 0
#>
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) } catch { }

$ALLOWED = @(
  'you@example.com',
  '262371352+bruuucechang@users.noreply.github.com'
)

function Quit0 { exit 0 }

# --- 讀 stdin ---------------------------------------------------------------
$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) { Quit0 }

try { $payload = $raw | ConvertFrom-Json } catch { Quit0 }
$cmd = $payload.tool_input.command
if ([string]::IsNullOrWhiteSpace($cmd)) { Quit0 }

# 只管 git commit
if ($cmd -notmatch 'git\s+commit') { Quit0 }

# --- 指令裡若有 cd <path>，身分要在那個目錄下判斷 --------------------------
$dir = $null
if ($cmd -match '(?m)^\s*cd\s+(?:/d\s+)?([^&;|]+)') {
  $dir = $Matches[1].Trim().Trim('"').Trim("'")
  if ($dir.StartsWith('~')) { $dir = $dir -replace '^~', $env:USERPROFILE }
}

$pushed = $false
if ($dir -and (Test-Path -LiteralPath $dir)) {
  Push-Location -LiteralPath $dir
  $pushed = $true
}

try {
  $email = (& git config user.email 2>$null | Select-Object -First 1)
  $name  = (& git config user.name  2>$null | Select-Object -First 1)
} finally {
  if ($pushed) { Pop-Location }
}

# 不在 repo 裡（拿不到身分）就不要擋——那不是身分錯，是還沒 git init
if ([string]::IsNullOrWhiteSpace($email)) { Quit0 }
if ($ALLOWED -contains $email.Trim()) { Quit0 }

# --- 身分不對：要求 deny ----------------------------------------------------
$reason = "這個 repo 的 git 作者是 `"$name <$email>`"，不是 GitHub 帳號 bruuucechang 底下的任一個有效身分" +
          "（you@example.com 或 262371352+bruuucechang@users.noreply.github.com）。" +
          "這台機器已經有一批 commit 掛在錯的信箱底下，推上去不會連到帳號。" +
          "先跑：git config user.name bruce && git config user.email you@example.com"

$out = @{
  hookSpecificOutput = @{
    hookEventName            = 'PreToolUse'
    permissionDecision       = 'deny'
    permissionDecisionReason = $reason
  }
}

# Write-Output 會依主控台碼頁編碼（這台是 950），JSON 裡的中文會壞掉；直接寫 UTF-8 位元組。
$json  = $out | ConvertTo-Json -Depth 5 -Compress
$bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
$stdout = [Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length)
$stdout.Flush()
exit 0
