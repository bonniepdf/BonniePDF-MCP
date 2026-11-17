; Compile through package:windows so the portable payload is verified first.
#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef PayloadDir
  #error PayloadDir is required
#endif
#ifndef InstallerOutput
  #error InstallerOutput is required
#endif

[Setup]
; Stable product identity: preserve this GUID for all future upgrades.
AppId={{EFA4014C-302B-4F1A-B773-C2852FA81F90}
AppName=BonniePDF MCP
AppVersion={#AppVersion}
AppPublisher=CodeFocus Limited
AppPublisherURL=https://www.bonniepdf.dev
AppSupportURL=https://www.bonniepdf.dev/features/typescript/mcp-server
DefaultDirName={localappdata}\Programs\BonniePDF MCP
DefaultGroupName=BonniePDF MCP
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#InstallerOutput}
OutputBaseFilename=BonniePDFMCPSetup-{#AppVersion}-x64
; Editable wizard artwork, stretched by Inno if the sizes change:
; Rendered from the website logo and hero artwork at 4x resolution.
; Logical sizes: side 164x314 (left of wizard pages), top 55x58 (top right).
WizardImageFile=banner-side.bmp
WizardSmallImageFile=banner-top.bmp
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Default is 120: this gives the assistant tasks list more breathing room.
WizardSizePercent=130,130
DisableWelcomePage=no
LicenseFile={#PayloadDir}\LICENSE.txt
UninstallDisplayName=BonniePDF MCP
UninstallDisplayIcon={app}\runtime\node.exe
CloseApplications=yes
RestartApplications=no

[Languages]
Name: english; MessagesFile: compiler:Default.isl

[Tasks]
Name: codex; Description: Connect to Codex; GroupDescription: "Connect assistants for the current user:"; Flags: unchecked
Name: claudecode; Description: Connect to Claude Code; GroupDescription: "Connect assistants for the current user:"; Flags: unchecked
Name: claudedesktop; Description: Connect to Claude Desktop; GroupDescription: "Connect assistants for the current user:"; Flags: unchecked
Name: antigravity; Description: Connect to Antigravity; GroupDescription: "Connect assistants for the current user:"; Flags: unchecked
Name: vscode; Description: Connect to GitHub Copilot in VS Code (default profile); GroupDescription: "Connect assistants for the current user:"; Flags: unchecked
Name: visualstudio; Description: Connect to GitHub Copilot in Visual Studio; GroupDescription: "Connect assistants for the current user:"; Flags: unchecked
Name: copilotcli; Description: Connect to GitHub Copilot CLI; GroupDescription: "Connect assistants for the current user:"; Flags: unchecked
Name: zcode; Description: Connect to ZCode; GroupDescription: "Connect assistants for the current user:"; Flags: unchecked
Name: replace; Description: Replace an existing BonniePDF connection (a backup will be saved); GroupDescription: "Existing BonniePDF connections:"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Connect assistants"; Filename: "{app}\Connect assistants.cmd"; WorkingDir: "{app}"
Name: "{group}\Test connection"; Filename: "{app}\Test connection.cmd"; WorkingDir: "{app}"
Name: "{group}\Documentation"; Filename: "https://www.bonniepdf.dev/features/typescript/mcp-server"
Name: "{group}\Uninstall BonniePDF MCP"; Filename: "{uninstallexe}"

[Code]
var
  ConnectionsFailed: Boolean;

function RunManagement(const Arguments: String; const ReportName: String): Boolean;
var
  ExitCode: Integer;
  ReportPath: String;
begin
  ReportPath := GetEnv('BONNIEPDF_MCP_HOME');
  if ReportPath = '' then ReportPath := ExpandConstant('{localappdata}\BonniePDF\MCP');
  ReportPath := AddBackslash(ReportPath) + ReportName;
  Result := Exec(ExpandConstant('{app}\runtime\node.exe'),
    '"' + ExpandConstant('{app}\server\dist\index.js') + '" ' + Arguments +
    ' --report "' + ReportPath + '"', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ExitCode);
  Result := Result and (ExitCode = 0);
  if not Result then begin
    Log('BonniePDF MCP command failed: ' + Arguments + '. Report: ' + ReportPath);
    if not WizardSilent then
      MsgBox('BonniePDF MCP needs attention. See the diagnostic report at:' + #13#10 + ReportPath + #13#10 +
        'You can retry using the Connect assistants or Test connection shortcut.', mbError, MB_OK);
  end;
end;

procedure ConnectClient(const Task: String; const Client: String);
var
  Arguments: String;
begin
  if not WizardIsTaskSelected(Task) then exit;
  Arguments := 'setup --non-interactive --scope user --client ' + Client;
  if WizardIsTaskSelected('replace') then Arguments := Arguments + ' --replace';
  if not RunManagement(Arguments, 'setup-' + Client + '.json') then ConnectionsFailed := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    if not RunManagement('doctor', 'installer-doctor.json') then
      RaiseException('The installed BonniePDF MCP server failed its connection test. See the diagnostic report.');
    ConnectClient('codex', 'codex');
    ConnectClient('claudecode', 'claude-code');
    ConnectClient('claudedesktop', 'claude-desktop');
    ConnectClient('antigravity', 'antigravity');
    ConnectClient('vscode', 'vscode');
    ConnectClient('visualstudio', 'visual-studio');
    ConnectClient('copilotcli', 'copilot-cli');
    ConnectClient('zcode', 'zcode');
    if ConnectionsFailed then
      RaiseException('BonniePDF MCP is installed, but a selected client could not be configured. See the setup report and retry using Connect assistants.');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ExitCode: Integer;
begin
  if CurUninstallStep = usUninstall then begin
    if FileExists(ExpandConstant('{app}\runtime\node.exe')) then
      if not Exec(ExpandConstant('{app}\runtime\node.exe'),
        '"' + ExpandConstant('{app}\server\dist\index.js') + '" remove --all --non-interactive',
        ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
        Log('Some client connections could not be removed. User documents and settings were preserved.');
  end;
end;
