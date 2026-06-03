# Claire — Voice Math Tutor

A browser-based voice tutor built on the **[AssemblyAI Voice Agent API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)**.

Pick a problem from a bank of real UW Math 124/125/126 exam questions, press Start, and talk it through with **Claire** — a patient tutor who teaches with hints and guiding questions instead of just handing over answers. You speak into your microphone and Claire talks back over a **single WebSocket** (speech in, speech out). No separate STT + LLM + TTS pipeline to wire up: AssemblyAI orchestrates noise cancellation, speech recognition, turn detection, the LLM, and text-to-speech behind one connection.

- Plain HTML + vanilla JavaScript (no React, no bundler, no build step)
- A ~50-line Express server whose only jobs are serving the static files and minting short-lived auth tokens
- No database, no auth, no framework

---

## Setup

Requires **Node.js 18+** (for built-in `fetch`).

```bash
# 1. Install dependencies
npm install

# 2. Configure your API key
cp .env.example .env
#   then edit .env and paste your AssemblyAI API key

# 3. Build the problem bank from the bundled exam files
npm run ingest
```

Get an API key from the [AssemblyAI dashboard](https://www.assemblyai.com/app).

> `npm run ingest` reads the raw exam JSON in `data/exams/` and writes the flattened
> `data/problems.json` the dashboard loads. It's already been run once, so you only
> need to re-run it if you change the exam files. See [Problem bank](#problem-bank) below.

---

## Environment variables

See [`.env.example`](.env.example):

| Variable               | Required | Description                                                        |
| ---------------------- | -------- | ------------------------------------------------------------------ |
| `ASSEMBLYAI_API_KEY`   | yes      | Your AssemblyAI API key. **Stays server-side** — never sent to the browser. |
| `PORT`                 | no       | Port for the local server (default `3000`).                        |

---

## How to run

```bash
npm start
```

Then open **http://localhost:3000** in Chrome or Edge (recent versions — AudioWorklet + `getUserMedia` are required).

1. **Pick a problem** from the dashboard (filter by course/topic or search).
2. Click **Start** and allow microphone access.
3. Wait for the status to turn green ("Connected — listening").
4. Start talking. Claire greets you, transcripts appear in the log, and you hear spoken replies.
5. You can pick a different problem mid-session — Claire re-pins to it without reconnecting.
6. Click **Stop** to end the session.

> **Note:** Microphone access requires a secure context. `http://localhost` counts as secure, so the demo works locally. If you deploy it, you must serve it over **HTTPS**.

---

## Architecture

```
┌─────────────┐   GET /token    ┌──────────────┐   GET /v1/token (Bearer API key)   ┌────────────────────┐
│   Browser   │ ───────────────►│  server.js   │ ──────────────────────────────────►│   AssemblyAI REST  │
│ (index.html │ ◄─────────────── │  (Express)   │ ◄────────────────────────────────  │   token endpoint   │
│  + main.js) │   { token }     └──────────────┘        { token } (short-lived)      └────────────────────┘
│             │
│             │   wss://agents.assemblyai.com/v1/ws?token=...   (single WebSocket)   ┌────────────────────┐
│   mic ─────►│ ═══════════════════════════════════════════════════════════════════►│  AssemblyAI Voice  │
│   speaker ◄─│ ◄═══════════════════════════════════════════════════════════════════ │   Agent API        │
└─────────────┘     input.audio  ▶          ◀  reply.audio / transcripts            └────────────────────┘
```

**Two connections, by design:**

1. **Browser → our server (`/token`):** the server holds the API key and mints a short-lived **temporary token** (valid 5 minutes, single use). This keeps the raw key off the client.
2. **Browser → AssemblyAI (WebSocket):** the actual voice session. Microphone audio goes up as `input.audio`; the agent's voice comes back as `reply.audio`; transcripts arrive as `transcript.user` / `transcript.agent`.

### Audio format

The API speaks **raw PCM16, mono, 24 kHz, base64-encoded** in both directions. The browser creates the `AudioContext` at `sampleRate: 24000` so nothing resamples. An `AudioWorklet` ([`src/recorder-processor.js`](src/recorder-processor.js)) captures mic samples; the main thread converts them to base64 PCM16 and sends them. Incoming `reply.audio` chunks are decoded and scheduled back-to-back on the Web Audio clock for gapless playback.

### Files

| File                          | Role                                                              |
| ----------------------------- | ---------------------------------------------------------------- |
| `index.html`                  | UI: problem-picker dashboard, Start/Stop buttons, status, conversation log. |
| `src/main.js`                 | All client logic: problem bank, token fetch, WebSocket, audio encode/decode, playback, event handling. |
| `src/recorder-processor.js`   | AudioWorklet that streams mic audio to the main thread in ~100 ms chunks. |
| `server.js`                   | Express server: serves static files and the `/token` endpoint.   |
| `ingest.js`                   | Build step: flattens `data/exams/*.json` into `data/problems.json`. |
| `data/exams/`                 | Raw source exam files (one JSON list of problems per exam).       |
| `data/problems.json`          | Generated flat problem bank the dashboard loads.                 |

<a name="problem-bank"></a>
### Problem bank (data ingestion)

The "problem base" is a set of real UW **Math 124 / 125 / 126** exam files in `data/exams/`. Each file is a JSON list of problems; each problem has a `stem` and one or more `parts`, and each part has LaTeX `question_text` and a `final_answer`.

`ingest.js` (run via `npm run ingest`) groups these into one tutorable item per **problem** and writes `data/problems.json`:

- One output item = one whole problem, keeping **all of its parts (a, b, c…) together** (with its course, exam, topic, concepts, stem, and each part's LaTeX question + answer).
- Parts that need a **diagram** (no image for a voice tutor to "see") are dropped; a problem is kept as long as at least one part survives.
- Result: ~670 problems (~1,460 parts) across 3 courses and 36 topics.

To use a **different problem set**, either drop new exam JSON files into `data/exams/` and re-run `npm run ingest`, or point the script at another folder:

```bash
node ingest.js /path/to/your/exams      # or: PROBLEMS_DIR=/path/to/exams npm run ingest
```

The browser renders the LaTeX questions with [KaTeX](https://katex.org/) (loaded from a CDN). The selected problem's question **and its answer** are injected into Claire's system prompt — the answer is for her to check the student's work, with an explicit instruction never to reveal it.

---

## Where the WebSocket connection happens

In [`src/main.js`](src/main.js), inside the `start()` function:

```js
ws = new WebSocket(`${VOICE_AGENT_WS}?token=${encodeURIComponent(token)}`);
```

The first message sent after `onopen` is a `session.update` that configures the agent. Incoming events are dispatched in `handleServerMessage()`:

| Server event              | What the demo does                                  |
| ------------------------- | --------------------------------------------------- |
| `session.ready`           | Begin streaming mic audio.                           |
| `reply.audio`             | Decode base64 PCM16 and play it.                     |
| `transcript.user` / `transcript.agent` | Render the line in the conversation log. |
| `input.speech.started`    | Flush queued agent audio (barge-in / interruption). |
| `reply.done` (`interrupted`) | Flush playback.                                  |
| `session.error`           | Show the error in the UI.                            |

---

## How to modify the system prompt / agent behavior

Claire's personality lives in **`BASE_SYSTEM_PROMPT`** at the top of [`src/main.js`](src/main.js):

```js
const BASE_SYSTEM_PROMPT = [
  'You are Claire, a friendly personal math tutor helping a student out loud...',
  'Your goal is to teach, not to answer. Never give the final answer directly.',
  'Help the student discover the next step themselves. Prefer hints over solutions.',
  'Ask a guiding question often, then wait for their reply. One idea at a time.',
  'Keep every reply under two short spoken sentences...',
  // ...
].join(' ');

const VOICE = 'sophie'; // try: ivy, james, sophie
```

When a problem is selected, `buildSystemPrompt(problem)` appends the specific question and its answer to this base. Edit `BASE_SYSTEM_PROMPT` to change Claire's teaching style, `VOICE` to change her voice, and `buildGreeting()` for the opening line.

Tips for voice prompts:

- **Front-load the most important rule** — long prompts dilute attention.
- **Avoid markdown, lists, and emoji** — TTS reads punctuation literally.
- Keep replies short and ask one question at a time (already baked into the prompt).
- `greeting` and `voice` are fixed once the session starts; `system_prompt` is updated mid-session whenever the student picks a new problem (a `session.update` with just that field).

---

## Security — important for production

This demo already keeps your API key **server-side** and hands the browser only a short-lived temporary token. That is the recommended pattern.

> **Never embed your AssemblyAI API key in client-side code.** Anyone who opens dev tools could read it and run up your bill. In production, always mint **short-lived temporary tokens** from a backend (as `server.js` does here) or proxy the connection through your own server. The raw key must never reach the browser.

Additional production hardening (out of scope for this demo): rate-limit the `/token` endpoint, require your own user authentication before issuing tokens, and serve everything over HTTPS.

---

## Deployment

The repo is pre-configured for **both Railway and Vercel** — pick one. The voice
WebSocket runs **browser → AssemblyAI directly**, so the host only needs to serve
static files and the tiny `/token` endpoint (no WebSocket support required). Both
platforms give you HTTPS automatically, which the microphone needs.

The problem bank (`data/problems.json`) is committed, so there is **no build/ingest
step at deploy time** — `npm run ingest` is a one-time local step you already ran.

In **both** cases, set the environment variable in the platform's dashboard:

```
ASSEMBLYAI_API_KEY = <your key>
```

Never commit `.env` (it's gitignored).

### Option A — Railway (runs `server.js` as-is, zero code changes)

Railway runs the Express server unchanged. [`railway.json`](railway.json) pins the
start command; `server.js` already reads `process.env.PORT`, which Railway injects.

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
3. Add the `ASSEMBLYAI_API_KEY` variable under **Variables**.
4. Deploy. Railway runs `npm install` then `npm start` and gives you an HTTPS URL.

### Option B — Vercel (static files + one serverless function)

Vercel serves the static files directly and runs [`api/token.js`](api/token.js) as a
serverless function. [`vercel.json`](vercel.json) rewrites `/token` → `/api/token`
so the frontend's `fetch('/token')` is unchanged; [`.vercelignore`](.vercelignore)
keeps `server.js`, `ingest.js`, and the raw `data/exams/` set out of the upload.

1. Push this repo to GitHub.
2. In Vercel: **Add New → Project**, import this repo. No framework preset / no build command needed.
3. Add the `ASSEMBLYAI_API_KEY` Environment Variable.
4. Deploy. Vercel gives you an HTTPS URL; on Railway you keep one Node process, here `/token` is a function.

### Which to choose

- **Railway** — fastest, runs the real Express server, no refactor. Trial credit, then ~$5/mo.
- **Vercel** — generous always-on free tier; `/token` becomes a serverless function (already set up here).

---

## Troubleshooting

- **"Could not get a connection token"** — make sure the server is running and `ASSEMBLYAI_API_KEY` is set in `.env`.
- **No audio / mic not working** — use Chrome or Edge, allow mic permission, and check you're on `http://localhost` or HTTPS.
- **`UNAUTHORIZED` session error** — your API key is invalid or the token expired before connecting.

---

## Sources

- [Voice Agent API documentation](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)
- [Raw WebSocket voice agent guide](https://www.assemblyai.com/blog/raw-websocket-voice-agent-voice-agent-api)
- [Generate temporary streaming token](https://www.assemblyai.com/docs/api-reference/streaming-api/generate-streaming-token)
