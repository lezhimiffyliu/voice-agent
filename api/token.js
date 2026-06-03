// Vercel serverless function: mint a short-lived AssemblyAI temporary token.
//
// This is the deploy-time equivalent of the /token route in server.js. On
// Vercel the long-running Express server is NOT used; instead this function is
// invoked per request and mapped to /token via the rewrite in vercel.json.
//
// The API key stays server-side (set ASSEMBLYAI_API_KEY in the Vercel project's
// Environment Variables) and never reaches the browser.

// How long each temporary token is valid (seconds). Range allowed: 1–600.
const TOKEN_TTL_SECONDS = 300;

export default async function handler(_req, res) {
  const API_KEY = process.env.ASSEMBLYAI_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({
      error: 'ASSEMBLYAI_API_KEY is not set. Add it in the Vercel project Environment Variables.',
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
    res.status(200).json({ token: data.token });
  } catch (err) {
    console.error('Token request error:', err);
    res.status(500).json({ error: 'Internal error minting token.' });
  }
}
