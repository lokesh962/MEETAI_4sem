// MeetAI — Meeting Room JS
// WebRTC + Whisper transcription + BART summarization

const API    = 'http://localhost:5000';
const socket = io(API, { transports: ['websocket','polling'] });

// ── URL params ─────────────────────────────────────────────────────────────────
const params  = new URLSearchParams(window.location.search);
const ROOM_ID = params.get('room') || '';
const MY_NAME = decodeURIComponent(params.get('name') || 'Participant');
const IS_HOST = params.get('host') === '1';

// ── State ──────────────────────────────────────────────────────────────────────
let localStream      = null;
let peers            = {};          // { sid: RTCPeerConnection }
let micEnabled       = true;
let camEnabled       = true;
let transcribing     = false;
let mediaRecorder    = null;
let audioChunks      = [];
let transcriptCount  = 0;
let meetingStartTime = Date.now();
let timerInterval    = null;

// ── DOM refs ───────────────────────────────────────────────────────────────────
const videoGrid      = document.getElementById('videoGrid');
const localVideo     = document.getElementById('localVideo');
const localOverlay   = document.getElementById('localOverlay');
const transcriptScroll = document.getElementById('transcriptScroll');
const transcriptEmpty  = document.getElementById('transcriptEmpty');
const entryCount     = document.getElementById('entryCount');
const captionBar     = document.getElementById('captionBar');
const captionSpeaker = document.getElementById('captionSpeaker');
const captionText    = document.getElementById('captionText');
const summaryText    = document.getElementById('summaryText');
const summaryEmpty   = document.getElementById('summaryEmpty');
const chatScroll     = document.getElementById('chatScroll');

// ── Boot ───────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  if (!ROOM_ID) { window.location.href = '/'; return; }

  document.getElementById('roomId').textContent = ROOM_ID;

  // Show join modal
  document.getElementById('modalName').value = MY_NAME;
  const mid = document.getElementById('joinModal');

  // Fetch meeting info
  fetch(`${API}/api/meeting/${ROOM_ID}`)
    .then(r => r.json())
    .then(m => {
      document.getElementById('roomTitle').textContent = m.title || ROOM_ID;
      document.getElementById('modalTitle').textContent = m.title || 'Joining Meeting';
      document.getElementById('modalSubtitle').textContent = `Hosted by ${m.host || 'Host'}`;
    })
    .catch(() => {});

  // Auto-fill name
  if (MY_NAME && MY_NAME !== 'Participant') {
    document.getElementById('modalName').value = MY_NAME;
  }

  pollAIStatus();
  startTimer();
});

// ── Join from modal ────────────────────────────────────────────────────────────
async function joinFromModal() {
  const nameInput = document.getElementById('modalName').value.trim();
  const name      = nameInput || MY_NAME;

  if (!name) { toast('Enter your name to continue', 'warn'); return; }

  // Update URL name
  const url = new URL(window.location);
  url.searchParams.set('name', name);
  window.history.replaceState({}, '', url);

  document.getElementById('localName').textContent = name;
  document.getElementById('joinModal').style.display = 'none';

  await initMedia();
  connectSocket(name);
}

// ── Media setup ───────────────────────────────────────────────────────────────
async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    localOverlay.style.opacity = '0';
    toast('Camera & microphone ready ✓', 'success');
  } catch (e) {
    try {
      // Try audio only
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      localOverlay.innerHTML = '🎙';
      toast('Audio only — no camera found', 'warn');
    } catch (e2) {
      toast('No camera/mic access. Check permissions.', 'error');
      localOverlay.innerHTML = '⚠';
    }
  }
}

// ── Socket.IO ──────────────────────────────────────────────────────────────────
function connectSocket(name) {
  socket.emit('join_room', { room_id: ROOM_ID, name });

  socket.on('room_info', (data) => {
    toast(`Joined "${data.meeting.title}"`, 'success');
    // Load existing transcript
    if (data.transcript && data.transcript.length > 0) {
      data.transcript.forEach(addTranscriptEntry);
    }
  });

  socket.on('participant_joined', (p) => {
    toast(`${p.name} joined the meeting`, 'info');
    addRemoteTile(p.sid, p.name);
    createOffer(p.sid);
  });

  socket.on('participant_left', (data) => {
    removeRemoteTile(data.sid);
    if (peers[data.sid]) {
      peers[data.sid].close();
      delete peers[data.sid];
    }
    updateVideoLayout();
  });

  socket.on('new_transcript', (entry) => {
    addTranscriptEntry(entry);
    // Show caption
    captionSpeaker.textContent = entry.speaker;
    captionText.textContent    = entry.text;
    captionBar.style.display   = 'flex';
    clearTimeout(captionBar._timeout);
    captionBar._timeout = setTimeout(() => captionBar.style.display = 'none', 6000);
  });

  socket.on('summary_ready', (summary) => {
    document.getElementById('summaryOverlay').style.display = 'none';
    showSummary(summary);
    switchTab('summary');
    toast('AI summary ready! ✦', 'success');
  });

  socket.on('chat_message', (msg) => {
    addChatMessage(msg, msg.from === socket.id);
  });

  // WebRTC signaling
  socket.on('webrtc_offer', async ({ from, offer }) => {
    const pc = getOrCreatePeer(from);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc_answer', { target: from, answer });
  });

  socket.on('webrtc_answer', async ({ from, answer }) => {
    const pc = peers[from];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('webrtc_ice', async ({ from, candidate }) => {
    const pc = peers[from];
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    }
  });

  socket.on('error', (err) => toast(err.message, 'error'));
  socket.on('disconnect', () => toast('Disconnected from server', 'error'));
}

// ── WebRTC ─────────────────────────────────────────────────────────────────────
function getOrCreatePeer(sid) {
  if (peers[sid]) return peers[sid];

  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  });
  peers[sid] = pc;

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  // ICE
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('webrtc_ice', { target: sid, candidate: e.candidate });
    }
  };

  // Remote stream
  pc.ontrack = (e) => {
    const tile = document.getElementById(`tile-${sid}`);
    if (tile) {
      let v = tile.querySelector('video');
      if (!v) {
        v = document.createElement('video');
        v.autoplay = true; v.playsinline = true;
        tile.insertBefore(v, tile.firstChild);
        const overlay = tile.querySelector('.video-overlay');
        if (overlay) overlay.style.opacity = '0';
      }
      v.srcObject = e.streams[0];
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      removeRemoteTile(sid);
      delete peers[sid];
      updateVideoLayout();
    }
  };

  return pc;
}

async function createOffer(sid) {
  const pc = getOrCreatePeer(sid);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('webrtc_offer', { target: sid, offer });
}

// ── Video tiles ────────────────────────────────────────────────────────────────
function addRemoteTile(sid, name) {
  if (document.getElementById(`tile-${sid}`)) return;

  const tile = document.createElement('div');
  tile.className  = 'video-tile';
  tile.id         = `tile-${sid}`;
  tile.innerHTML  = `
    <div class="video-overlay" style="opacity:1">${getInitials(name)}</div>
    <div class="video-label">
      <span>${name}</span>
      <span class="mic-indicator">🎙</span>
    </div>`;
  videoGrid.appendChild(tile);
  updateVideoLayout();
}

function removeRemoteTile(sid) {
  const tile = document.getElementById(`tile-${sid}`);
  if (tile) tile.remove();
  updateVideoLayout();
}

function updateVideoLayout() {
  const count = videoGrid.children.length;
  videoGrid.className = 'video-grid ' + (
    count === 1 ? 'one' :
    count === 2 ? 'two' :
    count === 3 ? 'three' :
    count === 4 ? 'four' : 'many'
  );
}

function getInitials(name) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);
}

// ── Controls ───────────────────────────────────────────────────────────────────
function toggleMic() {
  if (!localStream) return;
  const btn = document.getElementById('btnMic');
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  document.getElementById('micIcon').textContent = micEnabled ? '🎙' : '🔇';
  btn.className = 'ctrl-btn ' + (micEnabled ? 'active' : 'muted');
  document.getElementById('localMicIcon').textContent = micEnabled ? '🎙' : '🔇';

  // Pause/resume transcription
  if (!micEnabled && transcribing) stopRecordingChunk();
  if (micEnabled  && transcribing) startRecordingChunk();
}

function toggleCamera() {
  if (!localStream) return;
  const btn = document.getElementById('btnCam');
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
  document.getElementById('camIcon').textContent = camEnabled ? '📷' : '📷';
  btn.className = 'ctrl-btn ' + (camEnabled ? 'active' : 'muted');
  localOverlay.style.opacity = camEnabled ? '0' : '1';
  localOverlay.innerHTML     = camEnabled ? '' : getInitials(MY_NAME);
}

function toggleTranscription() {
  transcribing = !transcribing;
  const btn = document.getElementById('btnTranscribe');
  btn.className = 'ctrl-btn ' + (transcribing ? 'active' : '');

  if (transcribing) {
    if (!localStream) { toast('Microphone not available', 'warn'); transcribing = false; return; }
    toast('Live transcription ON ◎', 'info');
    captionBar.style.display = 'flex';
    captionText.textContent  = 'Listening…';
    startRecordingChunk();
  } else {
    toast('Transcription paused', 'info');
    captionBar.style.display = 'none';
    stopRecordingChunk();
  }
}

// ── Audio recording & transcription ───────────────────────────────────────────
let recordTimeout = null;

function startRecordingChunk() {
  if (!localStream || !micEnabled) return;

  const audioStream = new MediaStream(localStream.getAudioTracks());
  let mimeType = 'audio/webm;codecs=opus';
  if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'audio/webm';
  if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';

  try {
    mediaRecorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : {});
  } catch {
    mediaRecorder = new MediaRecorder(audioStream);
  }

  audioChunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.onstop = sendChunkToWhisper;

  mediaRecorder.start();

  // Record in 8-second chunks for responsiveness
  recordTimeout = setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
  }, 8000);
}

function stopRecordingChunk() {
  clearTimeout(recordTimeout);
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}

async function sendChunkToWhisper() {
  if (!transcribing) return;

  if (audioChunks.length === 0) {
    startRecordingChunk();
    return;
  }

  const blob     = new Blob(audioChunks, { type: 'audio/webm' });
  const name     = document.getElementById('localName').textContent || MY_NAME;
  const formData = new FormData();
  formData.append('audio',    blob, 'chunk.webm');
  formData.append('room_id',  ROOM_ID);
  formData.append('speaker',  name);

  // Update caption
  captionText.textContent = '⏳ Transcribing…';

  try {
    const res  = await fetch(`${API}/api/transcribe`, { method: 'POST', body: formData });
    const data = await res.json();

    if (data.loading) {
      captionText.textContent = 'Whisper still loading, please wait…';
    } else if (data.text) {
      captionSpeaker.textContent = name;
      captionText.textContent    = data.text;
      clearTimeout(captionBar._timeout);
      captionBar._timeout = setTimeout(() => { captionText.textContent = 'Listening…'; }, 7000);
    } else {
      captionText.textContent = 'Listening…';
    }
  } catch (e) {
    captionText.textContent = 'Transcription error — retrying…';
  }

  // Continue recording next chunk
  if (transcribing) startRecordingChunk();
}

// ── Summarization ──────────────────────────────────────────────────────────────
async function requestSummary() {
  if (transcriptCount === 0) {
    toast('No transcript to summarize yet', 'warn');
    return;
  }

  document.getElementById('summaryOverlay').style.display = 'flex';
  toast('Generating AI summary on GPU…', 'info');

  try {
    const res  = await fetch(`${API}/api/summarize/${ROOM_ID}`, { method: 'POST' });
    const data = await res.json();
    document.getElementById('summaryOverlay').style.display = 'none';

    if (data.error) {
      toast(data.error, 'error');
    } else {
      showSummary(data);
      switchTab('summary');
    }
  } catch (e) {
    document.getElementById('summaryOverlay').style.display = 'none';
    toast('Summary generation failed', 'error');
  }
}

function showSummary(data) {
  summaryEmpty.style.display = 'none';
  summaryText.style.display  = 'block';
  summaryText.textContent    = data.text || data.ai_summary || 'No summary available.';
}

// ── Video upload for transcription ────────────────────────────────────────────
function uploadVideo() {
  const fileInput = document.getElementById('videoFileInput');
  fileInput.click();
}

async function handleVideoUpload() {
  const fileInput = document.getElementById('videoFileInput');
  const file = fileInput.files[0];
  if (!file) return;

  // Check file size (limit to 100MB for example)
  if (file.size > 100 * 1024 * 1024) {
    toast('Video file too large (max 100MB)', 'error');
    return;
  }

  toast('Uploading video for transcription…', 'info');

  const name = document.getElementById('localName').textContent || MY_NAME;
  const formData = new FormData();
  formData.append('video', file);
  formData.append('room_id', ROOM_ID);
  formData.append('speaker', name);

  try {
    const res = await fetch(`${API}/api/transcribe-video`, { method: 'POST', body: formData });
    const data = await res.json();

    if (data.error) {
      toast(data.error, 'error');
    } else if (data.text) {
      toast('Video transcribed successfully ✓', 'success');
      // The transcript entry will be added via socket event
    } else {
      toast('No speech detected in video', 'info');
    }
  } catch (e) {
    toast('Video upload failed', 'error');
  }

  // Reset file input
  fileInput.value = '';
}

// ── Transcript entries ─────────────────────────────────────────────────────────
function addTranscriptEntry(entry) {
  transcriptEmpty.style.display = 'none';
  transcriptCount++;
  entryCount.textContent = `${transcriptCount} segment${transcriptCount !== 1 ? 's' : ''}`;

  const ts  = entry.timestamp ? entry.timestamp.slice(11, 19) : '';
  const div = document.createElement('div');
  div.className = 'transcript-entry';
  div.innerHTML = `
    <div class="entry-meta">
      <span class="entry-speaker">${entry.speaker}</span>
      <span class="entry-time">${ts}</span>
    </div>
    <div class="entry-text">${escapeHtml(entry.text)}</div>
    ${entry.language && entry.language !== 'en' ? `<span class="entry-lang">${entry.language}</span>` : ''}`;

  transcriptScroll.appendChild(div);
  transcriptScroll.scrollTop = transcriptScroll.scrollHeight;
}

// ── Chat ───────────────────────────────────────────────────────────────────────
function sendChat() {
  const input = document.getElementById('chatInput');
  const text  = input.value.trim();
  if (!text) return;

  const name = document.getElementById('localName').textContent || MY_NAME;
  socket.emit('chat_message', { room_id: ROOM_ID, name, text });
  addChatMessage({ name, text, time: new Date().toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'}) }, true);
  input.value = '';
}

function addChatMessage(msg, mine = false) {
  // Remove empty state
  const empty = chatScroll.querySelector('.empty-state');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = `chat-msg ${mine ? 'mine' : ''}`;
  div.innerHTML = `
    <div class="chat-msg-header">
      <span class="chat-msg-name">${msg.name || 'Participant'}</span>
      <span class="chat-msg-time">${msg.time || ''}</span>
    </div>
    <div class="chat-msg-text">${escapeHtml(msg.text)}</div>`;
  chatScroll.appendChild(div);
  chatScroll.scrollTop = chatScroll.scrollHeight;

  // Badge if not on chat tab
  if (!document.getElementById('tabChat').classList.contains('active')) {
    document.getElementById('chatLabel').textContent = 'Chat 🔴';
  }
}

// ── Export ─────────────────────────────────────────────────────────────────────
async function exportData() {
  try {
    const res  = await fetch(`${API}/api/export/${ROOM_ID}`);
    const data = await res.json();

    let output = `MEETAI EXPORT\n${'='.repeat(60)}\n`;
    output += `Title: ${data.title}\nDate:  ${data.created_at}\n\n`;

    if (data.summary) {
      output += data.summary.text + '\n\n';
    } else {
      output += 'TRANSCRIPT\n' + '-'.repeat(40) + '\n';
      (data.transcript || []).forEach(e => {
        output += `[${e.timestamp?.slice(11,19)}] ${e.speaker}: ${e.text}\n\n`;
      });
    }

    const blob = new Blob([output], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `meetai-${ROOM_ID}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Exported successfully ⬇', 'success');
  } catch (e) {
    toast('Export failed', 'error');
  }
}

// ── End meeting ────────────────────────────────────────────────────────────────
function endMeeting() {
  if (!confirm('End meeting and leave the room?')) return;
  stopRecordingChunk();
  socket.emit('leave_room', { room_id: ROOM_ID });
  Object.values(peers).forEach(pc => pc.close());
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  clearInterval(timerInterval);
  window.location.href = '/';
}

// ── Room ID copy ───────────────────────────────────────────────────────────────
function copyRoomId() {
  navigator.clipboard.writeText(ROOM_ID).then(() => toast('Room code copied!', 'success'));
}

// ── Tab switching ──────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.stab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab${name.charAt(0).toUpperCase()+name.slice(1)}`).classList.add('active');
  document.getElementById(`panel${name.charAt(0).toUpperCase()+name.slice(1)}`).classList.add('active');

  if (name === 'chat') {
    document.getElementById('chatLabel').textContent = 'Chat';
  }
}

function togglePanel(name) { switchTab(name); }

// ── Timer ──────────────────────────────────────────────────────────────────────
function startTimer() {
  timerInterval = setInterval(() => {
    const sec  = Math.floor((Date.now() - meetingStartTime) / 1000);
    const m    = String(Math.floor(sec / 60)).padStart(2, '0');
    const s    = String(sec % 60).padStart(2, '0');
    document.getElementById('timer').textContent = `${m}:${s}`;
  }, 1000);
}

// ── AI status polling ──────────────────────────────────────────────────────────
async function pollAIStatus() {
  try {
    const res  = await fetch(`${API}/api/status`);
    const data = await res.json();
    const aiDot  = document.querySelector('.ai-dot');
    const aiText = document.getElementById('aiStatusText');

    const whisperReady     = data.models.whisper.includes('ready');
    const summarizerReady  = data.models.summarizer.includes('ready');

    if (whisperReady && summarizerReady) {
      aiDot.className  = 'ai-dot ready';
      aiText.textContent = `AI Ready · ${data.gpu.name || 'GPU'}`;
    } else if (data.models.whisper.includes('error')) {
      aiDot.className  = 'ai-dot error';
      aiText.textContent = 'Whisper error';
    } else {
      aiDot.className  = 'ai-dot loading';
      aiText.textContent = 'AI Loading…';
      setTimeout(pollAIStatus, 4000);
      return;
    }
  } catch {
    setTimeout(pollAIStatus, 4000);
    return;
  }
  setTimeout(pollAIStatus, 15000);
}

// ── Toast ──────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  const el        = document.createElement('div');
  el.className    = `toast ${type}`;
  el.textContent  = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Utils ──────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Update video grid layout on init ──────────────────────────────────────────
updateVideoLayout();
