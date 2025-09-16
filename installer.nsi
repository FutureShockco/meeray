Name "Meeray Node"
OutFile "MeerayNodeSetup.exe"
InstallDir "$PROGRAMFILES\MeerayNode"
RequestExecutionLevel admin  ; Optional, required for Program Files installation

Section "Install"

    ; -------------------------
    ; 1. Install all folders/files
    ; -------------------------
    SetOutPath "$INSTDIR"
    File /r "build\dist"
    File /r "build\node_modules"
    File "build\node.exe"
    File "build\mongod.exe"

    ; -------------------------
    ; 2. Create writable logs folder in APPDATA
    ; -------------------------
    StrCpy $0 "$APPDATA\MeerayNode\logs"
    CreateDirectory "$0"

    FileOpen $1 "$INSTDIR\start.bat" w
    FileWrite $1 "@echo off$\r$\n"
    FileWrite $1 "setlocal$\r$\n"
    FileWrite $1 "REM Set up paths$\r$\n"
    FileWrite $1 "set NODE_EXE=%~dp0node.exe$\r$\n"
    FileWrite $1 "set MONGO_EXE=%~dp0mongod.exe$\r$\n"
    FileWrite $1 "set MONGO_DB_PATH=%LOCALAPPDATA%\MeerayNode\mongo-data$\r$\n"
    FileWrite $1 "set LOG_DIR=%APPDATA%\MeerayNode\logs$\r$\n"
    FileWrite $1 "set APP_DIR=%~dp0dist$\r$\n"
    FileWrite $1 "$\r$\n"
    FileWrite $1 "REM Create directories if they don't exist$\r$\n"
    FileWrite $1 "if not exist $\"%MONGO_DB_PATH%$\" mkdir $\"%MONGO_DB_PATH%$\"$\r$\n"
    FileWrite $1 "if not exist $\"%LOG_DIR%$\" mkdir $\"%LOG_DIR%$\"$\r$\n"
    FileWrite $1 "$\r$\n"
    FileWrite $1 "REM Start MongoDB in the background$\r$\n"
    FileWrite $1 "start $\"MongoDB$\" /MIN $\"%MONGO_EXE%$\" --dbpath $\"%MONGO_DB_PATH%$\" --port 27017$\r$\n"
    FileWrite $1 "$\r$\n"
    FileWrite $1 "echo Waiting for MongoDB to start...$\r$\n"
    FileWrite $1 "timeout /t 5$\r$\n"
    FileWrite $1 "$\r$\n"
    FileWrite $1 "echo Starting Meeray Node...$\r$\n"
    FileWrite $1 "REM Start the Meeray node with LOG_DIR environment variable$\r$\n"
    FileWrite $1 "$\"%NODE_EXE%$\" $\"%APP_DIR%\main.js$\"$\r$\n"
    FileWrite $1 "$\r$\n"
    FileWrite $1 "echo Application has exited. Press any key to close...$\r$\n"
    FileWrite $1 "pause$\r$\n"
    FileWrite $1 "endlocal$\r$\n"
    FileClose $1

    ; -------------------------
    ; 4. Create desktop shortcut
    ; -------------------------
    CreateShortCut "$DESKTOP\Meeray Node.lnk" "$INSTDIR\start.bat"

SectionEnd