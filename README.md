# 🎙 MeetAI — GPU-Powered Meeting Platform

A full Zoom-like meeting platform that transcribes speech to text in real-time
and summarizes your entire meeting — **100% locally on your GPU** using:

- 🎤 **OpenAI Whisper** (medium model) — State-of-the-art speech recognition
- 🤖 **DistilBART** (sshleifer/distilbart-cnn-12-6) — Neural meeting summarization
- 📹 **WebRTC** — Peer-to-peer video/audio (no relay server needed on LAN)
- ⚡ **CUDA** — Runs on your RTX 3050 (zero cloud, zero API costs)

---

## 🖥️ Your System Compatibility

| Component      | Your Spec            | Required     | Status |
|----------------|----------------------|--------------|--------|
| CPU            | Intel i7             | Any modern   | ✅     |
| RAM            | 16 GB                | 8 GB+        | ✅     |
| GPU            | RTX 3050 45W TGP     | 4 GB+ VRAM   | ✅     |
| CUDA           | Supported            | CUDA 11.8+   | ✅     |
| VRAM Usage     | ~2.5 GB (both models)| < 4 GB       | ✅     |

---

## 📁 Project Structure

```
meetai/
├── backend/
│   ├── app.py              # Flask server (Whisper + BART + WebRTC signaling)
│   └── requirements.txt    # Python dependencies
├── frontend/
│   ├── index.html          # Landing page (create/join meeting)
│   ├── meeting.html        # Meeting room (video + transcript + summary)
│   ├── css/
│   │   ├── index.css       # Landing page styles
│   │   └── meeting.css     # Meeting room styles
│   └── js/
│       ├── index.js        # Landing page logic
│       └── meeting.js      # WebRTC + transcription + summarization
├── setup.bat               # Windows one-click setup
├── setup.sh                # Linux/Mac setup
├── start.bat               # Windows launch
├── start.sh                # Linux/Mac launch
└── README.md
```

---

## 🚀 Quick Start (Windows)

### Step 1 — Install Prerequisites

1. **Python 3.10+** → https://www.python.org/downloads/
   - ✅ Check "Add Python to PATH" during install

2. **FFmpeg** → https://ffmpeg.org/download.html
   - Download Windows build → extract → add `ffmpeg\bin` to System PATH
   - Test: `ffmpeg -version` in CMD

3. **CUDA Toolkit 11.8** (if not already installed)
   - https://developer.nvidia.com/cuda-11-8-0-download-archive
   - Or check: `nvcc --version`

### Step 2 — Run Setup

```
Double-click setup.bat
```

This installs PyTorch (CUDA) + all Python packages automatically. Takes ~5 minutes on first run.

### Step 3 — Launch

```
Double-click start.bat
```

Open **http://localhost:5000** in your browser.

---

## 🚀 Quick Start (Linux/Mac)

```bash
chmod +x setup.sh start.sh
./setup.sh
./start.sh
```

---

## 🌐 Using MeetAI

### Create a Meeting
1. Go to http://localhost:5000
2. Enter a meeting title + your name
3. Click **Start Meeting**
4. Share the 8-character **Room Code** with participants

### Join a Meeting
1. Go to http://localhost:5000
2. Enter the Room Code + your name
3. Click **Join Meeting**

### During the Meeting
| Button       | Function                                              |
|--------------|-------------------------------------------------------|
| 🎙 Mic       | Toggle microphone on/off                             |
| 📷 Camera    | Toggle camera on/off                                  |
| ◎ Transcribe | **Start live speech-to-text** (Whisper on GPU)       |
| ✦ Summarize  | **Generate AI summary** (DistilBART on GPU)          |
| 💬 Chat      | In-meeting text chat                                  |
| ⬇ Export    | Download transcript + summary as .txt file            |

---

## ⚡ AI Models

### Whisper (Medium)
- **Purpose**: Convert spoken audio → text in real-time
- **Language**: Auto-detects 100+ languages
- **Accuracy**: ~96% on clear English speech
- **VRAM**: ~1.5 GB
- **Speed on RTX 3050**: ~2–4x real-time (8s audio → ~2–4s result)

### DistilBART (distilbart-cnn-12-6)
- **Purpose**: Summarize the full meeting transcript
- **VRAM**: ~1.2 GB
- **Quality**: Generates coherent abstractive summaries
- **Speed**: ~5–15 seconds for a 1-hour meeting transcript

---

## 🔧 Configuration

Edit `backend/app.py` to change:

```python
# Change Whisper model size:
whisper_model = whisper.load_model("medium", device=device)
# Options: "tiny", "base", "small", "medium", "large"
# "medium" is recommended for RTX 3050

# Change summarizer:
summarizer_pipe = pipeline("summarization", model="sshleifer/distilbart-cnn-12-6", ...)
# Alternative: "facebook/bart-large-cnn" (higher quality, more VRAM)

# Change recording chunk duration (seconds):
# In meeting.js → startRecordingChunk() → setTimeout(..., 8000)
# Larger = more context for Whisper, less frequent updates
```

---

## 🏠 Local Network (LAN) Meetings

For others on your Wi-Fi/LAN to join:

1. Find your local IP: `ipconfig` (Windows) or `ip addr` (Linux)
2. Share: `http://192.168.x.x:5000`
3. For internet meetings, you'll need to expose port 5000 (ngrok, Cloudflare Tunnel, etc.)

---

## 🐛 Troubleshooting

**"Whisper model still loading"**
→ Wait 30–60 seconds on first run. Models are downloaded (~1.5 GB) on first launch.

**"No audio file" error**
→ Allow microphone permissions in your browser.

**FFmpeg not found**
→ Whisper requires FFmpeg for audio processing. Install and add to PATH.

**CUDA not detected**
→ Ensure NVIDIA drivers are up to date and CUDA Toolkit is installed.
→ Run `python -c "import torch; print(torch.cuda.is_available())"` — should print `True`.

**Port 5000 in use**
→ Change `port=5000` to another port in `backend/app.py`

---

## 📄 License

MIT — Free to use, modify, and distribute.

---

*Built with Flask, Socket.IO, OpenAI Whisper, HuggingFace Transformers, and WebRTC.*
*Runs entirely on your local GPU. No cloud. No subscriptions.*
