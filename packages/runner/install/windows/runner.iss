#ifndef MyAppVersion
#define MyAppVersion "0.0.0"
#endif

#ifndef RunnerBinary
#define RunnerBinary SourcePath + "\..\..\vendor\win32-x64\nova-runner.exe"
#endif

[Setup]
AppId={{4CFA60CB-A89A-4D0C-A76C-60EC6B24A66C}
AppName=Nova Runner
AppVersion={#MyAppVersion}
AppPublisher=Nova
DefaultDirName={localappdata}\Programs\Nova Runner
DefaultGroupName=Nova Runner
DisableProgramGroupPage=yes
OutputBaseFilename=nova-runner-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\nova-runner.exe

[Files]
Source: "{#RunnerBinary}"; DestDir: "{app}"; DestName: "nova-runner.exe"; Flags: ignoreversion
Source: "{#SourcePath}\runner-task.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\runner-task.ps1"" -Mode Install -Executable ""{app}\nova-runner.exe"" -Config ""{localappdata}\Nova Runner\config.toml"""; StatusMsg: "正在启动 Nova Runner…"; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\runner-task.ps1"" -Mode Uninstall"; Flags: runhidden waituntilterminated

[UninstallDelete]
Type: files; Name: "{localappdata}\Nova Runner\config.toml"
Type: dirifempty; Name: "{localappdata}\Nova Runner"

[Code]
var
  ConnectionPage: TInputQueryWizardPage;

function TomlEscape(Value: String): String;
begin
  Result := StringChangeEx(Value, '\', '\\', True);
  Result := StringChangeEx(Result, '"', '\"', True);
end;

function HasLineBreak(Value: String): Boolean;
begin
  Result := (Pos(#10, Value) > 0) or (Pos(#13, Value) > 0);
end;

procedure InitializeWizard;
begin
  ConnectionPage := CreateInputQueryPage(
    wpSelectDir,
    '连接 Nova',
    '填写 Runner 的连接信息',
    '这些信息只保存在当前 Windows 用户目录中。安装完成后 Runner 会立即在后台启动。'
  );
  ConnectionPage.Add('Server URL：', False);
  ConnectionPage.Add('Runner Token：', True);
  ConnectionPage.Add('Workspace 根目录：', False);
  ConnectionPage.Values[2] := ExpandConstant('{userprofile}');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Server: String;
begin
  Result := True;
  if CurPageID <> ConnectionPage.ID then
    exit;

  Server := Lowercase(Trim(ConnectionPage.Values[0]));
  if (Pos('https://', Server) <> 1) and (Pos('http://', Server) <> 1) then
  begin
    MsgBox('Server URL 必须以 http:// 或 https:// 开头。', mbError, MB_OK);
    Result := False;
    exit;
  end;
  if Trim(ConnectionPage.Values[1]) = '' then
  begin
    MsgBox('Runner Token 不能为空。', mbError, MB_OK);
    Result := False;
    exit;
  end;
  if not DirExists(Trim(ConnectionPage.Values[2])) then
  begin
    MsgBox('Workspace 根目录不存在。', mbError, MB_OK);
    Result := False;
    exit;
  end;
  if HasLineBreak(ConnectionPage.Values[0]) or HasLineBreak(ConnectionPage.Values[1]) or
     HasLineBreak(ConnectionPage.Values[2]) then
  begin
    MsgBox('连接信息不能包含换行符。', mbError, MB_OK);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ConfigDirectory: String;
  ConfigPath: String;
  Contents: String;
  ExitCode: Integer;
  PowerShell: String;
  TaskScript: String;
begin
  Result := '';
  PowerShell := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  TaskScript := ExpandConstant('{app}\runner-task.ps1');
  if FileExists(TaskScript) then
  begin
    Exec(
      PowerShell,
      '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + TaskScript + '" -Mode Uninstall',
      '',
      SW_HIDE,
      ewWaitUntilTerminated,
      ExitCode
    );
    Sleep(500);
  end;

  ConfigDirectory := ExpandConstant('{localappdata}\Nova Runner');
  ConfigPath := ConfigDirectory + '\config.toml';
  if not ForceDirectories(ConfigDirectory) then
  begin
    Result := '无法创建 Runner 配置目录：' + ConfigDirectory;
    exit;
  end;

  Contents :=
    'server = "' + TomlEscape(Trim(ConnectionPage.Values[0])) + '"' + #13#10 +
    'token = "' + TomlEscape(Trim(ConnectionPage.Values[1])) + '"' + #13#10 +
    'workspace = "' + TomlEscape(Trim(ConnectionPage.Values[2])) + '"' + #13#10;
  if not SaveStringToFile(ConfigPath, Contents, False) then
    Result := '无法写入 Runner 配置：' + ConfigPath;
end;
