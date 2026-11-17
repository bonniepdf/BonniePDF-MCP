@echo off
rem Compiles core and the MCP server, then builds the Windows installer.
rem Requires Node.js 24+, pnpm, and Inno Setup 6.3+ (or ISCC_PATH pointing at ISCC.exe).
setlocal

for %%I in ("%~dp0..\..") do set "ESTATE=%%~fI"

where node >nul 2>nul || (echo Node.js 24 or later is required. & exit /b 1)
where pnpm >nul 2>nul || (echo pnpm is required. & exit /b 1)

echo Estate root: %ESTATE%
cd /d "%ESTATE%" || exit /b 1

echo.
echo === Installing workspace dependencies ===
call pnpm install || goto :fail

echo.
echo === Building @bonniepdf/core ===
call pnpm --filter @bonniepdf/core build || goto :fail

echo.
echo === Building the server and packaging the installer ===
call pnpm --filter @bonniepdf/mcp package:windows || goto :fail

echo.
echo Done. The installer and its manifest are in:
echo   %ESTATE%\BonniePDF-MCP\out\releases\
echo latest.json there points at the most recent build.
pause
exit /b 0

:fail
echo.
echo Build failed. See the output above.
pause
exit /b 1
