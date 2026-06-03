// Minimal demo server for the AssemblyAI Voice Agent API.
//
// Responsibilities:
//   1. Serve the static frontend (index.html + src/).
//   2. Mint short-lived TEMPORARY TOKENS for the browser so the raw API key
//      never leaves the server. The browser fetches a fresh token before each
//      WebSocket connection and passes it as ?token= in the WebSocket URL.
//
// The actual voice WebSocket (speech in / speech out) is opened directly from
// the browser to AssemblyAI — this server is only the auth + static layer.

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.ASSEMBLYAI_API_KEY;
const PORT = process.env.PORT || 3000;

// How long each temporary token is valid (seconds). Range allowed: 1–600.
const TOKEN_TTL_SECONDS = 300;

const app = express();

// Serve the static frontend.
app.use(express.static(__dirname));

// Mint a temporary token for the browser.
// GET /token -> { token: "..." }
app.get('/token', async (_req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: 'ASSEMBLYAI_API_KEY is not set. Copy .env.example to .env and add your key.',
    });
  }

  try {
    const url = `https://agents.assemblyai.com/v1/token?expires_in_seconds=${TOKEN_TTL_SECONDS}`;
    const upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    if (!upstream.ok) {
      const body = await upstream.text();
      console.error('Token request failed:', upstream.status, body);
      return res
        .status(502)
        .json({ error: `Failed to mint token (HTTP ${upstream.status}). Check your API key.` });
    }

    const data = await upstream.json();
    // AssemblyAI returns { token: "..." }. Forward only the token.
    res.json({ token: data.token });
  } catch (err) {
    console.error('Token request error:', err);
    res.status(500).json({ error: 'Internal error minting token.' });
  }
});

app.listen(PORT, () => {
  console.log(`Voice agent demo running at http://localhost:${PORT}`);
  if (!API_KEY) {
    console.warn('WARNING: ASSEMBLYAI_API_KEY is not set — /token will fail until you add it to .env');
  }
});
