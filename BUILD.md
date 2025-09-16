# Meeray Node Build & Packaging Instructions (Windows)

## 1. Prerequisites
- node.exe v20.19.5 (single file)
- mongod.exe v8.0.13 (single file)
- NSIS (Nullsoft Scriptable Install System) v3.11

## 2. Automated Build Steps
Run the following script from the project root to automate the full build and packaging process:

```
npm run build:prod
```

This script will:
- Install all dependencies (including devDependencies)
- Build the TypeScript project
- Install only production dependencies
- Copy dist/ and node_modules/ to build/

## 3. Verify Build Directory
After running the script, ensure `build/` contains:
- dist/
- node_modules/
- node.exe
- mongod.exe
- start.bat

## 4. Build the Installer
1. Open NSIS.
2. Open `installer.nsi` (from the project root directory):
  - Test the installer.
3. Compile the installer.

## 5. Install & Run
- Run the generated `MeerayNodeSetup.exe` installer.
- The app will be installed to `C:\Program Files (x86)\MeerayNode` by default.
- To launch, use the desktop shortcut or run `start.bat` in the install directory.

## 6. Important Notes
- The app must write logs and data to a user-writable directory (e.g., `%LOCALAPPDATA%\MeerayNode\logs`).
- If you change the build or packaging process, update this file accordingly.
