@echo off
echo ============================================================
echo   MeetAI — Setup Script (Windows)
echo   GPU: RTX 3050 (CUDA)
echo ============================================================
echo.

:: choose Python interpreter via the py launcher if available
set PYTHONCMD=

:: try specific versions via the launcher
py -3.11 -c "import sys" >nul 2>&1
if %errorlevel% equ 0 set PYTHONCMD=py -3.11
if not defined PYTHONCMD (
    py -3.10 -c "import sys" >nul 2>&1
    if %errorlevel% equ 0 set PYTHONCMD=py -3.10
)

:: fallback
if not defined PYTHONCMD set PYTHONCMD=python

echo [INFO] Using interpreter: %PYTHONCMD%

:: verify the interpreter works
%PYTHONCMD% --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Unable to run Python interpreter.
    pause
    exit /b 1
)

:: check version compatibility
for /f "tokens=1-2 delims=. " %%A in ('%PYTHONCMD% -c "import sys; print(sys.version_info.major, sys.version_info.minor)"') do (
    set PY_MAJOR=%%A
    set PY_MINOR=%%B
)
if %PY_MAJOR% LSS 3 (
    echo [ERROR] Python 3.10 or later is required.
    pause
    exit /b 1
)
if %PY_MAJOR% EQU 3 if %PY_MINOR% GTR 13 (
    echo [WARN] Detected Python %PY_MAJOR%.%PY_MINOR% – this version may not have CUDA wheels for torch.
    echo       Consider using Python 3.10 or 3.11 for best compatibility.
    echo.
)

:: create virtual environment if not present
if not exist venv (
    echo [INFO] Creating virtual environment in venv\
    %PYTHONCMD% -m venv venv
)

:: activate venv
call venv\Scripts\activate.bat

echo [1/4] Upgrading pip and build tools...
%PYTHONCMD% -m pip install --upgrade pip setuptools wheel

echo.
echo [2/4] Installing PyTorch with CUDA 11.8 support (for RTX 3050)...
echo       This may take several minutes (~2GB download)
:: install latest compatible torch/vision/torchaudio; omit explicit version so wheels for your Python are selected
%PYTHONCMD% -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118

echo.
echo [3/4] Installing Python dependencies...
cd backend
%PYTHONCMD% -m pip install -r requirements.txt
cd ..

echo.
echo [4/4] Checking FFmpeg...
ffmpeg -version >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN] FFmpeg not found in PATH.
    echo        Whisper needs FFmpeg to process audio.
    echo        Download from: https://ffmpeg.org/download.html
    echo        Add ffmpeg\bin to your system PATH.
    echo.
) else (
    echo [OK] FFmpeg found.
)

echo.
echo ============================================================
echo   Setup Complete!
echo   Run: start.bat  to launch MeetAI
echo ============================================================
pause
