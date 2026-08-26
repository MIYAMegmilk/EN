# board-session-start.ps1
# SessionStart フック（docs/design/board.md §8）。
# 作業ボードの表明一覧を取得し、additionalContext としてセッションの冒頭に差し込む。
# 「作業を始める前に必ず目に入る」ようにするためのもの。
#
# **ボードに繋がらなくても作業は止めない。** 取得できなければ何も出さずに終わる（§8）。
# このスクリプトは、どんな失敗をしても必ず exit 0 で終わる。
# .claude/settings.json の SessionStart フックから呼び出す（登録例は tools/board/README.md）。

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# board.ts を短い制限時間で実行し、標準出力を返す。失敗したら $null を返す
function Invoke-Board {
  param([string[]]$BoardArgs, [int]$TimeoutMs = 8000)
  try {
    $deno = Get-Command deno -ErrorAction SilentlyContinue
    if (-not $deno) { return $null }
    $script = Join-Path $PSScriptRoot '..\board.ts'
    if (-not (Test-Path -LiteralPath $script)) { return $null }
    $quoted = @('run', '--quiet', '--no-prompt', '--allow-net', '--allow-read', '--allow-env', $script) + $BoardArgs |
      ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }
    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
      $proc = Start-Process -FilePath $deno.Source -ArgumentList $quoted -NoNewWindow -PassThru `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile
      if (-not $proc.WaitForExit($TimeoutMs)) {
        try { $proc.Kill() } catch { }
        return $null
      }
      return (Get-Content -LiteralPath $outFile -Raw -Encoding UTF8)
    } finally {
      Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
    }
  } catch {
    return $null
  }
}

try {
  $sessionId = ''
  try {
    $data = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($data.session_id) { $sessionId = [string]$data.session_id }
  } catch {
    # 入力が空・不正でも一覧の表示自体はできるので、そのまま続ける
  }

  $boardArgs = @('list', '--json', '--timeout', '3000')
  if ($sessionId -ne '') { $boardArgs += @('--session', $sessionId) }
  $raw = Invoke-Board -BoardArgs $boardArgs
  if (-not $raw) { exit 0 }

  $result = $null
  try { $result = $raw | ConvertFrom-Json } catch { exit 0 }
  # 未設定・接続失敗のときは黙って通す（毎セッション文句を言われても仕方がない）
  if (-not $result -or -not $result.ok -or -not $result.message) { exit 0 }

  $context = $result.message + "`n" +
    '着手前に board.ts claim で表明すること（tools/board/README.md）。'
  $payload = @{
    hookSpecificOutput = @{
      hookEventName     = 'SessionStart'
      additionalContext = $context
    }
  } | ConvertTo-Json -Depth 5 -Compress
  Write-Output $payload
} catch {
  # 何が起きても本業を止めない
}
exit 0
