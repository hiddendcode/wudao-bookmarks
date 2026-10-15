@echo off
rem ============================================================
rem  悟道书签管理器 - one-click build
rem  Double-click this file to bump the version and package
rem  both the Firefox .xpi and the Chrome/Edge .zip.
rem
rem  Pass-through examples:
rem     build.cmd -Bump none        repackage without bumping
rem     build.cmd -Bump minor       bump 1.4.x -> 1.5.0
rem ============================================================
setlocal
cd /d "%~dp0"

set "PSEXE=powershell"
where pwsh >nul 2>nul && set "PSEXE=pwsh"

"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (echo [OK] build finished) else (echo [FAILED] exit code %RC%)
echo.
pause
exit /b %RC%
