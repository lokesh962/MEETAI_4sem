"""
MeetAI - Backend Server
- Local Whisper (GPU) for speech-to-text
- Local BART (GPU) for meeting summarization
- WebRTC signaling via SocketIO
- No paid APIs required
"""

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room, leave_room
import os, tempfile, uuid, threading, subprocess
from datetime import datetime

app = Flask(__name__, static_folder='../frontend', static_url_path='')
app.config['SECRET_KEY'] = 'meetai-gpu-secret-2024'
CORS(app, origins="*")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading',
                    max_http_buffer_size=50 * 1024 * 1024)

# ── In-memory store ──────────────────────────────────────────────────────────
meetings = {}

# ── Model references ─────────────────────────────────────────────────────────
whisper_model   = None
summarizer_pipe = None
models_status   = {"whisper": "loading", "summarizer": "loading", "device": "detecting"}


def load_models():
    global whisper_model, summarizer_pipe, models_status

    try:
        import torch
        device     = "cuda" if torch.cuda.is_available() else "cpu"
        gpu_name   = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU"
        models_status["device"] = gpu_name
        print(f"[System] Device: {gpu_name}")
    except Exception as e:
        models_status["device"] = "CPU"
        device = "cpu"

    # Whisper medium — great accuracy, fits on RTX 3050 4GB VRAM
    try:
        import whisper
        print("[Whisper] Loading 'medium' model ...")
        whisper_model = whisper.load_model("medium", device=device)
        models_status["whisper"] = f"ready ({device.upper()})"
        print(f"[Whisper] Ready ✓")
    except Exception as e:
        models_status["whisper"] = f"error: {e}"
        print(f"[Whisper] Error: {e}")

    # DistilBART summarizer
    try:
        from transformers import pipeline
        import torch
        dev_id = 0 if torch.cuda.is_available() else -1
        print("[Summarizer] Loading distilbart-cnn-12-6 ...")
        summarizer_pipe = pipeline(
            "summarization",
            model="sshleifer/distilbart-cnn-12-6",
            device=dev_id
        )
        models_status["summarizer"] = f"ready ({'GPU' if dev_id == 0 else 'CPU'})"
        print("[Summarizer] Ready ✓")
    except Exception as e:
        models_status["summarizer"] = f"error: {e}"
        print(f"[Summarizer] Error: {e}")


threading.Thread(target=load_models, daemon=True).start()


# ═══════════════════════════════════════════════════════════════════════════════
# STATIC
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/')
def index():
    return send_from_directory('../frontend', 'index.html')

@app.route('/meeting')
def meeting_page():
    return send_from_directory('../frontend', 'meeting.html')

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('../frontend', path)


# ═══════════════════════════════════════════════════════════════════════════════
# API
# ═══════════════════════════════════════════════════════════════════════════════

@app.route('/api/status')
def api_status():
    try:
        import torch
        gpu_ok  = torch.cuda.is_available()
        gpu_mem = f"{torch.cuda.memory_allocated(0)//1024**2} MB used" if gpu_ok else "N/A"
    except:
        gpu_ok, gpu_mem = False, "N/A"
    return jsonify({
        "ok": True,
        "gpu_available": gpu_ok,
        "gpu_memory_used": gpu_mem,
        "models": models_status
    })


@app.route('/api/create-meeting', methods=['POST'])
def create_meeting():
    data    = request.json or {}
    room_id = str(uuid.uuid4())[:8].upper()
    meetings[room_id] = {
        'id':           room_id,
        'title':        data.get('title', 'Untitled Meeting'),
        'host':         data.get('host',  'Host'),
        'created_at':   datetime.now().isoformat(),
        'participants': [],
        'transcript':   [],
        'summary':      None,
        'is_active':    True
    }
    print(f"[Meeting] Created {room_id} — {meetings[room_id]['title']}")
    return jsonify({'room_id': room_id, 'meeting': meetings[room_id]})


@app.route('/api/meeting/<room_id>')
def get_meeting(room_id):
    m = meetings.get(room_id.upper())
    if not m:
        return jsonify({'error': 'Meeting not found'}), 404
    return jsonify(m)


@app.route('/api/transcribe', methods=['POST'])
def transcribe_audio():
    if 'audio' not in request.files:
        return jsonify({'error': 'No audio file'}), 400

    if models_status["whisper"] == "loading":
        return jsonify({'error': 'Whisper model still loading…', 'loading': True}), 503

    if "error" in models_status["whisper"]:
        return jsonify({'error': f'Whisper error: {models_status["whisper"]}'}), 503

    audio_file = request.files['audio']
    room_id    = request.form.get('room_id', '').upper()
    speaker    = request.form.get('speaker', 'Participant')

    # Try to convert audio to WAV using librosa (no ffmpeg needed)
    tmp_path = None
    try:
        import io
        import librosa
        import numpy as np
        import scipy.io.wavfile as wavfile
        
        audio_bytes = audio_file.read()
        # Load audio with librosa at 16kHz (what Whisper expects)
        audio_data, sr = librosa.load(io.BytesIO(audio_bytes), sr=16000)
        # Convert to int16 PCM for WAV
        audio_data_int16 = (np.clip(audio_data, -1, 1) * 32767).astype(np.int16)
        # Save as WAV
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
            wavfile.write(tmp.name, 16000, audio_data_int16)
            tmp_path = tmp.name
            print(f"[Audio] Converted to WAV: {tmp.name}")
    except Exception as e:
        print(f"[Audio] Librosa conversion failed ({e}), trying direct save...")
        # Fallback: just save the raw file
        try:
            audio_file.seek(0)
            with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as tmp:
                tmp.write(audio_file.read())
                tmp_path = tmp.name
                print(f"[Audio] Saved raw file: {tmp.name}")
        except Exception as e2:
            return jsonify({'error': f'Failed to save audio: {e2}'}), 400

    try:
        result   = whisper_model.transcribe(tmp_path, fp16=True, task="transcribe", verbose=False)
        text     = result['text'].strip()
        language = result.get('language', 'en')

        if not text:
            return jsonify({'text': '', 'success': True})

        entry = {
            'id':        str(uuid.uuid4()),
            'speaker':   speaker,
            'text':      text,
            'timestamp': datetime.now().isoformat(),
            'language':  language
        }

        if room_id and room_id in meetings:
            meetings[room_id]['transcript'].append(entry)
            socketio.emit('new_transcript', entry, room=room_id)

        print(f"[Whisper] {speaker}: {text[:80]}")
        return jsonify({'text': text, 'language': language, 'entry': entry, 'success': True})

    except Exception as e:
        print(f"[Whisper] Error: {e}")
        return jsonify({'error': str(e)}), 500
    finally:
        try: os.unlink(tmp_path)
        except: pass


@app.route('/api/transcribe-video', methods=['POST'])
def transcribe_video():
    if 'video' not in request.files:
        return jsonify({'error': 'No video file'}), 400

    if models_status["whisper"] == "loading":
        return jsonify({'error': 'Whisper model still loading…', 'loading': True}), 503

    if "error" in models_status["whisper"]:
        return jsonify({'error': f'Whisper error: {models_status["whisper"]}'}), 503

    video_file = request.files['video']
    room_id    = request.form.get('room_id', '').upper()
    speaker    = request.form.get('speaker', 'Participant')

    # Save video to temp file
    video_tmp_path = None
    audio_tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as tmp:
            video_file.read()  # Read the file content
            video_file.seek(0)  # Reset pointer
            tmp.write(video_file.read())
            video_tmp_path = tmp.name
            print(f"[Video] Saved video: {video_tmp_path}")

        # Extract audio using ffmpeg
        audio_tmp_path = video_tmp_path.replace('.mp4', '.wav')
        ffmpeg_cmd = [
            'ffmpeg', '-i', video_tmp_path, '-vn', '-acodec', 'pcm_s16le',
            '-ar', '16000', '-ac', '1', audio_tmp_path, '-y'
        ]
        result = subprocess.run(ffmpeg_cmd, capture_output=True, text=True)
        if result.returncode != 0:
            return jsonify({'error': f'FFmpeg error: {result.stderr}'}), 500

        print(f"[Audio] Extracted audio: {audio_tmp_path}")

        # Transcribe the extracted audio
        result_trans = whisper_model.transcribe(audio_tmp_path, fp16=True, task="transcribe", verbose=False)
        text     = result_trans['text'].strip()
        language = result_trans.get('language', 'en')

        if not text:
            return jsonify({'text': '', 'success': True})

        entry = {
            'id':        str(uuid.uuid4()),
            'speaker':   speaker,
            'text':      text,
            'timestamp': datetime.now().isoformat(),
            'language':  language
        }

        if room_id and room_id in meetings:
            meetings[room_id]['transcript'].append(entry)
            socketio.emit('new_transcript', entry, room=room_id)

        print(f"[Whisper] Video transcription {speaker}: {text[:80]}")
        return jsonify({'text': text, 'language': language, 'entry': entry, 'success': True})

    except Exception as e:
        print(f"[Video Transcription] Error: {e}")
        return jsonify({'error': str(e)}), 500
    finally:
        try: os.unlink(video_tmp_path)
        except: pass
        try: os.unlink(audio_tmp_path)
        except: pass


@app.route('/api/summarize/<room_id>', methods=['POST'])
def summarize_meeting(room_id):
    room_id = room_id.upper()
    m       = meetings.get(room_id)
    if not m:
        return jsonify({'error': 'Meeting not found'}), 404
    if not m['transcript']:
        return jsonify({'error': 'No transcript yet'}), 400

    transcript  = m['transcript']
    speakers    = list(set(e['speaker'] for e in transcript))
    total_words = sum(len(e['text'].split()) for e in transcript)
    duration    = _calc_duration(transcript)

    # ── BART summarization ────────────────────────────────────────────────────
    full_text = " ".join(f"{e['speaker']} said: {e['text']}" for e in transcript)
    ai_summary = ""

    if summarizer_pipe and "ready" in models_status["summarizer"]:
        try:
            words  = full_text.split()
            chunks = [" ".join(words[i:i+900]) for i in range(0, len(words), 900)]
            parts  = []
            for chunk in chunks[:5]:
                if len(chunk.split()) < 25:
                    parts.append(chunk)
                    continue
                out = summarizer_pipe(chunk, max_length=180, min_length=40, do_sample=False)
                parts.append(out[0]['summary_text'])
            ai_summary = " ".join(parts)
            print(f"[BART] Summary: {len(ai_summary)} chars")
        except Exception as e:
            ai_summary = f"(Summarization error: {e})"
    else:
        # Extractive fallback
        sents      = [e['text'] for e in transcript]
        ai_summary = " ".join(sents[:6]) + ("…" if len(sents) > 6 else "")

    # ── Build readable document ───────────────────────────────────────────────
    line = "─" * 60
    doc  = f"""MEETING SUMMARY REPORT
{line}
Title     : {m['title']}
Date      : {datetime.now().strftime('%B %d, %Y — %I:%M %p')}
Duration  : {duration}
Speakers  : {', '.join(speakers)}
Segments  : {len(transcript)}
Words     : {total_words}
{line}
AI-GENERATED SUMMARY  (DistilBART · runs entirely on your GPU)
{line}

{ai_summary}

{line}
FULL TRANSCRIPT
{line}

"""
    for e in transcript:
        ts   = e['timestamp'][11:19]
        doc += f"[{ts}]  {e['speaker']}\n  {e['text']}\n\n"

    doc += f"{line}\nGenerated locally by MeetAI — Zero cloud APIs\n"

    summary = {
        'text':           doc,
        'ai_summary':     ai_summary,
        'generated_at':   datetime.now().isoformat(),
        'total_segments': len(transcript),
        'speakers':       speakers,
        'duration':       duration,
        'total_words':    total_words
    }
    m['summary'] = summary
    socketio.emit('summary_ready', summary, room=room_id)
    return jsonify(summary)


@app.route('/api/export/<room_id>')
def export_meeting(room_id):
    m = meetings.get(room_id.upper())
    if not m:
        return jsonify({'error': 'Meeting not found'}), 404
    return jsonify({k: m[k] for k in ('title','created_at','participants','transcript','summary')})


def _calc_duration(transcript):
    if len(transcript) < 2:
        return "< 1 min"
    try:
        s   = datetime.fromisoformat(transcript[0]['timestamp'])
        e   = datetime.fromisoformat(transcript[-1]['timestamp'])
        sec = int((e - s).total_seconds())
        return f"{sec//60} min {sec%60} sec"
    except:
        return "Unknown"


# ═══════════════════════════════════════════════════════════════════════════════
# SOCKET.IO — WebRTC signaling + real-time events
# ═══════════════════════════════════════════════════════════════════════════════

@socketio.on('connect')
def on_connect():
    print(f"[Socket] Connected: {request.sid}")

@socketio.on('disconnect')
def on_disconnect():
    print(f"[Socket] Disconnected: {request.sid}")
    for room_id, m in meetings.items():
        before = len(m['participants'])
        m['participants'] = [p for p in m['participants'] if p.get('sid') != request.sid]
        if len(m['participants']) < before:
            socketio.emit('participant_left', {'sid': request.sid}, room=room_id)

@socketio.on('join_room')
def on_join(data):
    room_id = data.get('room_id','').upper()
    name    = data.get('name','Participant')
    if room_id not in meetings:
        emit('error', {'message': 'Room not found'})
        return
    join_room(room_id)
    participant = {'sid': request.sid, 'name': name, 'joined_at': datetime.now().isoformat()}
    meetings[room_id]['participants'].append(participant)
    emit('participant_joined', participant, room=room_id, include_self=False)
    emit('room_info', {
        'room_id':      room_id,
        'meeting':      {'title': meetings[room_id]['title'], 'host': meetings[room_id]['host']},
        'participants': meetings[room_id]['participants'],
        'transcript':   meetings[room_id]['transcript']
    })
    print(f"[Room] {name} joined {room_id}")

@socketio.on('leave_room')
def on_leave(data):
    room_id = data.get('room_id','').upper()
    leave_room(room_id)
    if room_id in meetings:
        meetings[room_id]['participants'] = [
            p for p in meetings[room_id]['participants'] if p.get('sid') != request.sid
        ]
    emit('participant_left', {'sid': request.sid}, room=room_id)

# WebRTC signaling
@socketio.on('webrtc_offer')
def on_offer(data):
    emit('webrtc_offer', {**data, 'from': request.sid}, room=data['target'])

@socketio.on('webrtc_answer')
def on_answer(data):
    emit('webrtc_answer', {**data, 'from': request.sid}, room=data['target'])

@socketio.on('webrtc_ice')
def on_ice(data):
    emit('webrtc_ice', {**data, 'from': request.sid}, room=data['target'])

@socketio.on('chat_message')
def on_chat(data):
    room_id = data.get('room_id','').upper()
    emit('chat_message', {**data, 'from': request.sid, 'time': datetime.now().strftime('%H:%M')}, room=room_id)


# ═══════════════════════════════════════════════════════════════════════════════
if __name__ == '__main__':
    print("\n" + "="*58)
    print("  🎙  MeetAI — GPU-Powered Meeting Platform")
    print("="*58)
    print("  Open  →  http://localhost:5000")
    print("  AI models loading in background …")
    print("="*58 + "\n")
    socketio.run(app, host='0.0.0.0', port=5000, debug=False, allow_unsafe_werkzeug=True)
