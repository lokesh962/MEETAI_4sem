@echo off
echo ============================================================
echo   MeetAI — Starting Server
echo ============================================================
echo.
echo   Open your browser to:  http://localhost:5000
echo   Share your local IP:   http://YOUR_LAN_IP:5000
echo.
echo   AI models will load in background.
echo   Whisper (medium) + DistilBART will run on your RTX 3050.
echo.
echo   Press Ctrl+C to stop.
echo ============================================================
echo.

:: activate venv if it exists
if exist venv\Scripts\activate.bat (
    call venv\Scripts\activate.bat
) else (
    echo [WARN] Virtual environment not found; using system Python
)

cd backend
python app.py
pause
