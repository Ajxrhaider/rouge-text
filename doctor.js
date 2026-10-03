/* ============================================================================
 * ROGUE-TEXT — doctor.js        ONE FILE. NO DEPENDENCIES. NO tests/ NEEDED.
 * ----------------------------------------------------------------------------
 *   node doctor.js
 *
 * Checks: package.json parses · core files present · api/dm.js exports
 * something CALLABLE · the handler actually ANSWERS a real request · .env.local
 * key/model/endpoint · the model is reachable and available · dev server up.
 *
 * Every problem prints the exact command that fixes it.
 * ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { Readable } = require("stream");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const problems = [];
const warnings = [];

console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║  ROGUE-TEXT — doctor                                     ║");
console.log("╚══════════════════════════════════════════════════════════╝");

const head = (t) => console.log("\n\x1b[1m" + t + "\x1b[0m");
const pass = (l, d) => console.log("  \x1b[32m✓\x1b[0m " + l.padEnd(24) + (d || ""));
const info = (l, d) => console.log("  \x1b[90m·\x1b[0m " + l.padEnd(24) + (d || ""));
const warn = (l, d, f) => { console.log("  \x1b[33m!\x1b[0m " + l.padEnd(24) + (d || "")); warnings.push([l, f]); };
const fail = (l, d, f) => { console.log("  \x1b[31m✗\x1b[0m " + l.padEnd(24) + (d || "")); problems.push([l, f]); };

/* ---------------------------------------------------------------- 1. config */
head("1. package.json");
let configOk = true;
try {
    const raw = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
    if (/^\s*\/[/*]/.test(raw)) {
        configOk = false;
        fail("HAS A COMMENT", "the file starts with // or /*",
            "JSON does not support comments — a '/* ===' header is a JavaScript comment.\n" +
            "      Rewrite package.json with the heredoc from the build guide.");
    } else {
        JSON.parse(raw);
        pass("valid JSON", raw.length + " bytes");
    }
} catch (error) {
    configOk = false;
    const missing = /ENOENT/.test(error.message);
    fail(missing ? "not found" : "INVALID", missing ? "" : error.message,
        missing ? "Optional, but npm scripts need it."
            : "package.json must be PURE JSON. No // and no /* */ comments.\n" +
              "      IMPORTANT: while this file is broken, Node cannot run ANY script.\n" +
              "      Rewrite it with the heredoc from the build guide, then rerun doctor.");
}

/* ----------------------------------------------------------------- 2. files */
head("2. Files");
[["index.html", 8000], ["style.css", 8000], ["app.js", 20000],
 ["api/dm.js", 3000], ["api/prompt.js", 3000], ["dev-server.js", 3000]]
    .forEach(function (entry) {
        const filePath = path.join(ROOT, entry[0]);
        if (!fs.existsSync(filePath)) { fail(entry[0], "MISSING", "Re-create it from the build guide."); return; }
        const size = fs.statSync(filePath).size;
        if (size === 0) { fail(entry[0], "IS EMPTY (0 bytes)", "Delete it and paste the whole file again."); return; }
        if (size < entry[1]) {
            fail(entry[0], "TRUNCATED — " + size + " bytes", "Paste landed partially. Paste the complete file.");
            return;
        }
        pass(entry[0], size.toLocaleString() + " bytes");
    });

/* --------------------------------------------------------------- 3. handler */
head("3. api/dm.js export");

function resolveHandler(mod) {
    if (typeof mod === "function") return mod;
    if (!mod || typeof mod !== "object") return null;
    if (typeof mod.default === "function") return mod.default;
    if (typeof mod.handler === "function") return mod.handler;
    if (mod.default && typeof mod.default.handler === "function") return mod.default.handler;
    return null;
}

let handler = null;
const dmPath = path.join(ROOT, "api", "dm.js");

if (fs.existsSync(dmPath)) {
    try {
        const mod = require(dmPath);
        const shape = typeof mod + (typeof mod === "object" && mod !== null
            ? " keys=[" + Object.keys(mod).join(",") + "]" : "");
        info("shape", shape);
        handler = resolveHandler(mod);
        if (handler) pass("callable", "exports a function");
        else {
            fail("NOT CALLABLE", shape,
                "It must export a function. The file should end with:\n" +
                "        module.exports = handleRequest;\n" +
                "        module.exports.handler = handleRequest;\n" +
                "        module.exports.default = handleRequest;\n" +
                "      Paste api/dm.js from Step 4.1, which exports all three shapes.");
        }
    } catch (error) {
        fail("FAILED TO LOAD", error.message, "Re-paste api/dm.js — Node said:\n      " + error.message);
    }
}

/* ------------------------------------------------- 4. invoke it for real */
function invoke(h) {
    return new Promise(function (resolve) {
        const body = JSON.stringify({
            command: "look",
            state: { hp: 20, maxHp: 20, turns: 0, location: "The Threshold", exits: [], inventory: [], visited: [] }
        });
        const req = Readable.from([body]);
        req.method = "POST";
        req.url = "/api/dm";
        req.headers = { "x-forwarded-for": "127.0.0.1" };

        let settled = false;
        let status = 0;
        const res = {
            setHeader: function () {},
            end: function (chunk) {
                if (settled) return;
                settled = true;
                let payload; try { payload = JSON.parse(chunk); } catch (e) { payload = {}; }
                resolve({ status: status, payload: payload });
            }
        };
        Object.defineProperty(res, "statusCode", {
            get: function () { return status; }, set: function (v) { status = v; }
        });
        setTimeout(function () {
            if (!settled) { settled = true; resolve({ status: -1, payload: { error: { code: "hung" } } }); }
        }, 12000);

        try {
            const out = h(req, res);
            if (out && typeof out.catch === "function") {
                out.catch(function (error) {
                    if (!settled) { settled = true; resolve({ status: -2, payload: { error: { code: "threw", message: error.message } } }); }
                });
            }
        } catch (error) {
            if (!settled) { settled = true; resolve({ status: -3, payload: { error: { code: "threw", message: error.message } } }); }
        }
    });
}

/* ---------------------------------------------------- 5. environment (.env) */
function readEnv() {
    for (const name of [".env.local", ".env"]) {
        const filePath = path.join(ROOT, name);
        if (!fs.existsSync(filePath)) continue;
        const values = {};
        fs.readFileSync(filePath, "utf8").split(/\r?\n/).forEach(function (line) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) return;
            const eq = trimmed.indexOf("=");
            if (eq < 0) return;
            const key = trimmed.slice(0, eq).trim();
            let value = trimmed.slice(eq + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (!(key in values)) values[key] = value;
        });
        return { name: name, values: values, raw: fs.readFileSync(filePath, "utf8") };
    }
    return null;
}

const envFile = readEnv();
const env = envFile ? envFile.values : {};
const apiKey = process.env.GROQ_API_KEY || env.GROQ_API_KEY || "";
const model = process.env.GROQ_MODEL || env.GROQ_MODEL || "openai/gpt-oss-120b";
const base = (process.env.GROQ_API_BASE || env.GROQ_API_BASE || "https://api.groq.com/openai/v1").replace(/\/+$/, "");

head("4. Environment");
if (!envFile) warn(".env.local", "not found", "cp .env.example .env.local   then add your key.");
else info(envFile.name, "loaded");

const mockLines = envFile ? envFile.raw.split(/\r?\n/).filter(function (line) {
    return /^\s*GROQ_/.test(line) && /gsk_mock|127\.0\.0\.1|localhost|mock\//.test(line);
}) : [];

if (/127\.0\.0\.1|localhost/.test(base) || /^mock\//.test(model) || mockLines.length) {
    fail("MOCK SETTINGS IN .env.local", mockLines.length + " mock line(s)",
        "These come from testing with tests/mock-groq.js. A localhost GROQ_API_BASE makes\n" +
        "      EVERY real turn fail (the game silently falls back to the Lite DM). Remove them:\n" +
        "        cp .env.local .env.local.bak\n" +
        "        grep -v -E 'gsk_mock|GROQ_API_BASE|mock/dungeon-master|mock/backup-dm' .env.local.bak > .env.local\n" +
        "        cat .env.local");
} else if (!apiKey) {
    fail("GROQ_API_KEY", "not set",
        "Get a key at https://console.groq.com/keys and add it to .env.local:\n" +
        "        GROQ_API_KEY=gsk_your_real_key_here\n" +
        "      The game still plays via the Lite DM until then.");
} else if (!/^gsk_/.test(apiKey)) {
    warn("GROQ_API_KEY", "does not start with gsk_", "Check the whole key was copied.");
} else {
    pass("GROQ_API_KEY", apiKey.slice(0, 7) + "… (" + apiKey.length + " chars)");
}

if (/^meta-llama\/llama-4-scout/.test(model)) {
    fail("GROQ_MODEL RETIRED", model + " (shut down 2026-07-17)", "Set GROQ_MODEL=openai/gpt-oss-120b");
} else {
    pass("GROQ_MODEL", model);
}
info("endpoint", base);

/* ------------------------------------------------------- 6. live endpoint */
async function checkEndpoint() {
    head("6. Model endpoint");
    if (!apiKey || /^gsk_mock/.test(apiKey) || /127\.0\.0\.1|localhost/.test(base)) {
        info("skipped", "no usable real key — fix section 4 first");
        return;
    }
    try {
        const controller = new AbortController();
        const timer = setTimeout(function () { controller.abort(); }, 10000);
        const response = await fetch(base + "/models", {
            headers: { "Authorization": "Bearer " + apiKey }, signal: controller.signal
        });
        clearTimeout(timer);
        const payload = await response.json().catch(function () { return null; });

        if (response.status === 401) { fail("key REJECTED", "HTTP 401", "Create a fresh key at console.groq.com/keys"); return; }
        if (!response.ok) { warn("endpoint HTTP " + response.status, "", "Check the URL and your network."); return; }

        const ids = Array.isArray(payload && payload.data) ? payload.data.map((m) => m.id).sort() : [];
        pass("key accepted", ids.length + " models available");
        if (ids.indexOf(model) >= 0) pass("model available", model);
        else fail("MODEL NOT ON THIS KEY", model,
            "Set GROQ_MODEL in .env.local to one of:\n" +
            ids.slice(0, 8).map((id) => "        " + id).join("\n"));
    } catch (error) {
        fail("could not reach the endpoint", error.message, "Network/DNS/VPN problem on this machine.");
    }
}

/* ---------------------------------------------------------- 7. dev server */
function probe() {
    return new Promise(function (resolve) {
        const request = http.request({ host: "127.0.0.1", port: PORT, path: "/api/health", method: "GET", timeout: 2500 },
            function (response) {
                let body = ""; response.on("data", (c) => (body += c)); response.on("end", () => resolve(body));
            });
        request.on("timeout", function () { request.destroy(); resolve(null); });
        request.on("error", function () { resolve(null); });
        request.end();
    });
}

/* -------------------------------------------------------------- run it all */
(async function main() {
    if (handler) {
        head("5. Live handler test  (calls your api/dm.js for real)");
        const result = await invoke(handler);
        const code = (result.payload.error || {}).code;

        if (result.status === 200 && result.payload.ok === true) {
            pass("HANDLER WORKS", "HTTP 200 — produced a full turn");
            info("model", result.payload.modelUsed || result.payload.model || "?");
            info("narration", String((result.payload.scene || {}).narration || "").slice(0, 58) + "…");
        } else if (result.status === 500 && code === "missing_api_key") {
            pass("HANDLER WORKS", "HTTP 500 missing_api_key — correct with no key");
            info("", "Your api/dm.js is FINE. Just add a key.");
        } else if (result.status === 401) {
            fail("key REJECTED by the model endpoint", "", "Create a fresh key.");
        } else if (code === "upstream_unreachable") {
            fail("could not reach the model", (result.payload.error || {}).message || "",
                "Check .env.local for a stale GROQ_API_BASE (e.g. a mock on :3100).");
        } else if (result.status === -1) {
            fail("handler HUNG", "never called res.end()", "Paste api/dm.js again.");
        } else if (result.status < 0) {
            fail("handler THREW", (result.payload.error || {}).message || "", "Paste api/dm.js again.");
        } else {
            warn("answered HTTP " + result.status, code || "",
                "Unexpected but not fatal. Run the curl in TROUBLESHOOTING.md.");
        }
    }

    await checkEndpoint();

    head("7. Dev server");
    const body = await probe();
    if (!body) info("not running on :" + PORT, "start it:  node dev-server.js");
    else {
        let payload = null; try { payload = JSON.parse(body); } catch (e) { payload = null; }
        if (!payload) warn("answered non-JSON", "old dev-server.js?", "Paste dev-server.js from Step 4.1.");
        else {
            pass("running on :" + PORT, "handlerReady=" + payload.handlerReady + " keyLoaded=" + payload.keyLoaded);
            if (!payload.keyLoaded) info("no key loaded", "RESTART the server after editing .env.local");
        }
    }

    head("SUMMARY");
    if (!problems.length && !warnings.length) {
        console.log("  \x1b[32m✓ Everything checks out.\x1b[0m  Play:  node dev-server.js\n");
        process.exit(0);
    }
    problems.forEach(([label, fix], i) => {
        console.log("  " + (i + 1) + ". \x1b[31mBLOCKING\x1b[0m  " + label);
        if (fix) console.log("     FIX: " + fix.split("\n").join("\n          "));
        console.log("");
    });
    warnings.forEach(([label, fix], i) => {
        console.log("  " + (problems.length + i + 1) + ". \x1b[33mWARNING \x1b[0m  " + label);
        if (fix) console.log("     FIX: " + fix.split("\n").join("\n          "));
        console.log("");
    });
    console.log(problems.length
        ? "  " + problems.length + " blocking problem(s). Fix top-down, then rerun: node doctor.js\n"
        : "  No blocking problems.\n");
    process.exit(problems.length ? 1 : 0);
})();
