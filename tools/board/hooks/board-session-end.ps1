# board-session-end.ps1
# SessionEnd フック（docs/design/board.md §8）。
# このセッションの表明を `paused`（中断）に落とす。
#
# **なぜ done ではなく paused か。** セッションが終わっただけで作業が終わったとは限らない。
# 完了は本人が `board.ts done` で宣言する。放置された `working` は §5 の TTL（8時間）で
# 「古い表明」として一覧に区別表示される。
#
# **ボードに繋がらなくても何もしない（黙って終わる）。** このスクリプトは必ず exit 0 で終わる。
# .claude/settings.json の SessionEnd フックから呼び出す（登録例は tools/board/README.md）。

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
    exit 0
  }
  if ($sessionId -eq '') { exit 0 }  # どの表明か分からないので何もしない

  Invoke-Board -BoardArgs @('done', '--paused', '--json', '--timeout', '3000', '--session', $sessionId) | Out-Null

  # PreToolUse が使う「最初の編集は済んだ」印を片付ける（消せなくても実害は無い）
  try {
    $safeId = ($sessionId -replace '[^A-Za-z0-9_.-]', '_')
    $marker = Join-Path (Join-Path ([System.IO.Path]::GetTempPath()) 'claude-board') "$safeId.first-edit"
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  } catch { }
} catch {
  # 何が起きても本業を止めない
}
exit 0
