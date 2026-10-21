@echo off
rem  cmd 是照位元組位置一行一行讀批次檔的，而 [1/7] 的 checkout／pull 可能改到這支自己——
rem  改了之後後面的行會從錯的位置讀起。所以先複製到 %TEMP% 再從那份跑（不加 call＝轉過去不回來）。
if /i not "%~f0"=="%TEMP%\sync-rules-run.cmd" (
  copy /y "%~f0" "%TEMP%\sync-rules-run.cmd" >nul && "%TEMP%\sync-rules-run.cmd" %*
)
setlocal
rem ============================================================================
rem  Windows 上把規則同步到生效位置。pull 之後一定要跑這一支。
rem
rem  為什麼不能只 git pull：
rem    · 這台沒開 Developer Mode，**檔案沒辦法 symlink**。所以 ~/.claude/CLAUDE.md
rem      不是連結，是一個一行 @import 的實體檔（import 的相對路徑以它自己為基準）。
rem    · ~/.codex/AGENTS.md 是**硬連結**。git 換檔案的方式是「寫暫存檔再 rename」，
rem      所以 pull 一旦動到 AGENTS.md，硬連結就會**安靜地脫鉤**，Codex 從此讀到舊的。
rem      這支每次重建它，就不必記得這件事。
rem
rem  2026-09-08 在 BRUCEVICTUS 實測：mklink /J 與 /H 在**未提權**的 SSH session
rem  也建得起來，不需要系統管理員。（舊的記憶檔寫「junction 一定要提權」是錯的。）
rem
rem  用法：  sync-rules.cmd [分支]
rem
rem  分支預設 feature/dataviz-tufte-skills：claude-skills 的工作都合進那條，不是 master
rem  （master 停在 2026-10-07）。2026-10-21 實測兩台 Windows 一直 pull master，
rem  晚了 96 個 commit——規則與 hook 全是舊的，而且沒有任何錯誤訊息。
rem  主幹換了就改下面 BRANCH 那一行（memsync 的 BRANCH 也要一起改）。
rem ============================================================================

set "CLAUDE=%USERPROFILE%\.claude"
set "SRC=%CLAUDE%\skills\home\claude"
set "CODEX=%USERPROFILE%\.codex"
set "BRANCH=feature/dataviz-tufte-skills"
set "FIELDS_FAIL="
if not "%~1"=="" set "BRANCH=%~1"

echo.
echo   [1/7] 更新 skills repo（%BRANCH%）
pushd "%CLAUDE%\skills" || (echo   找不到 %CLAUDE%\skills & exit /b 1)
git fetch origin "%BRANCH%" || (echo   fetch 不到 %BRANCH% —— 遠端可能已沒有這條分支（主幹換了？改 BRANCH 那一行） & popd & exit /b 1)
git fetch origin
git checkout "%BRANCH%" || (echo   切不到 %BRANCH% —— 工作區有會被蓋掉的未提交改動，或 clone 是 single-branch 建不起追蹤分支 & popd & exit /b 1)
git pull --ff-only origin "%BRANCH%" || (echo   pull 失敗 —— 先處理工作區的未提交改動 & popd & exit /b 1)
rem  AGENTS.md 上限 150 行由 repo 內的 pre-commit 擋（2026-10-07）；hooksPath 是本機設定，不會跟著 clone
git config core.hooksPath githooks
popd

echo.
echo   [2/7] ~/.claude/CLAUDE.md（一行 import，不是連結）
> "%CLAUDE%\CLAUDE.md" echo # CLAUDE.md
>>"%CLAUDE%\CLAUDE.md" echo @skills/home/claude/CLAUDE.md

echo.
echo   [3/7] rules/ junction
if exist "%CLAUDE%\rules" rmdir "%CLAUDE%\rules" 2>nul
mklink /J "%CLAUDE%\rules" "%SRC%\rules" >nul || echo   rules junction 建立失敗

echo.
echo   [4/7] 硬連結（每次重建，避免 pull 之後安靜脫鉤）
if not exist "%CODEX%" mkdir "%CODEX%"
if exist "%CODEX%\AGENTS.md" del "%CODEX%\AGENTS.md"
mklink /H "%CODEX%\AGENTS.md" "%SRC%\AGENTS.md" >nul || echo   codex AGENTS.md 失敗
if exist "%CLAUDE%\ARCHITECTURE.md" del "%CLAUDE%\ARCHITECTURE.md"
mklink /H "%CLAUDE%\ARCHITECTURE.md" "%SRC%\ARCHITECTURE.md" >nul || echo   ARCHITECTURE.md 失敗

echo.
echo   [5/7] Codex 的 skill（格式跟 Claude 一樣，直接 junction 過去）
rem  光接上去不會生效：skill 的 body 只有在模型決定要用它時才載入，而 Codex
rem  預設的 model_reasoning_effort 是 none —— 實測它不會去載，於是全部接上了
rem  卻等於裝飾品，而且沒有任何錯誤訊息。config.toml 要有 medium。
if not exist "%CODEX%\skills" mkdir "%CODEX%\skills"
set SKILLN=0
for /d %%D in ("%CLAUDE%\skills\*") do (
  if exist "%%D\SKILL.md" (
    if exist "%CODEX%\skills\%%~nxD" rmdir "%CODEX%\skills\%%~nxD" 2>nul
    mklink /J "%CODEX%\skills\%%~nxD" "%%D" >nul && set /a SKILLN+=1
  )
)
setlocal enabledelayedexpansion & echo     接了 !SKILLN! 個 skill & endlocal
rem 「沒裝 Codex」跟「裝了但沒設」是兩件事，訊息要分得出來，
rem 不然在沒裝 Codex 的機器上會一直看到一句像故障的警告。
if not exist "%CODEX%\config.toml" (
  echo     這台沒有 ~/.codex/config.toml —— 八成還沒裝 Codex。
  echo     skill 連結先放著，裝了之後記得設 model_reasoning_effort。
) else (
  findstr /b /c:"model_reasoning_effort" "%CODEX%\config.toml" >nul 2>&1 ^
    && (echo     config.toml 有 model_reasoning_effort，skill 會真的被載入) ^
    || (echo     [!] config.toml 有，但沒有 model_reasoning_effort —— skill 接了也不會生效)
)

echo.
echo   [6/7] Stop hook（settings.json 不進版控，所以規則會到、擋它的機制不會）
rem  2026-09-10 抓到的漂移：兩台 Windows 的 AGENTS.md 跟 Air 逐位元相同、
rem  ask-with-options.mjs 也 junction 進來了，但 settings.json 都沒掛它——
rem  於是「問句一律給選項」在那兩台只是文字。這種漂移不會有人發現，
rem  因為沒掛的症狀是「什麼都沒發生」，跟「掛了而這回合沒違規」一模一樣。
node "%SRC%\tools\mount-stop-hook.mjs" 2>nul || echo     [!] 掛載失敗（node 不在 PATH？）自己跑一次看訊息

echo.
echo   [7/7] settings.json 的共通欄位（子代理預設 Sonnet、關閉閒置壓縮…，清單在 settings-fields.mjs）
rem  同一個漏洞的另一半：mac 改 repo 裡的 settings.json 就生效，這兩台的 settings.json 是實體檔，
rem  2026-10-21 加的欄位在這裡一個都沒有。缺才補，已對就不動檔案。
node "%SRC%\tools\settings-fields.mjs" || (echo     [!] 補欄位失敗，往上看訊息 & set FIELDS_FAIL=1)

echo.
echo   ---- 驗證（沉默不等於成功，所以每一項都印出來）----
set OK=1
for %%F in ("%CLAUDE%\CLAUDE.md" "%SRC%\CLAUDE.md" "%SRC%\AGENTS.md" "%SRC%\rules\browser.md" "%CLAUDE%\rules\browser.md" "%CODEX%\AGENTS.md") do (
  if exist %%F (echo     OK   %%~F) else (echo     FAIL %%~F & set OK=0)
)
echo.
if defined FIELDS_FAIL set OK=0
if "%OK%"=="1" (echo   六個檔都在、設定欄位齊全。Claude 走 CLAUDE.md 的 import 鏈，Codex 走 ~/.codex/AGENTS.md。) else (echo   有項目失敗，往上看 FAIL 那幾行。& exit /b 1)
endlocal
