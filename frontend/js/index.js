// MeetAI — Landing Page JS

const API = 'http://localhost:5000';

// ── Poll model status ──────────────────────────────────────────────────────────
async function pollStatus() {
  try {
    const res  = await fetch(`${API}/api/status`);
    const data = await res.json();

    // GPU badge
    const badge = document.getElementById('gpuBadge');
    if (data.gpu_available) {
      badge.textContent = `⚡ ${data.gpu.name}`;
      badge.style.color = '#00e5ff';
    } else {
      badge.innerHTML = '<span class="pulse-dot"></span> CPU Mode';
      badge.style.color = '#f59e0b';
    }

    // Whisper
    const sw = document.getElementById('sWhisper');
    updateStatus(sw, data.models.whisper);

    // Summarizer
    const ss = document.getElementById('sSummarizer');
    updateStatus(ss, data.models.summarizer);

    // Device
    const sd = document.getElementById('sDevice');
    sd.innerHTML = `
      <span class="status-dot ${data.gpu_available ? 'ready' : 'loading'}"></span>
      <span>Device: ${data.models.device}</span>`;

    // Keep polling until both are ready
    const allReady = data.models.whisper.includes('ready') && data.models.summarizer.includes('ready');
    if (!allReady) setTimeout(pollStatus, 3000);

  } catch (e) {
    // Server not started yet
    setTimeout(pollStatus, 3000);
  }
}

function updateStatus(el, statusStr) {
  let dotClass = 'loading';
  if (statusStr.includes('ready'))   dotClass = 'ready';
  if (statusStr.includes('error'))   dotClass = 'error';
  const label = el.id === 'sWhisper' ? 'Whisper' : 'Summarizer';
  el.innerHTML = `<span class="status-dot ${dotClass}"></span><span>${label}: ${statusStr}</span>`;
}

// ── Create meeting ─────────────────────────────────────────────────────────────
async function createMeeting() {
  const title = document.getElementById('meetingTitle').value.trim() || 'Untitled Meeting';
  const host  = document.getElementById('hostName').value.trim();

  if (!host) {
    showError('Please enter your name.');
    return;
  }

  try {
    const res  = await fetch(`${API}/api/create-meeting`, {
      method:  'POST',
      headers: {'Content-Type': 'application/json'},
      body:    JSON.stringify({ title, host })
    });
    const data = await res.json();

    if (data.room_id) {
      // Redirect to meeting room
      window.location.href = `/meeting?room=${data.room_id}&name=${encodeURIComponent(host)}&host=1`;
    }
  } catch (e) {
    showError('Could not connect to server. Make sure the backend is running on port 5000.');
  }
}

// ── Join meeting ───────────────────────────────────────────────────────────────
async function joinMeeting() {
  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  const name = document.getElementById('joinName').value.trim();

  if (!code || code.length !== 8) {
    showError('Please enter a valid 8-character room code.');
    return;
  }
  if (!name) {
    showError('Please enter your name.');
    return;
  }

  try {
    const res = await fetch(`${API}/api/meeting/${code}`);
    if (!res.ok) {
      showError('Room not found. Check the code and try again.');
      return;
    }
    window.location.href = `/meeting?room=${code}&name=${encodeURIComponent(name)}`;
  } catch (e) {
    showError('Could not connect to server. Make sure the backend is running.');
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function showError(msg) {
  const el   = document.getElementById('errorMsg');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 5000);
}

// ── Init ───────────────────────────────────────────────────────────────────────
pollStatus();
