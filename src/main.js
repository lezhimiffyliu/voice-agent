// Browser-side voice agent client for the AssemblyAI Voice Agent API.
//
// Flow:
//   1. Fetch a short-lived temporary token from our own server (/token).
//   2. Open ONE WebSocket to wss://agents.assemblyai.com/v1/ws?token=...
//   3. Send session.update (system prompt, greeting, voice).
//   4. After session.ready: stream mic audio as base64 PCM16 `input.audio`.
//   5. Receive `reply.audio` chunks, decode, and play them back.
//   6. Render transcripts (transcript.user / transcript.agent) into the log.
//
// Audio format required by the API: raw PCM16, mono, 24 kHz, base64-encoded.
// We force a 24 kHz AudioContext so nothing resamples.

// ---- Configuration: edit the agent's behavior here -------------------------
// Claire's core persona. Front-load the most important rule; avoid markdown/emoji —
// TTS reads punctuation literally. Note math is written in LaTeX in the problem
// data; the model reads it fine and speaks it naturally.
const BASE_SYSTEM_PROMPT = [
  // Identity + core rule first.
  'You are Claire, a friendly personal math tutor helping a student out loud. You can help with any math, from arithmetic and algebra to calculus.',
  'Your goal is to teach, not to answer. Never give the final answer directly.',
  // Teaching method.
  'Help the student discover the next step themselves. Prefer hints over solutions.',
  'Ask a guiding question often, then wait for their reply. One idea at a time.',
  'When the student is stuck, give one small hint and ask a guiding question.',
  'When the student is correct, acknowledge briefly and move them to the next step.',
  'If they ask you to just give the answer, gently nudge them to try one more step together first.',
  // Voice style.
  'Keep every reply under two short spoken sentences. Speak naturally and warmly, like a tutor sitting beside them.',
  'No lists, no bullet points, no long explanations, no markdown. Speak math in plain words, not LaTeX symbols.',
  'Never say "here is a step-by-step solution", "as an AI language model", or "would you like further assistance".',
  'Sound like an encouraging, patient TA, never like customer support.',
  // Tool use.
  'When the student gives a numeric answer or you need to verify any arithmetic, call the check_answer tool rather than computing in your head. Use its result to judge whether they are right, but never read the correct value out loud — only say whether they got it and nudge the next step.',
].join(' ');

const VOICE = 'sophie'; // try: ivy, james, sophie

// The problem the student picked on the dashboard (null = open-ended chat).
let selectedProblem = null;

// Build the system prompt, optionally pinned to the selected problem. The answer
// is given to Claire only so she can check the student's work — never to reveal.
function buildSystemPrompt(problem) {
  if (!problem) return BASE_SYSTEM_PROMPT;
  const context = problem.stem ? ` Overall instructions: "${problem.stem}".` : '';
  const multi = problem.parts.length > 1;
  // List every part with its answer (for Claire's reference only).
  const parts = problem.parts
    .map((pt) => {
      const tag = pt.label ? `Part ${pt.label}: ` : '';
      const ans = pt.answer ? ` (correct answer, for your reference only: "${pt.answer}")` : '';
      return `${tag}"${pt.question}"${ans}`;
    })
    .join(' ');
  return (
    BASE_SYSTEM_PROMPT +
    ` The student is working on this ${problem.topic} problem from ${problem.course} (${problem.exam}).` +
    context +
    ` ${multi ? 'It has these parts.' : 'The question is:'} ${parts}` +
    (multi ? ' Work through the parts in order, starting with the first one.' : '') +
    ` Tutor them with hints and guiding questions, and never state any answer outright.`
  );
}

function buildGreeting(problem) {
  if (!problem) return "Hi, I'm Claire! What math problem are you working on?";
  return "Hi, I'm Claire! Let's work through this one together. Where do you think we should start?";
}

// Tools the agent may call. Handled client-side in handleServerMessage().
const TOOLS = [
  {
    type: 'function',
    name: 'check_answer',
    description:
      "Evaluate a math expression to verify a student's answer. " +
      'Use this whenever you need the numeric value of an arithmetic or algebraic expression.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description:
            "The math expression to evaluate, e.g. '2 + 3 * 4', 'sqrt(144)', or '(7-2)^2'.",
        },
      },
      required: ['expression'],
    },
  },
];

// Safely evaluate a basic math expression. Only digits, operators, parentheses,
// and a small set of Math functions are allowed — anything else is rejected, so
// no arbitrary code can run. Returns a number, or throws on an invalid input.
function evalMathExpression(expr) {
  const cleaned = String(expr).trim();
  // Whitelist: digits, . + - * / % ^ ( ) , whitespace, and function/constant names.
  if (!/^[0-9.+\-*/%^(),\s a-z]+$/i.test(cleaned)) {
    throw new Error('unsupported characters');
  }
  // Map a few friendly names to JS Math, and ^ to exponentiation.
  const js = cleaned
    .replace(/\^/g, '**')
    .replace(/\b(sqrt|cbrt|abs|round|floor|ceil|sin|cos|tan|log|log2|log10|exp|pow|min|max)\b/gi, 'Math.$1')
    .replace(/\bpi\b/gi, 'Math.PI')
    .replace(/\be\b/gi, 'Math.E');
  // eslint-disable-next-line no-new-func
  const value = Function('Math', `"use strict"; return (${js});`)(Math);
  if (typeof value !== 'number' || !isFinite(value)) throw new Error('not a finite number');
  return value;
}

function buildSessionConfig(problem) {
  return {
    system_prompt: buildSystemPrompt(problem),
    greeting: buildGreeting(problem),
    output: { voice: VOICE },
    tools: TOOLS,
  };
}

const VOICE_AGENT_WS = 'wss://agents.assemblyai.com/v1/ws';
const SAMPLE_RATE = 24000;

// ---- DOM ------------------------------------------------------------------
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const log = document.getElementById('log');
const courseChips = document.getElementById('courseChips');
const topicSelect = document.getElementById('topicSelect');
const searchInput = document.getElementById('search');
const resultCount = document.getElementById('resultCount');
const problemList = document.getElementById('problemList');
const currentProblem = document.getElementById('currentProblem');
const currentProblemText = document.getElementById('currentProblemText');

// ---- Runtime state --------------------------------------------------------
let ws = null;
let audioCtx = null;
let micStream = null;
let sourceNode = null;
let recorderNode = null;
let sessionReady = false;

// Playback scheduling.
let nextStartTime = 0;
let scheduledSources = [];

// ---- UI helpers -----------------------------------------------------------
function setStatus(text, state) {
  statusText.textContent = text;
  statusDot.className = 'dot' + (state ? ' ' + state : '');
}

function addMessage(text, who) {
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  if (who === 'user' || who === 'agent') {
    const label = document.createElement('span');
    label.className = 'who';
    label.textContent = who === 'user' ? 'You' : 'Agent';
    div.appendChild(label);
    div.appendChild(document.createTextNode(text));
  } else {
    div.textContent = text;
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  // Let the learning dashboard advance as the conversation progresses. This only
  // observes rendered transcript lines — it does not touch the voice pipeline.
  if (who === 'user' || who === 'agent') noteSessionProgress(who);
}

// ---- Audio encode/decode --------------------------------------------------
// Float32 [-1, 1] -> base64-encoded little-endian PCM16.
function floatTo16BitBase64(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// base64-encoded little-endian PCM16 -> Float32 [-1, 1].
function base64ToFloat32(b64) {
  const binary = atob(b64);
  const len = binary.length >> 1; // 2 bytes per sample
  const float32 = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    let val = (hi << 8) | lo;
    if (val >= 0x8000) val -= 0x10000;
    float32[i] = val / 32768;
  }
  return float32;
}

// ---- Playback -------------------------------------------------------------
function playAudioChunk(float32) {
  if (!audioCtx) return;
  const buffer = audioCtx.createBuffer(1, float32.length, SAMPLE_RATE);
  buffer.copyToChannel(float32, 0);

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(audioCtx.destination);

  const now = audioCtx.currentTime;
  if (nextStartTime < now) nextStartTime = now;
  src.start(nextStartTime);
  nextStartTime += buffer.duration;

  scheduledSources.push(src);
  src.onended = () => {
    scheduledSources = scheduledSources.filter((s) => s !== src);
  };
}

// Stop and clear everything currently queued for playback (barge-in / interrupt).
function flushPlayback() {
  for (const src of scheduledSources) {
    try {
      src.onended = null;
      src.stop();
    } catch (_) {
      /* already stopped */
    }
  }
  scheduledSources = [];
  nextStartTime = audioCtx ? audioCtx.currentTime : 0;
}

// ---- WebSocket message handling -------------------------------------------
function handleServerMessage(event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch (_) {
    return; // ignore non-JSON frames
  }

  switch (msg.type) {
    case 'session.ready':
      sessionReady = true;
      setStatus('Connected — listening. Start talking!', 'live');
      break;

    case 'input.speech.started':
      // User started talking: cut off any agent audio still playing (barge-in).
      flushPlayback();
      break;

    case 'input.speech.stopped':
      break;

    case 'reply.started':
      break;

    case 'reply.audio':
      if (msg.data) playAudioChunk(base64ToFloat32(msg.data));
      break;

    case 'reply.done':
      if (msg.status === 'interrupted') flushPlayback();
      break;

    case 'transcript.user':
      if (msg.text) addMessage(msg.text, 'user');
      break;

    case 'transcript.agent':
      if (msg.text) addMessage(msg.text, 'agent');
      break;

    case 'tool.call':
      handleToolCall(msg);
      break;

    case 'session.error':
      addMessage('Agent error: ' + (msg.message || 'unknown'), 'error');
      setStatus('Session error: ' + (msg.message || 'unknown'), 'error');
      break;

    default:
      // Other event types are not used by this demo.
      break;
  }
}

// Run a tool the agent requested and send the result straight back. The docs
// stress sending tool.result the moment the tool returns (no buffering) — the
// agent fills the gap with a filler phrase, then replies using our result.
function handleToolCall(msg) {
  // The docs call this field `arguments` (parsed object); the Twilio sample
  // reads `args`. Accept either to be safe.
  const args = msg.arguments || msg.args || {};
  let result;
  if (msg.name === 'check_answer') {
    try {
      const value = evalMathExpression(args.expression);
      result = { expression: args.expression, value };
      addMessage(`check_answer("${args.expression}") = ${value}`, 'system');
    } catch (err) {
      result = { expression: args.expression, error: 'Could not evaluate: ' + err.message };
    }
  } else {
    result = { error: 'Unknown tool: ' + msg.name };
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'tool.result',
        call_id: msg.call_id,
        result: JSON.stringify(result), // result must be a stringified value
        is_error: Boolean(result.error),
      })
    );
  }
}

// ---- Start / Stop ---------------------------------------------------------
async function start() {
  startBtn.disabled = true;
  sessionReady = false;
  setStatus('Requesting microphone…', 'connecting');

  try {
    // 1. Microphone permission. Let server-side Voice Focus handle noise; only
    //    enable echo cancellation here.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
    });
  } catch (err) {
    setStatus('Microphone permission denied or unavailable.', 'error');
    addMessage('Could not access microphone: ' + err.message, 'error');
    startBtn.disabled = false;
    return;
  }

  // 2. Get a short-lived temporary token from our server.
  let token;
  try {
    setStatus('Fetching connection token…', 'connecting');
    const res = await fetch('/token');
    const data = await res.json();
    if (!res.ok || !data.token) throw new Error(data.error || 'No token returned');
    token = data.token;
  } catch (err) {
    setStatus('Could not get a connection token.', 'error');
    addMessage('Token error: ' + err.message + ' (Is the server running with ASSEMBLYAI_API_KEY set?)', 'error');
    stop();
    startBtn.disabled = false;
    return;
  }

  // 3. Audio graph at the required 24 kHz so nothing resamples.
  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await audioCtx.resume();
  await audioCtx.audioWorklet.addModule('/src/recorder-processor.js');

  sourceNode = audioCtx.createMediaStreamSource(micStream);
  recorderNode = new AudioWorkletNode(audioCtx, 'recorder-processor');
  sourceNode.connect(recorderNode);
  // Do NOT connect recorderNode to destination — we don't want to hear ourselves.

  recorderNode.port.onmessage = (e) => {
    if (!sessionReady || !ws || ws.readyState !== WebSocket.OPEN) return;
    const b64 = floatTo16BitBase64(e.data);
    ws.send(JSON.stringify({ type: 'input.audio', audio: b64 }));
  };

  // 4. Open the single Voice Agent WebSocket.
  setStatus('Connecting to AssemblyAI…', 'connecting');
  ws = new WebSocket(`${VOICE_AGENT_WS}?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    // First message configures the session (system prompt / greeting / voice),
    // pinned to whichever problem the student selected on the dashboard.
    ws.send(JSON.stringify({ type: 'session.update', session: buildSessionConfig(selectedProblem) }));
    stopBtn.disabled = false;
  };

  ws.onmessage = handleServerMessage;

  ws.onerror = () => {
    setStatus('WebSocket error.', 'error');
    addMessage('WebSocket connection error.', 'error');
  };

  ws.onclose = (e) => {
    if (stopBtn.disabled) return; // already stopped intentionally
    setStatus(`Connection closed${e.reason ? ': ' + e.reason : ''}.`, 'error');
    stop();
  };
}

function stop() {
  if (recorderNode) {
    try { recorderNode.port.onmessage = null; recorderNode.disconnect(); } catch (_) {}
    recorderNode = null;
  }
  if (sourceNode) {
    try { sourceNode.disconnect(); } catch (_) {}
    sourceNode = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  flushPlayback();
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  if (ws) {
    const sock = ws;
    ws = null;
    try { sock.close(); } catch (_) {}
  }
  sessionReady = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('Stopped.', '');
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);

// ---- Problem bank / dashboard ---------------------------------------------
// Loads data/problems.json (built by `npm run ingest`) and powers the picker.
let allProblems = [];
let activeCourse = 'all';
const MAX_RENDER = 80; // cap rendered cards; filters/search narrow the rest

// Typeset LaTeX inside an element using KaTeX auto-render (falls back to the raw
// text if the CDN script didn't load).
function renderMath(el) {
  if (typeof window.renderMathInElement === 'function') {
    try {
      window.renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
        ],
        throwOnError: false,
      });
    } catch (_) {
      /* leave raw text */
    }
  }
}

async function loadProblems() {
  try {
    const res = await fetch('/data/problems.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    allProblems = await res.json();
  } catch (err) {
    resultCount.textContent = 'Could not load the problem bank. Run "npm run ingest" and reload.';
    return;
  }
  buildCourseChips();
  buildTopicOptions();
  renderProblems();
}

function buildCourseChips() {
  const courses = ['all', ...Array.from(new Set(allProblems.map((p) => p.course)))];
  courseChips.innerHTML = '';
  for (const c of courses) {
    const btn = document.createElement('button');
    btn.className = 'chip' + (c === activeCourse ? ' active' : '');
    btn.textContent = c === 'all' ? 'All courses' : c;
    btn.addEventListener('click', () => {
      activeCourse = c;
      buildCourseChips();
      buildTopicOptions();
      renderProblems();
    });
    courseChips.appendChild(btn);
  }
}

function buildTopicOptions() {
  const pool = allProblems.filter((p) => activeCourse === 'all' || p.course === activeCourse);
  const topics = Array.from(new Set(pool.map((p) => p.topic))).sort();
  const prev = topicSelect.value;
  topicSelect.innerHTML = '';
  const optAll = document.createElement('option');
  optAll.value = 'all';
  optAll.textContent = 'All topics';
  topicSelect.appendChild(optAll);
  for (const t of topics) {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    topicSelect.appendChild(o);
  }
  topicSelect.value = topics.includes(prev) ? prev : 'all';
}

function filteredProblems() {
  const topic = topicSelect.value;
  const q = searchInput.value.trim().toLowerCase();
  return allProblems.filter((p) => {
    if (activeCourse !== 'all' && p.course !== activeCourse) return false;
    if (topic !== 'all' && p.topic !== topic) return false;
    if (q) {
      const partsText = p.parts.map((pt) => pt.question).join(' ');
      const hay = (p.stem + ' ' + partsText + ' ' + p.topic + ' ' + p.concepts.join(' ')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Render a whole problem (stem + every part) into `el` with typeset math.
function renderProblemInto(el, p) {
  el.innerHTML = '';
  if (p.stem) {
    const stem = document.createElement('div');
    stem.className = 'stem';
    stem.textContent = p.stem;
    el.appendChild(stem);
  }
  for (const pt of p.parts) {
    const part = document.createElement('div');
    part.className = 'part';
    if (pt.label) {
      const lab = document.createElement('span');
      lab.className = 'part-label';
      lab.textContent = `(${pt.label}) `;
      part.appendChild(lab);
    }
    part.appendChild(document.createTextNode(pt.question));
    el.appendChild(part);
  }
  renderMath(el);
}

function renderProblems() {
  const filtered = filteredProblems();
  problemList.innerHTML = '';
  for (const p of filtered.slice(0, MAX_RENDER)) {
    const card = document.createElement('button');
    card.className = 'problem-card' + (selectedProblem && selectedProblem.id === p.id ? ' selected' : '');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const partCount = p.parts.length > 1 ? `${p.parts.length} parts` : '1 part';
    for (const label of [p.course, p.exam, p.topic, partCount]) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = label;
      meta.appendChild(tag);
    }

    const prompt = document.createElement('div');
    prompt.className = 'prompt';
    renderProblemInto(prompt, p);

    card.appendChild(meta);
    card.appendChild(prompt);
    card.addEventListener('click', () => selectProblem(p));
    problemList.appendChild(card);
  }

  const total = filtered.length;
  resultCount.textContent =
    total === 0
      ? 'No problems match.'
      : `${total} problem${total === 1 ? '' : 's'}` +
        (total > MAX_RENDER ? ` (showing first ${MAX_RENDER} — narrow with filters)` : '');
}

function selectProblem(p) {
  const live = ws && ws.readyState === WebSocket.OPEN && sessionReady;
  selectedProblem = p;
  renderProblems(); // refresh highlight
  currentProblem.style.display = '';
  renderProblemInto(currentProblemText, p);

  // Opening a problem (with no live session) starts a clean conversation log.
  if (!live) log.innerHTML = '';

  // Update the learning dashboard and switch to the problem working page.
  dashboardLoadProblem(p);
  showWorkingView();

  // If a session is already live, re-pin Claire to the new problem mid-chat.
  // (system_prompt is mutable; greeting/voice are not.)
  if (live) {
    ws.send(JSON.stringify({ type: 'session.update', session: { system_prompt: buildSystemPrompt(p) } }));
    addMessage('Switched to a new problem.', 'system');
  }
}

topicSelect.addEventListener('change', renderProblems);
searchInput.addEventListener('input', renderProblems);

loadProblems();

// ===========================================================================
// Learning dashboard (mock state)
// ---------------------------------------------------------------------------
// A self-contained, demo-only student model. It derives everything from the
// selected problem plus a few in-memory counters — no backend, no voice-logic
// changes. It updates on three signals:
//   1. a problem is loaded   -> dashboardLoadProblem()
//   2. a hint is used        -> dashboardUseHint()   (the "I used a hint" button)
//   3. the session progresses -> noteSessionProgress() (each transcript turn)
// ===========================================================================

// ---- View switching -------------------------------------------------------
const libraryView = document.getElementById('libraryView');
const workingView = document.getElementById('workingView');
const backBtn = document.getElementById('backBtn');

function showWorkingView() {
  libraryView.style.display = 'none';
  workingView.style.display = 'grid';
  window.scrollTo(0, 0);
}

function showLibraryView() {
  workingView.style.display = 'none';
  libraryView.style.display = '';
  window.scrollTo(0, 0);
}

backBtn.addEventListener('click', () => {
  // Leaving the working page ends any live session. We just call the existing
  // stop() — the voice pipeline itself is unchanged.
  if (!stopBtn.disabled) stop();
  showLibraryView();
});

// ---- Dashboard DOM --------------------------------------------------------
const dbEls = {
  topic: document.getElementById('dbTopic'),
  difficulty: document.getElementById('dbDifficulty'),
  confidence: document.getElementById('dbConfidence'),
  confidenceBar: document.getElementById('dbConfidenceBar'),
  attempted: document.getElementById('dbAttempted'),
  hints: document.getElementById('dbHints'),
  weakAreas: document.getElementById('dbWeakAreas'),
  nextTopic: document.getElementById('dbNextTopic'),
};
const hintBtn = document.getElementById('hintBtn');

// ---- Mock state -----------------------------------------------------------
// Per-concept mastery (0–100). Confidence and weak areas are derived from it,
// so hints (which lower it) and conversation turns (which raise it) both move
// the dashboard in a believable way.
const conceptScores = {};
const attemptedIds = new Set();
let dbConcepts = []; // concept keys for the current problem
let dbTopic = '—';
let dbDifficulty = 'Medium';
let dbHints = 0;

const BASE_SCORE = { Easy: 64, Medium: 50, Hard: 42 };

// A rough learning order; "recommended next" walks one step forward from the
// current topic (and falls back gracefully for anything off this path).
const TOPIC_ORDER = [
  'Limits', 'Derivative Rules', 'Implicit Differentiation', 'Curve Analysis',
  'Applications Of Integration', 'Substitution', 'Fundamental Theorem Of Calculus',
  'Improper Integrals', 'Arc Length', 'Parametric Equations', 'Taylor Polynomials And Series',
  'Vectors And Geometry', 'Lines And Planes', 'Quadric Surfaces', 'Vector Valued Functions',
  'Motion In Space', 'Multivariable Functions', 'Partial Derivatives', 'Tangent Planes And Differentials',
  'Multivariable Optimization', 'Double Integrals', 'Applications Of Double Integrals', 'Differential Equations',
];

function clampScore(n) { return Math.max(3, Math.min(99, n)); }

function humanizeConcept(c) {
  return String(c).replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function difficultyFromPoints(points) {
  if (points == null) return 'Medium';
  if (points <= 8) return 'Easy';
  if (points <= 12) return 'Medium';
  return 'Hard';
}

function bumpConcepts(concepts, delta) {
  for (const c of concepts) {
    conceptScores[c] = clampScore((conceptScores[c] ?? 50) + delta);
  }
}

function currentConfidence() {
  if (!dbConcepts.length) return 0;
  const sum = dbConcepts.reduce((a, c) => a + (conceptScores[c] ?? 50), 0);
  return Math.round(sum / dbConcepts.length);
}

function weakAreas() {
  return Object.entries(conceptScores)
    .filter(([, s]) => s < 50)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 4)
    .map(([c]) => humanizeConcept(c));
}

function recommendNextTopic(topic, confidence) {
  if (confidence > 0 && confidence < 55) return 'Review: ' + topic;
  const i = TOPIC_ORDER.indexOf(topic);
  if (i >= 0 && i < TOPIC_ORDER.length - 1) return TOPIC_ORDER[i + 1];
  if (i === TOPIC_ORDER.length - 1) return 'Advanced ' + topic;
  return topic && topic !== '—' ? 'More ' + topic + ' practice' : '—';
}

function renderDashboard() {
  const conf = currentConfidence();

  dbEls.topic.textContent = dbTopic;

  dbEls.difficulty.textContent = dbDifficulty;
  dbEls.difficulty.className = 'badge ' + dbDifficulty.toLowerCase();

  dbEls.confidence.textContent = conf ? conf + '%' : '—';
  dbEls.confidenceBar.style.width = conf + '%';

  dbEls.attempted.textContent = String(attemptedIds.size);
  dbEls.hints.textContent = String(dbHints);

  const weak = weakAreas();
  dbEls.weakAreas.innerHTML = '';
  if (weak.length === 0) {
    const tag = document.createElement('span');
    tag.className = 'wtag none';
    tag.textContent = 'None flagged yet';
    dbEls.weakAreas.appendChild(tag);
  } else {
    for (const w of weak) {
      const tag = document.createElement('span');
      tag.className = 'wtag';
      tag.textContent = w;
      dbEls.weakAreas.appendChild(tag);
    }
  }

  dbEls.nextTopic.textContent = recommendNextTopic(dbTopic, conf);
}

// ---- Update signals -------------------------------------------------------
function dashboardLoadProblem(p) {
  dbTopic = p.topic || '—';
  dbDifficulty = difficultyFromPoints(p.points);
  dbConcepts = p.concepts && p.concepts.length ? p.concepts.slice() : [p.topicKey || 'general'];
  // Seed any newly seen concept at a difficulty-appropriate baseline.
  for (const c of dbConcepts) {
    if (conceptScores[c] == null) conceptScores[c] = BASE_SCORE[dbDifficulty];
  }
  attemptedIds.add(p.id);
  renderDashboard();
}

function dashboardUseHint() {
  if (!dbConcepts.length) return; // no active problem
  dbHints += 1;
  bumpConcepts(dbConcepts, -10); // leaning on a hint dents confidence a little
  renderDashboard();
  addMessage('Hint logged on your dashboard.', 'system');
}

// Called from addMessage() on each rendered transcript line. Working through the
// problem out loud nudges mastery (and confidence) upward.
function noteSessionProgress(who) {
  if (who !== 'agent') return; // count one step per tutor turn
  if (!dbConcepts.length) return;
  bumpConcepts(dbConcepts, 4);
  renderDashboard();
}

hintBtn.addEventListener('click', dashboardUseHint);
