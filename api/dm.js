/* ============================================================================
 * ROGUE-TEXT — api/dm.js
 * Vercel Serverless Function: the Dungeon Master proxy
 * ----------------------------------------------------------------------------
 * VERSION 2.1 — STEP 4: hardened transport.
 *   + Automatic fallback when a model rejects JSON mode (response_format)
 *   + GET /api/dm — self-diagnostics that work on Vercel, not just locally
 *   + Every failure names its own fix
 *
 * THE PIPELINE
 *   1. Receive  { command, state, history } from the browser (same origin).
 *   2. Assemble the turn: authoritative STATE BLOCK + quarantined PLAYER INPUT.
 *   3. Call Groq with JSON mode. If the model refuses it, retry once without.
 *   4. Parse. If the model rambled, run ONE repair pass at temperature 0.
 *   5. Enforce: clean the prose, clamp the numbers, normalise the shape.
 *   6. Return { ok, model, promptVersion, scene } to the client.
 *
 * DIAGNOSTICS
 *   GET /api/dm            → key loaded? model configured? prompt version?
 *   GET /api/dm?models=1   → every model ID your key can actually use
 *
 * WHY THE KEY LIVES HERE
 *   The browser can never hold a secret. The client only ever talks to its own
 *   origin (POST /api/dm), so there is no cross-origin request and no CORS
 *   preflight to fail. The key is read from process.env.GROQ_API_KEY.
 *
 * ENVIRONMENT VARIABLES (Vercel → Settings → Environment Variables)
 *   GROQ_API_KEY        required   gsk_…  (never commit; .gitignore covers it)
 *   GROQ_MODEL          optional   default: openai/gpt-oss-120b
 *   GROQ_TEMPERATURE    optional   default: 0.85  (prose creativity)
 *   GROQ_MAX_TOKENS     optional   default: 900
 *   GROQ_TIMEOUT_MS     optional   default: 30000
 *
 * NOTE ON MODELS
 *   meta-llama/llama-4-scout-17b-16e-instruct was retired by Groq on
 *   2026-07-17 (removed from the free/developer tier). Recommended current
 *   replacements: openai/gpt-oss-120b or qwen/qwen3.6-27b. Because the model
 *   is read from GROQ_MODEL, switching costs one environment variable and
 *   zero code changes — the prompt is model-agnostic by design.
 * ========================================================================== */

"use strict";

const prompt = require("./prompt.js");

/* ============================================================================
 * CONFIGURATION
 * ========================================================================== */

const GROQ_BASE = "https://api.groq.com/openai/v1";
const GROQ_ENDPOINT = GROQ_BASE + "/chat/completions";

const DEFAULTS = {
    model: "openai/gpt-oss-120b",
    temperature: 0.85,
    maxTokens: 900,
    timeoutMs: 30000,
    repairMaxTokens: 700
};

/** Cheap in-memory rate limit, per lambda instance. Stops runaway loops. */
const RATE_LIMIT = { windowMs: 60000, maxRequests: 30 };
const requestLog = new Map();

/* ============================================================================
 * HTTP HELPERS
 * ========================================================================== */

function sendJson(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.end(JSON.stringify(payload));
}

function fail(res, statusCode, code, message) {
    return sendJson(res, statusCode, { ok: false, error: { code: code, message: message } });
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function toSafeString(value, max) {
    if (value === null || value === undefined) return "";
    const str = typeof value === "string" ? value : String(value);
    return str.length > (max || 4000) ? str.slice(0, max || 4000) : str;
}

/** NaN-safe coercion. 0 is a real value — `|| fallback` would resurrect dead enemies. */
function toFiniteNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function readBody(req) {
    return new Promise(function (resolve, reject) {
        if (req.body && typeof req.body === "object") {
            return resolve(req.body);
        }
        let raw = "";
        req.on("data", function (chunk) {
            raw += chunk;
            if (raw.length > 100000) {
                reject(new Error("payload too large"));
                req.destroy();
            }
        });
        req.on("end", function () {
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch (error) {
                reject(new Error("invalid JSON body"));
            }
        });
        req.on("error", reject);
    });
}

function isRateLimited(ip) {
    const now = Date.now();
    const recent = (requestLog.get(ip) || []).filter(function (stamp) {
        return now - stamp < RATE_LIMIT.windowMs;
    });
    recent.push(now);
    requestLog.set(ip, recent);

    if (requestLog.size > 500) {
        requestLog.forEach(function (stamps, key) {
            if (!stamps.some(function (stamp) { return now - stamp < RATE_LIMIT.windowMs; })) {
                requestLog.delete(key);
            }
        });
    }

    return recent.length > RATE_LIMIT.maxRequests;
}

/* ============================================================================
 * GROQ TRANSPORT
 * ========================================================================== */

/**
 * One call to Groq. Throws an Error carrying `status` and `upstreamMessage` so
 * the caller can map it to a useful HTTP response.
 */
async function callGroq(options) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, options.timeoutMs);

    const payload = {
        model: options.model,
        messages: options.messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        top_p: 0.95,
        stream: false
    };

    /* JSON mode is requested by default, but a model that does not support it
       answers 400 — askDungeonMaster() retries without it. */
    if (options.jsonMode !== false) {
        payload.response_format = { type: "json_object" };
    }

    let response;
    try {
        response = await fetch(GROQ_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + options.apiKey
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
    } catch (error) {
        clearTimeout(timer);
        const wrapped = new Error(error.name === "AbortError"
            ? "Groq did not answer within " + options.timeoutMs + " ms."
            : "Could not reach Groq: " + error.message);
        wrapped.status = error.name === "AbortError" ? 504 : 502;
        wrapped.code = error.name === "AbortError" ? "upstream_timeout" : "upstream_unreachable";
        throw wrapped;
    }
    clearTimeout(timer);

    const text = await response.text();
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        parsed = { raw: text };
    }

    if (!response.ok) {
        const message = (parsed && parsed.error && (parsed.error.message || parsed.error.code)) ||
            ("HTTP " + response.status);
        const error = new Error(message);
        error.status = response.status;
        error.upstreamMessage = message;
        throw error;
    }

    const choice = parsed && parsed.choices && parsed.choices[0];
    const content = choice && choice.message && choice.message.content;

    return {
        content: content || "",
        model: parsed.model || options.model,
        finishReason: choice && choice.finish_reason,
        usage: parsed.usage || null,
        jsonModeFallback: options.jsonMode === false
    };
}

/**
 * Call Groq, and if the model rejects JSON mode, transparently retry once
 * without it. The system prompt already demands JSON, so this degrades
 * gracefully instead of failing the turn.
 */
async function askDungeonMaster(options) {
    try {
        return await callGroq(Object.assign({}, options, { jsonMode: true }));
    } catch (error) {
        const rejectsJsonMode = error.status === 400 && /json/i.test(String(error.upstreamMessage || error.message));
        if (!rejectsJsonMode) throw error;

        console.warn("[dm] model refused JSON mode, retrying without response_format:",
            error.upstreamMessage);
        return await callGroq(Object.assign({}, options, { jsonMode: false }));
    }
}

/** Map a thrown transport error into a specific, actionable HTTP failure. */
function respondToGroqError(res, error, model) {
    const status = error.status;
    const upstream = error.upstreamMessage || error.message;

    if (error.code === "upstream_timeout") {
        return fail(res, 504, "upstream_timeout", upstream);
    }
    if (error.code === "upstream_unreachable") {
        return fail(res, 502, "upstream_unreachable", upstream);
    }
    if (status === 401) {
        return fail(res, 401, "invalid_api_key",
            "Groq rejected the API key. Check GROQ_API_KEY for typos or a revoked key. " +
            "Verify it at GET /api/dm");
    }
    if (status === 429) {
        return fail(res, 429, "groq_rate_limited", "Groq rate limit reached: " + upstream);
    }
    if (status === 403) {
        return fail(res, 502, "model_forbidden",
            "Groq refused access to \"" + model + "\": " + upstream +
            " — this model may not be on your tier. Set GROQ_MODEL to openai/gpt-oss-120b, " +
            "or list what your key can use at GET /api/dm?models=1");
    }
    if (status === 400 && /json/i.test(String(upstream))) {
        return fail(res, 502, "json_mode_rejected",
            "The model \"" + model + "\" rejected JSON mode twice: " + upstream +
            " — switch GROQ_MODEL to a model that supports response_format json_object, or retry.");
    }
    if (status === 404 || /model/i.test(String(upstream))) {
        return fail(res, 502, "model_unavailable",
            "Model \"" + model + "\" is unavailable: " + upstream +
            " — set GROQ_MODEL to a current model, or list what your key can use at " +
            "GET /api/dm?models=1");
    }
    return fail(res, 502, "groq_error", "Groq error " + status + ": " + upstream);
}

/* ============================================================================
 * PARSING & ENFORCEMENT
 * ========================================================================== */

/**
 * Pull a JSON object out of whatever the model actually sent: clean JSON, a
 * fenced block, or JSON buried in chatty prose.
 */
function extractJson(text) {
    if (!text) throw new Error("empty completion");

    const cleaned = String(text).trim()
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/, "")
        .trim();

    try {
        return JSON.parse(cleaned);
    } catch (error) {
        /* Fall through to brace matching. */
    }

    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
        try {
            return JSON.parse(cleaned.slice(start, end + 1));
        } catch (error) {
            throw new Error("model returned unparseable JSON");
        }
    }
    throw new Error("no JSON object in model response");
}

/** Coerce anything into a clean array of unique direction strings. */
function normalizeExits(rawExits) {
    if (!Array.isArray(rawExits)) return [];
    const seen = [];
    rawExits.forEach(function (direction) {
        const value = toSafeString(direction, 24).toLowerCase().trim();
        if (!value) return;
        const canonical = (value === "n" ? "north"
            : value === "s" ? "south"
                : value === "e" ? "east"
                    : value === "w" ? "west"
                        : value === "u" ? "up"
                            : value === "d" ? "down"
                                : value);
        if (prompt.VALID_DIRECTIONS.indexOf(canonical) >= 0 && seen.indexOf(canonical) < 0) {
            seen.push(canonical);
        }
    });
    return seen.slice(0, 6);
}

function normalizeItems(rawItems) {
    if (!Array.isArray(rawItems)) return [];
    return rawItems
        .map(function (item) {
            if (typeof item === "string") {
                return { name: toSafeString(item, 80).trim(), description: "" };
            }
            if (item && typeof item === "object") {
                return {
                    name: toSafeString(item.name, 80).trim(),
                    description: toSafeString(item.description, 200).trim()
                };
            }
            return null;
        })
        .filter(function (item) { return item && item.name; })
        .slice(0, 6);
}

/**
 * The enforcement layer. Everything the model proposed passes through here
 * before the engine is allowed to believe it.
 */
function normalizeScene(raw) {
    const source = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};

    const scene = {
        narration: prompt.cleanNarration(toSafeString(source.narration, 4000)),
        roomName: toSafeString(source.roomName, 120).trim(),
        exits: normalizeExits(source.exits),
        hpDelta: clamp(Number(source.hpDelta) || 0, -25, 25),
        scoreDelta: clamp(Number(source.scoreDelta) || 0, -100, 500),
        itemsFound: normalizeItems(source.itemsFound),
        itemsLost: Array.isArray(source.itemsLost)
            ? source.itemsLost.map(function (n) { return toSafeString(n, 80).trim(); }).filter(Boolean).slice(0, 6)
            : [],
        enemy: null,
        enemyDefeated: source.enemyDefeated === true,
        status: ["playing", "dead", "victory"].indexOf(toSafeString(source.status, 16).toLowerCase()) >= 0
            ? toSafeString(source.status, 16).toLowerCase()
            : "playing",
        hint: source.hint ? toSafeString(source.hint, 120).trim() : null
    };

    /* Enemy: hp and maxHp are real, attack is derived when absent so the engine
       never computes damage from an undefined value. */
    if (source.enemy && typeof source.enemy === "object" && toSafeString(source.enemy.name, 80).trim()) {
        const rawHp = toFiniteNumber(source.enemy.hp, NaN);
        const rawMaxHp = toFiniteNumber(source.enemy.maxHp, NaN);
        const maxHp = clamp(Math.round(rawMaxHp > 0 ? rawMaxHp : (rawHp > 0 ? rawHp : 6)), 1, 999);
        const hp = clamp(Math.round(Number.isFinite(rawHp) ? rawHp : maxHp), 0, maxHp);
        if (hp > 0) {
            const explicitAttack = Number(source.enemy.attack);
            scene.enemy = {
                name: toSafeString(source.enemy.name, 80).trim(),
                maxHp: maxHp,
                hp: hp,
                description: toSafeString(source.enemy.description, 240).trim(),
                attack: Number.isFinite(explicitAttack) && explicitAttack > 0
                    ? clamp(Math.round(explicitAttack), 1, 8)
                    : clamp(Math.ceil(maxHp / 2), 1, 6)
            };
        }
    }

    /* An enemy at 0 HP is dead, whatever the model said about enemyDefeated.
       Never let a 0 read as "missing" and resurrect the creature at full health. */
    if (source.enemy && typeof source.enemy === "object" && !scene.enemy &&
        toFiniteNumber(source.enemy.hp, 1) <= 0) {
        scene.enemyDefeated = true;
    }

    /* Refusals and out-of-character replies must never reach the player. */
    if (!scene.narration) {
        scene.narration = "The Dungeon Master says nothing at all, which is deeply unhelpful and slightly terrifying.";
    } else if (prompt.looksOutOfCharacter(scene.narration)) {
        console.warn("[dm] out-of-character reply suppressed:", scene.narration.slice(0, 200));
        scene.narration = "The dungeon seems briefly distracted, as though listening to something " +
            "far away. Then the moment passes, and the stones are only stones again.";
    }

    return scene;
}

/* ============================================================================
 * DIAGNOSTICS  (GET /api/dm)
 * ========================================================================== */

async function handleDiagnostics(req, res) {
    const apiKey = process.env.GROQ_API_KEY;
    const model = process.env.GROQ_MODEL || DEFAULTS.model;

    const report = {
        ok: true,
        service: "rogue-text-dungeon-master",
        promptVersion: prompt.PROMPT_VERSION,
        keyLoaded: Boolean(apiKey),
        model: model,
        modelSource: process.env.GROQ_MODEL ? "GROQ_MODEL environment variable" : "built-in default",
        temperature: Number(process.env.GROQ_TEMPERATURE) || DEFAULTS.temperature,
        modelAvailable: null,
        availableModels: null,
        fix: null
    };

    if (!apiKey) {
        report.fix = "GROQ_API_KEY is not set on this deployment. Locally: add it to .env.local and " +
            "restart the dev server. On Vercel: Settings → Environment Variables, then REDEPLOY " +
            "(environment changes do not apply to existing deployments).";
        return sendJson(res, 200, report);
    }

    if (/models=1/.test(String(req.url || ""))) {
        try {
            const response = await fetch(GROQ_BASE + "/models", {
                headers: { "Authorization": "Bearer " + apiKey }
            });
            const payload = await response.json().catch(function () { return null; });

            if (!response.ok) {
                report.availableModels = null;
                report.fix = "Groq rejected the key while listing models (HTTP " + response.status + "). " +
                    "Create a fresh key at https://console.groq.com/keys";
            } else {
                const ids = Array.isArray(payload && payload.data)
                    ? payload.data.map(function (m) { return m.id; }).sort()
                    : [];
                report.availableModels = ids;
                report.modelAvailable = ids.indexOf(model) >= 0;
                if (!report.modelAvailable) {
                    report.fix = 'Your key cannot use "' + model + '". Choose one from availableModels ' +
                        "and set GROQ_MODEL to it, in .env.local and in Vercel.";
                }
            }
        } catch (error) {
            report.fix = "Could not reach Groq to list models: " + error.message;
        }
    }

    return sendJson(res, 200, report);
}

/* ============================================================================
 * HANDLER
 * ========================================================================== */

module.exports = async function handler(req, res) {
    /* --- CORS preflight ------------------------------------------------- */
    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.end();
        return;
    }

    /* --- diagnostics (works on Vercel as well as locally) --------------- */
    if (req.method === "GET" || req.method === "HEAD") {
        if (req.method === "HEAD") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end();
            return;
        }
        return handleDiagnostics(req, res);
    }

    if (req.method !== "POST") {
        return fail(res, 405, "method_not_allowed",
            "Use POST /api/dm to play, or GET /api/dm for diagnostics.");
    }

    /* --- rate limit ----------------------------------------------------- */
    const forwarded = req.headers["x-forwarded-for"];
    const ip = (typeof forwarded === "string" && forwarded.split(",")[0].trim()) || "unknown";
    if (isRateLimited(ip)) {
        return fail(res, 429, "client_rate_limited", "Too many commands too quickly. Give the Dungeon Master a breath.");
    }

    /* --- config --------------------------------------------------------- */
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        return fail(res, 500, "missing_api_key",
            "GROQ_API_KEY is not set. Locally: add it to .env.local and restart the dev server. " +
            "On Vercel: Project → Settings → Environment Variables, then redeploy. " +
            "Check GET /api/dm for a full report.");
    }

    const model = process.env.GROQ_MODEL || DEFAULTS.model;
    const temperature = clamp(Number(process.env.GROQ_TEMPERATURE) || DEFAULTS.temperature, 0, 2);
    const maxTokens = clamp(Number(process.env.GROQ_MAX_TOKENS) || DEFAULTS.maxTokens, 64, 4096);
    const timeoutMs = clamp(Number(process.env.GROQ_TIMEOUT_MS) || DEFAULTS.timeoutMs, 2000, 120000);

    /* --- input ---------------------------------------------------------- */
    let body;
    try {
        body = await readBody(req);
    } catch (error) {
        return fail(res, 400, "bad_request", error.message);
    }

    const command = prompt.sanitizeCommand(body.command);
    if (!command) {
        return fail(res, 400, "empty_command", "Send a non-empty `command` string.");
    }

    /* Conversation memory: the client's last few turns, re-validated here. */
    const history = Array.isArray(body.history)
        ? body.history
            .filter(function (message) {
                return message &&
                    (message.role === "user" || message.role === "assistant") &&
                    typeof message.content === "string" &&
                    message.content.trim();
            })
            .slice(-12)
            .map(function (message) {
                return { role: message.role, content: toSafeString(message.content, 1200) };
            })
        : [];

    const messages = [{ role: "system", content: prompt.SYSTEM_PROMPT }]
        .concat(history)
        .concat([{ role: "user", content: prompt.buildTurnMessage(body.state, command) }]);

    /* --- ask the Dungeon Master (with JSON-mode fallback) --------------- */
    let completion;
    try {
        completion = await askDungeonMaster({
            apiKey: apiKey,
            model: model,
            messages: messages,
            temperature: temperature,
            maxTokens: maxTokens,
            timeoutMs: timeoutMs
        });
    } catch (error) {
        return respondToGroqError(res, error, model);
    }

    /* --- parse, with one repair pass ------------------------------------ */
    let scene = null;
    let repaired = false;

    try {
        scene = normalizeScene(extractJson(completion.content));
    } catch (parseError) {
        console.warn("[dm] first parse failed, attempting repair:", parseError.message);

        try {
            const repair = await askDungeonMaster({
                apiKey: apiKey,
                model: model,
                messages: [
                    { role: "system", content: "You convert malformed text into valid JSON. Output only the JSON object, nothing else." },
                    { role: "user", content: prompt.buildRepairPrompt(completion.content, command) }
                ],
                temperature: 0,
                maxTokens: DEFAULTS.repairMaxTokens,
                timeoutMs: timeoutMs
            });
            scene = normalizeScene(extractJson(repair.content));
            repaired = true;
        } catch (repairError) {
            console.error("[dm] repair failed:", repairError.message,
                "| raw:", String(completion.content).slice(0, 400));
            return fail(res, 502, "bad_json",
                "The Dungeon Master rambled past its JSON twice. Try that command again, " +
                "or set GROQ_MODEL to a model with stronger instruction-following (openai/gpt-oss-120b).");
        }
    }

    /* --- respond -------------------------------------------------------- */
    return sendJson(res, 200, {
        ok: true,
        model: completion.model,
        promptVersion: prompt.PROMPT_VERSION,
        repaired: repaired,
        jsonModeFallback: completion.jsonModeFallback === true,
        usage: completion.usage,
        finishReason: completion.finishReason,
        scene: scene
    });
};