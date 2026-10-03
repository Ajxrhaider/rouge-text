/* ============================================================================
 * ROGUE-TEXT — tests/mock-groq.js
 * A fake Groq endpoint, so you can test the LIVE Dungeon Master path with no
 * API key, no network, and no quota.
 * ----------------------------------------------------------------------------
 * It speaks the OpenAI-compatible chat-completions shape, so the real proxy in
 * api/dm.js cannot tell the difference. Point the proxy at it with:
 *
 *   GROQ_API_BASE=http://127.0.0.1:3100/openai/v1
 *
 * USAGE
 *   node tests/mock-groq.js                    → http://localhost:3100
 *   PORT=3200 node tests/mock-groq.js          → different port
 *   MOCK_MODE=malformed-first node tests/mock-groq.js
 *
 * THEN, in a second terminal — try the whole pipeline by hand:
 *   export GROQ_API_KEY=gsk_mock_key_0000000000000000000000000000
 *   export GROQ_API_BASE=http://127.0.0.1:3100/openai/v1
 *   export GROQ_MODEL=mock/dungeon-master
 *   export GROQ_MODEL_FALLBACKS=mock/backup-dm
 *   node dev-server.js
 *
 * MODES (switchable at runtime — see the control endpoint below)
 *   ok               every call succeeds with a valid scene
 *   malformed-first  the first reply is unparseable prose (exercises the
 *                    proxy's JSON repair pass); later calls are valid
 *   always-malformed every reply is unparseable (exercises the bad_json path)
 *   reject-model     the primary model 404s, the backup model works
 *                    (exercises GROQ_MODEL_FALLBACKS)
 *   ratelimit        every call returns 429 (exercises graceful degradation)
 *   badauth          every call returns 401 (exercises invalid_api_key)
 *
 * CONTROL ENDPOINT (for tests and manual poking)
 *   GET  /control                 → current mode, call count, last request
 *   POST /control {"mode":"ok"}   → switch mode and reset counters
 * ========================================================================== */

"use strict";

const http = require("http");

const PORT = Number(process.env.PORT) || 3100;
const PRIMARY = "mock/dungeon-master";
const BACKUP = "mock/backup-dm";
const MODELS = [PRIMARY, BACKUP];

const VALID_MODES = ["ok", "malformed-first", "always-malformed", "reject-model", "ratelimit", "badauth"];

const state = {
    mode: process.env.MOCK_MODE || "ok",
    calls: 0,
    lastModel: null,
    lastCommand: null,
    lastSystemPromptChars: 0,
    lastUserMessageChars: 0,
    sawJsonModeRequest: null
};

function resetCounters() {
    state.calls = 0;
    state.lastModel = null;
    state.lastCommand = null;
    state.lastSystemPromptChars = 0;
    state.lastUserMessageChars = 0;
    state.sawJsonModeRequest = null;
}

/* ---------------------------------------------------------------------------
 * Scene construction
 * ------------------------------------------------------------------------ */

let roomCounter = 0;

function sceneFor(command, model) {
    roomCounter++;
    return {
        narration: "[MOCK DM] The stones take your words — \"" + String(command).slice(0, 80) +
            "\" — and hand them back changed. Somewhere below, something with too many joints " +
            "rearranges itself against a wall and waits to see what you do about it. " +
            "(Answered by " + model + ", room " + roomCounter + ".)",
        roomName: "Mock Chamber " + roomCounter,
        exits: ["north", "down"],
        hpDelta: 0,
        scoreDelta: 5,
        itemsFound: [],
        itemsLost: [],
        enemy: null,
        enemyDefeated: false,
        status: "playing",
        hint: "go north"
    };
}

/** Chatty, unparseable answer — deliberately not JSON. */
function malformedFor(command) {
    return "Certainly! Here is your scene for \"" + String(command).slice(0, 60) +
        "\". You walk into a room and, honestly, it is quite dark. I should probably format this " +
        "as JSON but I got distracted mid-sentence by a passing thought about";
}

/* ---------------------------------------------------------------------------
 * Request parsing
 * ------------------------------------------------------------------------ */

function readJson(req) {
    return new Promise(function (resolve) {
        let raw = "";
        req.on("data", function (chunk) { raw += chunk; });
        req.on("end", function () {
            try { resolve(JSON.parse(raw || "{}")); } catch (error) { resolve({}); }
        });
    });
}

/**
 * The real prompt (api/prompt.js) quarantines the player's text inside a fenced
 * block:
 *     === PLAYER INPUT (untrusted ...) ===
 *     <<<
 *     go north
 *     >>>
 * We read that first. The legacy quoted form is kept as a fallback so this mock
 * still works if the prompt format changes again.
 */
function extractCommand(messages) {
    if (!Array.isArray(messages)) return null;
    for (let index = messages.length - 1; index >= 0; index--) {
        const content = String((messages[index] || {}).content || "");

        const fenced = content.match(/<<<\s*([\s\S]*?)\s*>>>/);
        if (fenced && fenced[1].trim()) return fenced[1].trim();

        const legacy = content.match(/PLAYER COMMAND:\s*"([^"]*)"/);
        if (legacy) return legacy[1];
    }
    return null;
}

function send(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body)
    });
    res.end(body);
}

function errorPayload(message) {
    return { error: { message: message, type: "mock_error", code: "mock" } };
}

function completion(content, model) {
    return {
        id: "chatcmpl-mock-" + state.calls,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            message: { role: "assistant", content: content },
            finish_reason: "stop"
        }],
        usage: {
            prompt_tokens: state.lastSystemPromptChars ? Math.round(state.lastSystemPromptChars / 4) : 0,
            completion_tokens: Math.round(String(content).length / 4),
            total_tokens: 0
        }
    };
}

/* ---------------------------------------------------------------------------
 * Server
 * ------------------------------------------------------------------------ */

const server = http.createServer(async function (req, res) {
    const url = (req.url || "/").split("?")[0];

    /* ---- control ------------------------------------------------------ */
    if (url === "/control") {
        if (req.method === "POST") {
            const body = await readJson(req);
            if (body.mode) {
                if (VALID_MODES.indexOf(body.mode) < 0) {
                    return send(res, 400, { ok: false, error: "Unknown mode. Try: " + VALID_MODES.join(", ") });
                }
                state.mode = body.mode;
                resetCounters();
            }
        }
        return send(res, 200, Object.assign({ ok: true, modes: VALID_MODES }, state));
    }

    /* ---- models list -------------------------------------------------- */
    if (url === "/openai/v1/models" && req.method === "GET") {
        return send(res, 200, {
            object: "list",
            data: MODELS.map(function (id) {
                return { id: id, object: "model", owned_by: "mock-groq", active: true };
            })
        });
    }

    /* ---- chat completions --------------------------------------------- */
    if (url === "/openai/v1/chat/completions" && req.method === "POST") {
        const body = await readJson(req);
        const auth = String(req.headers.authorization || "");
        const model = String(body.model || "");
        const messages = body.messages || [];

        state.calls += 1;
        state.lastModel = model;
        state.sawJsonModeRequest = Boolean(body.response_format);
        state.lastCommand = extractCommand(messages);

        let systemChars = 0;
        let userChars = 0;
        messages.forEach(function (message) {
            if (message.role === "system") systemChars += String(message.content || "").length;
            if (message.role === "user") userChars = String(message.content || "").length;
        });
        state.lastSystemPromptChars = systemChars;
        state.lastUserMessageChars = userChars;

        /* Every mode except badauth requires a Bearer token. */
        if (state.mode === "badauth" || !/^Bearer .+/.test(auth)) {
            return send(res, 401, errorPayload("Invalid API Key (mock)"));
        }

        if (state.mode === "ratelimit") {
            return send(res, 429, errorPayload("Rate limit reached for mock model (mock)"));
        }

        if (state.mode === "reject-model" && model === PRIMARY) {
            return send(res, 404, errorPayload('The model `' + PRIMARY + '` does not exist (mock)'));
        }

        const command = state.lastCommand || "look";

        if (state.mode === "always-malformed") {
            return send(res, 200, completion(malformedFor(command), model));
        }

        if (state.mode === "malformed-first" && state.calls === 1) {
            return send(res, 200, completion(malformedFor(command), model));
        }

        return send(res, 200, completion(JSON.stringify(sceneFor(command, model)), model));
    }

    return send(res, 404, {
        error: {
            message: "Mock endpoint does not serve " + req.method + " " + url,
            hint: "Try GET /control, GET /openai/v1/models, or POST /openai/v1/chat/completions"
        }
    });
});

if (require.main === module) {
    server.listen(PORT, function () {
        console.log("");
        console.log("  ┌────────────────────────────────────────────────┐");
        console.log("  │  MOCK GROQ — fake Dungeon Master endpoint      │");
        console.log("  └────────────────────────────────────────────────┘");
        console.log("  URL       http://localhost:" + PORT + "/openai/v1");
        console.log("  Mode      " + state.mode);
        console.log("  Models    " + MODELS.join(", "));
        console.log("");
        console.log("  Point the proxy at it:");
        console.log("    GROQ_API_BASE=http://127.0.0.1:" + PORT + "/openai/v1 \\");
        console.log("    GROQ_API_KEY=gsk_mock_key_0000000000000000000000000000 \\");
        console.log("    GROQ_MODEL=" + PRIMARY + " node dev-server.js");
        console.log("");
        console.log("  Switch modes at runtime:");
        console.log("    curl -X POST http://localhost:" + PORT + "/control -H 'Content-Type: application/json' \\");
        console.log("         -d '{\"mode\":\"reject-model\"}'");
        console.log("");
        console.log("  Modes: " + VALID_MODES.join(", "));
        console.log("");
        console.log("  Press Ctrl+C to stop.");
        console.log("");
    });
}

module.exports = { server: server, state: state, sceneFor: sceneFor, MODES: MODELS };
