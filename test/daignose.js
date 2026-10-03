/* ============================================================================
 * ROGUE-TEXT — tests/diagnose.js
 * "Why isn't my dungeon working?" — answered in one command.
 * ----------------------------------------------------------------------------
 * Checks, in order:
 *   1. Runtime      — Node version, platform, working directory
 *   2. Files        — every file the game needs, actually present
 *   3. Environment  — .env.local present? key present? key well-formed?
 *   4. Modules      — api/dm.js and api/prompt.js load without throwing
 *   5. Groq (live)  — does the key work, and is your chosen model on the key?
 *   6. Server (live)— is the local dev server up, and does /api/dm answer?
 *
 * Nothing here writes to your files. The only network call is to Groq, and
 * only when a key is present.
 *
 *   node tests/diagnose.js
 *   npm run doctor
 * ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || 3000;

let critical = 0;
const findings = [];

function line(icon, label, detail) {
    console.log("  " + icon + " " + label.padEnd(28) + (detail || ""));
}

function good(label, detail) { line("✓", label, detail); }

function warn(label, detail, fix) {
    line("!", label, detail);
    findings.push({ level: "warn", label: label, fix: fix });
}

function bad(label, detail, fix) {
    critical++;
    line("✗", label, detail);
    findings.push({ level: "error", label: label, fix: fix });
}

function info(label, detail) { line("·", label, detail); }

function section(title) {
    console.log("\n\x1b[1m" + title + "\x1b[0m");
}

/* ---------------------------------------------------------------------------
 * 1. RUNTIME
 * ------------------------------------------------------------------------ */

section("1. RUNTIME");
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 18) good("Node version", "v" + process.versions.node);
else bad("Node version", "v" + process.versions.node + " (too old)",
    "Install Node 18 or newer — global fetch() is required. https://nodejs.org");
info("Platform", process.platform + " " + process.arch);
info("Project root", ROOT);

/* ---------------------------------------------------------------------------
 * 2. FILES
 * ------------------------------------------------------------------------ */

section("2. PROJECT FILES");
const required = [
    ["index.html", "the game shell"],
    ["style.css", "the design system"],
    ["app.js", "the game logic"],
    ["api/dm.js", "the Dungeon Master proxy"],
    ["api/prompt.js", "the Dungeon Master prompt"]
];
const optional = [
    ["dev-server.js", "local runner"],
    ["package.json", "test scripts"],
    ["images/icon.png", "favicon"],
    ["images/icon.svg", "vector favicon"],
    [".env.local", "your secret key"]
];

required.forEach(function (entry) {
    const full = path.join(ROOT, entry[0]);
    if (fs.existsSync(full)) {
        good(entry[0], fs.statSync(full).size.toLocaleString() + " bytes — " + entry[1]);
    } else {
        bad(entry[0] + " MISSING", entry[1],
            "You are missing " + entry[0] + ". Re-create it from the build guide — the game cannot run without it.");
    }
});
optional.forEach(function (entry) {
    const full = path.join(ROOT, entry[0]);
    if (fs.existsSync(full)) info(entry[0], entry[1]);
    else info(entry[0] + " (absent)", entry[1] + " — optional");
});

/* ---------------------------------------------------------------------------
 * 3. ENVIRONMENT
 * ------------------------------------------------------------------------ */

section("3. ENVIRONMENT");

function loadEnvFile(filename) {
    const filePath = path.join(ROOT, filename);
    if (!fs.existsSync(filePath)) return null;
    const values = {};
    fs.readFileSync(filePath, "utf8").split(/\r?\n/).forEach(function (rawLine) {
        const lineText = rawLine.trim();
        if (!lineText || lineText.startsWith("#")) return;
        const equals = lineText.indexOf("=");
        if (equals < 0) return;
        const key = lineText.slice(0, equals).trim();
        let value = lineText.slice(equals + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        values[key] = value;
    });
    return values;
}

const envLocal = loadEnvFile(".env.local");
const envPlain = loadEnvFile(".env");
const fileEnv = Object.assign({}, envPlain, envLocal);

if (envLocal) info(".env.local", "found (" + Object.keys(envLocal).length + " keys)");
else if (envPlain) info(".env", "found (" + Object.keys(envPlain).length + " keys)");
else warn(".env.local", "not found",
    "Copy the template:  cp .env.example .env.local  (Windows: copy .env.example .env.local)  then paste your key into it.");

const apiKey = process.env.GROQ_API_KEY || fileEnv.GROQ_API_KEY || "";
const model = process.env.GROQ_MODEL || fileEnv.GROQ_MODEL || "openai/gpt-oss-120b";
const modelIsCustom = Boolean(process.env.GROQ_MODEL || fileEnv.GROQ_MODEL);

if (!apiKey) {
    bad("GROQ_API_KEY", "not set",
        "Get a free key at https://console.groq.com/keys then add it to .env.local as:\n" +
        "      GROQ_API_KEY=gsk_your_real_key_here\n" +
        "      (The game still runs — it falls back to the offline Lite DM.)");
} else if (!apiKey.startsWith("gsk_")) {
    warn("GROQ_API_KEY", "set, but does not start with 'gsk_'",
        "Groq keys start with 'gsk_'. You may have pasted the wrong value (or the placeholder " +
        "from .env.example). Re-copy it from https://console.groq.com/keys");
} else if (apiKey.length < 40) {
    warn("GROQ_API_KEY", "set, but suspiciously short (" + apiKey.length + " chars)",
        "A real Groq key is much longer. It was probably truncated on paste. Copy it again.");
} else {
    good("GROQ_API_KEY", "set and well-formed (" + apiKey.slice(0, 7) + "…, " + apiKey.length + " chars)");
}

if (/^gsk_your_real|^gsk_xxx|placeholder|changeme/i.test(apiKey)) {
    warn("API key looks like a placeholder", "it still contains template text",
        "Replace the placeholder in .env.local with your real key from https://console.groq.com/keys");
}

if (/^meta-llama\/llama-4-scout/.test(model)) {
    warn("GROQ_MODEL = " + model, "this model was RETIRED by Groq on 2026-07-17",
        "Set GROQ_MODEL=openai/gpt-oss-120b in .env.local. Scout is no longer served on the " +
        "free/developer tier — see https://console.groq.com/docs/deprecations");
} else if (/^llama-3\.[13]/.test(model) || /versatile|instant/.test(model)) {
    warn("GROQ_MODEL = " + model, "an older Llama model — many were shut down on 2026-08-16",
        "Set GROQ_MODEL=openai/gpt-oss-120b in .env.local unless you have confirmed this model is still live.");
} else {
    good("GROQ_MODEL", model + (modelIsCustom ? "  (from your env)" : "  (built-in default)"));
}

/* ---------------------------------------------------------------------------
 * 4. MODULES
 * ------------------------------------------------------------------------ */

section("4. MODULE LOADING");
let promptModule = null;
let handler = null;

try {
    promptModule = require(path.join(ROOT, "api", "prompt.js"));
    good("api/prompt.js loads", "prompt version " + promptModule.PROMPT_VERSION +
        ", system prompt " + promptModule.SYSTEM_PROMPT.length + " chars");
} catch (error) {
    bad("api/prompt.js FAILED", error.message,
        "The file is missing or has a syntax error. Re-copy it from Step 3. Node said: " + error.message);
}

try {
    handler = require(path.join(ROOT, "api", "dm.js"));
    good("api/dm.js loads", "exported a " + typeof handler + " handler");
} catch (error) {
    bad("api/dm.js FAILED", error.message,
        "The file is missing or has a syntax error. Re-copy it from Step 3/4. Node said: " + error.message);
}

/* Sanity-check the prompt's taught examples: if these are invalid JSON, the
   model will imitate invalid JSON and every turn becomes a repair pass. */
if (promptModule) {
    const examples = promptModule.SYSTEM_PROMPT.split("\n").filter(function (l) {
        return l.trim().startsWith('{"narration"');
    });
    let broken = 0;
    examples.forEach(function (example) {
        try { JSON.parse(example); } catch (error) { broken++; }
    });
    if (broken) {
        bad("Prompt examples", broken + " of " + examples.length + " are not valid JSON",
            "Re-copy api/prompt.js from Step 3 — the examples teach the model the output format.");
    } else {
        good("Prompt examples", examples.length + " few-shot examples, all valid JSON");
    }
}

/* ---------------------------------------------------------------------------
 * 5. GROQ (LIVE)
 * ------------------------------------------------------------------------ */

section("5. GROQ CONNECTIVITY (live)");

async function checkGroq() {
    if (!apiKey || apiKey.indexOf("your_real") >= 0) {
        info("Skipped", "no usable key — set GROQ_API_KEY to run live checks");
        return;
    }

    let ids = [];
    try {
        const response = await fetch("https://api.groq.com/openai/v1/models", {
            headers: { "Authorization": "Bearer " + apiKey }
        });
        const payload = await response.json().catch(function () { return null; });

        if (!response.ok) {
            const message = (payload && payload.error && (payload.error.message || payload.error.code)) ||
                ("HTTP " + response.status);
            if (response.status === 401) {
                bad("Groq rejected the key", "401 " + message,
                    "The key is wrong, revoked, or for a different account. Create a fresh one at " +
                    "https://console.groq.com/keys and update .env.local (and Vercel).");
            } else if (response.status === 429) {
                warn("Groq rate limit", "429 " + message,
                    "You have hit the rate limit. Wait a minute. The game keeps working via the Lite DM.");
            } else {
                warn("Groq responded " + response.status, message,
                    "Check status at https://groqstatus.com and try again.");
            }
            return;
        }

        ids = Array.isArray(payload && payload.data) ? payload.data.map(function (m) { return m.id; }).sort() : [];
        good("API key accepted", ids.length + " models available on this key");

        if (ids.length) {
            const onKey = ids.indexOf(model) >= 0;
            if (onKey) {
                good("Model available", model);
            } else {
                bad("MODEL NOT ON THIS KEY", model,
                    'Your key cannot use "' + model + '".\n' +
                    "      Set GROQ_MODEL in .env.local to one of these:\n" +
                    ids.slice(0, 12).map(function (id) { return "        - " + id; }).join("\n"));
                if (ids.length) info("Try first", ids[0]);
            }
        }
    } catch (error) {
        bad("Could not reach Groq", error.message,
            "This is a network or DNS problem, not a code problem. Check your internet connection, " +
            "a VPN, or a corporate proxy. The game still plays via the Lite DM.");
    }
}

/* ---------------------------------------------------------------------------
 * 6. LOCAL SERVER (LIVE)
 * ------------------------------------------------------------------------ */

function probeServer() {
    return new Promise(function (resolve) {
        const request = http.request({
            host: "127.0.0.1", port: PORT, path: "/api/dm", method: "GET", timeout: 2500
        }, function (response) {
            let body = "";
            response.on("data", function (chunk) { body += chunk; });
            response.on("end", function () { resolve({ status: response.statusCode, body: body }); });
        });
        request.on("timeout", function () { request.destroy(); resolve(null); });
        request.on("error", function () { resolve(null); });
        request.end();
    });
}

async function checkServer() {
    section("6. LOCAL SERVER (live)");
    const result = await probeServer();

    if (!result) {
        info("Not running on :" + PORT, "start it with:  node dev-server.js");
        return;
    }

    good("Server responding on :" + PORT, "HTTP " + result.status);
    try {
        const payload = JSON.parse(result.body);
        info("Prompt version", payload.promptVersion || "(older build — re-copy api/dm.js)");
        info("Key visible to server", payload.keyLoaded ? "yes" : "no");
        if (!payload.keyLoaded) {
            warn("Server has no key", "so every turn falls back to the Lite DM",
                "Put GROQ_API_KEY in .env.local and RESTART the server — .env is read at startup, " +
                "so editing it while the server runs has no effect.");
        }
    } catch (error) {
        warn("Server answered with non-JSON", result.body.slice(0, 80),
            "You may be running an old dev-server.js. Re-copy it from Step 2.");
    }
}

/* ---------------------------------------------------------------------------
 * RUN
 * ------------------------------------------------------------------------ */

(async function main() {
    console.log("\n╔══════════════════════════════════════════════════════════╗");
    console.log("║  ROGUE-TEXT — diagnostics                                ║");
    console.log("╚══════════════════════════════════════════════════════════╝");

    await checkGroq();
    await checkServer();

    section("SUMMARY");
    if (!findings.length) {
        console.log("  ✓ No problems found. Go and get eaten by something.\n");
        process.exit(0);
    }

    findings.forEach(function (finding, index) {
        const tag = finding.level === "error" ? "\x1b[31mERROR\x1b[0m" : "\x1b[33mWARN \x1b[0m";
        console.log("  " + (index + 1) + ". [" + tag + "] " + finding.label);
        if (finding.fix) {
            console.log("     FIX: " + finding.fix.split("\n").join("\n          "));
        }
        console.log("");
    });

    if (critical) {
        console.log("  " + critical + " problem(s) will stop the live Dungeon Master from answering.");
        console.log("  The game itself still runs on the offline Lite DM.\n");
        process.exit(1);
    }
    console.log("  No blocking problems. Warnings are cosmetic or optional.\n");
    process.exit(0);
})();
