#!/bin/bash

echo "============================================================"
echo "  MeetAI — Setup Script (Linux/Mac)"
echo "============================================================"
echo

# Python check
if ! command -v python3 &>/dev/null; then
  echo "[ERROR] python3 not found. Install Python 3.10+"
  exit 1
fi

echo "[1/4] Upgrading pip..."
python3 -m pip install --upgrade pip

echo
echo "[2/4] Installing PyTorch with CUDA..."
# For CUDA 11.8 (adjust if you have a different CUDA version)
pip3 install torch==2.1.0 torchvision==0.16.0 torchaudio==2.1.0 --index-url https://download.pytorch.org/whl/cu118

echo
echo "[3/4] Installing Python dependencies..."
cd backend
pip3 install -r requirements.txt
cd ..

echo
echo "[4/4] Checking FFmpeg..."
if ! command -v ffmpeg &>/dev/null; then
  echo "[WARN] FFmpeg not found. Install with:"
  echo "       Ubuntu/Debian: sudo apt install ffmpeg"
  echo "       Mac:           brew install ffmpeg"
else
  echo "[OK] FFmpeg found: $(ffmpeg -version 2>&1 | head -1)"
fi

echo
echo "============================================================"
echo "  Setup complete!"
echo "  Run: ./start.sh to launch MeetAI"
echo "============================================================"
