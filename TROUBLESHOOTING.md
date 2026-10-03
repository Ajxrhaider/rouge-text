# 🩺 Rogue-Text — Troubleshooting

Every failure in Rogue-Text is designed to name its own fix. Start with:

```bash
npm run doctor
```

It checks your runtime, files, environment, key format, whether Groq accepts the key,
**whether your chosen model is actually available on that key**, and whether the local
server is answering — then prints the exact command or edit required.

---

## The three that actually happen

### 1. `missing_api_key` — the live DM never answers

**Symptom.** The header badge reads `LITE DM`. The status line under the command bar says
`GROQ_API_KEY is not set`. The game still plays, but every scene comes from the offline
Lite DM.

**Cause.** There is no key in the server's environment. Rogue-Text never reads a key from
the browser, so a key pasted into `app.js` would do nothing.

**Fix (local).**

```bash
cp .env.example .env.local        # Windows: copy .env.example .env.local
# edit .env.local and set:
#   GROQ_API_KEY=gsk_your_real_key_here
```

Then **restart** the server. `.env` files are read at startup, so editing one while the
server is running has no effect.

```bash
node dev-server.js
```

**Fix (Vercel).** Project → Settings → Environment Variables → add `GROQ_API_KEY` for all
three environments (Production, Preview, Development) → **then redeploy**. Environment
variables do not apply to deployments that already exist.

**Verify.** `curl http://localhost:3000/api/dm` should report `"keyLoaded": true`.

---

### 2. `model_unavailable` — the model is retired or not on your key

**Symptom.** The status line says the model is unavailable, or Groq returns a 404 like
``The model `meta-llama/llama-4-scout-17b-16e-instruct` does not exist``.

**Cause.** This is the single most likely failure in 2026, because most tutorials still
name models that Groq has since retired:

| Model | Retired |
|---|---|
| `meta-llama/llama-4-scout-17b-16e-instruct` | 2026-07-17 |
| `qwen/qwen3-32b` | 2026-07-17 |
| `llama-3.1-8b-instant` | 2026-08-16 |
| `llama-3.3-70b-versatile` | 2026-08-16 |

**Fix.** Find out what your key actually has:

```bash
curl "http://localhost:3000/api/dm?models=1"
```

Then set the model to one of the returned IDs:

```env
GROQ_MODEL=openai/gpt-oss-120b
```

`openai/gpt-oss-120b` is Groq's own recommended replacement and has the strongest
JSON/instruction adherence of the current lineup, which matters for a DM that must emit
a strict schema. `qwen/qwen3.6-27b` is the lighter alternative.

No code changes are needed for this — the model ID is read from the environment on every
request, which is exactly why it was built that way.

---

### 3. CORS / `Failed to fetch` — the request never leaves the page

**Symptom.** Every command degrades to the Lite DM. The browser console shows something
like `Failed to fetch`, `TypeError: NetworkError`, or a CORS policy message.

There are three distinct causes, and Rogue-Text tells you which one you have:

**(a) You opened `index.html` by double-clicking it.** The address bar starts with
`file://`. There is no server, so there is nowhere to keep the API key. The status line
detects this and says so explicitly.

```
FIX: run  node dev-server.js  and open http://localhost:3000
```

**(b) The dev server is not running.** The page loaded from cache, or the terminal was
closed. Restart it:

```bash
node dev-server.js
```

**(c) You deployed the static files without the `api/` folder.** The live site loads, but
`POST /api/dm` returns 404 because the serverless function is missing. The client detects
this specifically and reports *"no /api/dm endpoint found (is the serverless function
deployed?)"*.

```
FIX: commit the api/ folder. Vercel auto-detects any file in /api as a function.
     Verify:  curl https://your-site.vercel.app/api/dm   → should return JSON, not 404
```

**Why you will never see a Groq CORS error specifically.** The browser never calls
`api.groq.com` — it calls `/api/dm` on its own origin, which is not a cross-origin request
at all, so no preflight is issued and no CORS policy can block it. That is the entire
reason the proxy exists. If you see a CORS error mentioning Groq directly, something has
been changed to call Groq from the client; revert that.

---

## Everything else

| Error code | Meaning | Fix |
|---|---|---|
| `bad_json` | The model rambled past its JSON twice (first attempt + repair) | Switch `GROQ_MODEL` to `openai/gpt-oss-120b`; the prompt and repair pass are already doing the work |
| `json_mode_rejected` | The model does not support `response_format` | The proxy retries once automatically without it; if it still fails, change `GROQ_MODEL` |
| `groq_rate_limited` | You have hit Groq's rate limit | Wait 60s. The game keeps playing via the Lite DM. Free tier limits are per-minute and per-day |
| `client_rate_limited` | More than 30 commands in a minute | You are clicking too fast; the guard exists to protect your quota |
| `upstream_timeout` | Groq took longer than `GROQ_TIMEOUT_MS` | Retry. Raise `GROQ_TIMEOUT_MS=45000` if it recurs |
| `upstream_unreachable` | The server could not reach Groq | Network, DNS, VPN or corporate proxy on the *server* side |
| `invalid_api_key` | Groq rejected the key | Re-copy from console.groq.com/keys; check for a trailing space or newline |
| `groq_error` | Anything else from Groq | The message is passed through verbatim; check groqstatus.com |

---

## Interpreting a turn

Every successful response includes:

```json
{
  "ok": true,
  "model": "openai/gpt-oss-120b",
  "promptVersion": "1.0.0",
  "repaired": false,
  "jsonModeFallback": false,
  "usage": { "total_tokens": 421 },
  "scene": { "narration": "…", "hpDelta": -4, "enemy": { … } }
}
```

- `repaired: true` — the first reply was malformed and a second, cheaper call fixed it.
  Rare with `gpt-oss-120b`; common with small models.
- `jsonModeFallback: true` — the model refused JSON mode and the proxy dropped
  `response_format` to keep the turn alive.
- `promptVersion` — tells you which prompt produced this scene. If it does not match the
  version in `api/prompt.js`, you are running a stale deployment.

---

## Still stuck?

1. `npm run doctor`
2. `npm test` — if a suite fails, the code on disk has been edited incorrectly
3. In the browser console: `RogueText.lastError`, then `RogueText.testDM("look")`
4. `curl http://localhost:3000/api/dm` — the proxy's own report
