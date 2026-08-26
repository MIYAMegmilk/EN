# board-pre-tool-use.ps1
# PreToolUse フック（Edit / Write 系、docs/design/board.md §8）。
#
#   1. このセッションの表明が無く、かつ**セッション内で最初の Edit / Write** なら
#      permissionDecision=deny を返してブロックし、表明を促す。
#   2. 表明済みなら /api/claims/check の結果を見て、他人の表明やオープン PR と
#      重なるときだけ systemMessage で**警告する（通す）**。
#
# **ブロックは1セッションに1回だけ。** 編集のたびに止められるとフックごと無効化されるため
# （§8）。「1回やった」ことは一時ディレクトリの印ファイルで覚える。印は check を実際に
# 走らせる直前に付けるので、この先で何が起きても2回目以降は決してブロックしない。
#
# **ボードに落ちても作業は止めない。** 接続失敗・タイムアウト・未設定・想定外の例外は
# すべて「素通り」に倒す。このスクリプトは必ず exit 0 で終わる（§8）。
# .claude/settings.json の PreToolUse フックから呼び出す（登録例は tools/board/README.md）。

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

# 絶対パスをリポジトリルートからの相対パスにし、区切りを / に揃える
function ConvertTo-RepoPath {
  param([string]$Path, [string]$Root)
  $p = $Path
  if ($Root -and $p.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
    $p = $p.Substring($Root.Length)
  }
  return ($p -replace '\\', '/').TrimStart('/')
}

try {
  try {
    $data = [Console]::In.ReadToEnd() | ConvertFrom-Json
  } catch {
    exit 0  # 入力が空・不正なら安全側（通す）に倒す
  }
  if (-not $data) { exit 0 }

  $tool = [string]$data.tool_name
  if ($tool -notmatch '^(Edit|Write|MultiEdit|NotebookEdit)$') { exit 0 }

  # 触ろうとしているパスを集める（Edit / Write / MultiEdit は file_path、NotebookEdit は notebook_path）
  $paths = @()
  foreach ($key in 'file_path', 'notebook_path') {
    $value = $data.tool_input.$key
    if ($value) { $paths += (ConvertTo-RepoPath -Path ([string]$value) -Root ([string]$data.cwd)) }
  }
  $paths = $paths | Where-Object { $_ -ne '' } | Select-Object -Unique
  if (-not $paths -or $paths.Count -eq 0) { exit 0 }

  $sessionId = [string]$data.session_id
  if (-not $sessionId) { $sessionId = 'unknown' }

  # 「このセッションで1回ブロック済み（＝最初の編集は済んだ）」かどうかの印。
  # 印を先に付けるので、この後で例外が起きても2回目以降にブロックが再発しない。
  $isFirstEdit = $false
  try {
    $markerDir = Join-Path ([System.IO.Path]::GetTempPath()) 'claude-board'
    $safeId = ($sessionId -replace '[^A-Za-z0-9_.-]', '_')
    $marker = Join-Path $markerDir "$safeId.first-edit"
    if (-not (Test-Path -LiteralPath $marker)) {
      $isFirstEdit = $true
      New-Item -ItemType Directory -Path $markerDir -Force -ErrorAction SilentlyContinue | Out-Null
      Set-Content -LiteralPath $marker -Value (Get-Date -Format 'o') -Encoding utf8 -ErrorAction SilentlyContinue
    }
  } catch {
    $isFirstEdit = $false  # 印を扱えないなら、繰り返しブロックしないほうに倒す
  }

  $boardArgs = @('check') + $paths + @('--json', '--timeout', '3000', '--session', $sessionId)
  $raw = Invoke-Board -BoardArgs $boardArgs
  if (-not $raw) { exit 0 }

  $result = $null
  try { $result = $raw | ConvertFrom-Json } catch { exit 0 }
  if (-not $result) { exit 0 }

  # 未設定・接続できない → 素通り（最初の編集のときだけ、繋がらなかったことを知らせる）
  if (-not $result.reachable) {
    if ($isFirstEdit -and $result.message) {
      $notice = @{ systemMessage = '[作業ボード] ' + $result.message } | ConvertTo-Json -Depth 5 -Compress
      Write-Output $notice
    }
    exit 0
  }
  if (-not $result.ok) { exit 0 }  # ボードがエラーを返した場合も通す

  # 1. 未表明 かつ 最初の Edit / Write → ブロックして表明を促す
  if ($isFirstEdit -and ($result.claimed -eq $false)) {
    $reason = @(
      '作業ボードにこのセッションの表明がありません（docs/design/board.md §8）。',
      '着手の重複を防ぐため、最初の編集の前に「これから何を作るか」を表明してください。',
      '',
      ('  deno run --allow-net --allow-read --allow-env tools/board/board.ts claim "<これから作るもの>" ' +
        '--paths <触る予定のファイル> --session ' + $sessionId),
      '',
      '※ title / note に秘密情報を書かないこと。',
      '表明したら同じ編集をもう一度実行してください（ブロックは1セッションに1回だけです）。'
    ) -join "`n"
    $payload = @{
      hookSpecificOutput = @{
        hookEventName            = 'PreToolUse'
        permissionDecision       = 'deny'
        permissionDecisionReason = $reason
      }
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Output $payload
    exit 0
  }

  # 2. 重なりは警告のみ（分担済みの正当なケースがあるため、機械では決められない）
  $overlapCount = 0
  if ($result.overlaps) { $overlapCount = [int]$result.overlaps.claims + [int]$result.overlaps.prs }
  if ($overlapCount -gt 0) {
    $warn = @{ systemMessage = '[作業ボード] ' + $result.message } | ConvertTo-Json -Depth 5 -Compress
    Write-Output $warn
  }
} catch {
  # 何が起きても本業を止めない
}
exit 0
