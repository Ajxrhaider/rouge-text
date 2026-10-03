/* ============================================================================
 * ROGUE-TEXT — dev-server.js
 * A zero-dependency local runner for development.
 * ----------------------------------------------------------------------------
 * VERSION 1.1 — hardened.
 *   + Accepts EVERY module export shape (function, { handler }, { default },
 *     { default: { handler } }) so a mismatched api/dm.js can never crash it.
 *   + Verifies the handler AT BOOT and prints exactly what is wrong and how to
 *     fix it, instead of throwing a stack trace on your first command.
 *   + Never exits: if the handler is broken, the game still serves and the
 *     client falls back to the Lite DM while it tells you why.
 *
 * WHAT IT DOES
 *   1. Serves the static files (index.html, style.css, app.js, images/…)
 *   2. Routes /api/* to the real serverless handler in ./api/dm.js
 *   3. Loads secrets from .env.local / .env, exactly as Vercel would
 *   4. /api/health reports what it found (key, model, env files)
 *
 * USAGE
 *   node dev-server.js                 → http://localhost:3000
 *   PORT=3200 node dev-server.js       → pick a port
 *   GROQ_API_BASE=http://127.0.0.1:3100/openai/v1 node dev-server.js
 *                                      → point at the mock in tests/mock-groq.js
 *
 * NOTE
 *   Development convenience only. Vercel runs api/dm.js natively and does not
 *   need this file.
 * ========================================================================== */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

/* ---------------------------------------------------------------------------
 * 1. Minimal .env loader (no dotenv dependency)
 * ------------------------------------------------------------------------ */

function loadEnvFile(filename) {
    const filePath = path.join(ROOT, filename);
    if (!fs.existsSync(filePath)) return false;

    fs.readFileSync(filePath, "utf8").split(/\r?\n/).forEach(function (line) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;

        const equals = trimmed.indexOf("=");
        if (equals < 0) return;

        const key = trimmed.slice(0, equals).trim();
        let value = trimmed.slice(equals + 1).trim();

        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        /* Real environment variables win over file values. */
        if (!(key in process.env)) process.env[key] = value;
    });

    return true;
}

const loadedEnvFiles = [];
if (loadEnvFile(".env.local")) loadedEnvFiles.push(".env.local");
if (loadEnvFile(".env")) loadedEnvFiles.push(".env");

/* ---------------------------------------------------------------------------
 * 2. Handler resolution — the crash-proof part
 * ------------------------------------------------------------------------ */

/**
 * Accept every export shape a module might use.
 * @returns {Function|null}
 */
function resolveHandler(mod) {
    if (typeof mod === "function") return mod;
    if (!mod || typeof mod !== "object") return null;
    if (typeof mod.default === "function") return mod.default;          /* ESM default */
    if (typeof mod.handler === "function") return mod.handler;          /* Netlify / AWS */
    if (mod.default && typeof mod.default.handler === "function") return mod.default.handler;
    return null;
}

/** Human-readable description of a module, for error messages. */
function describeModule(mod, filePath) {
    let size = "unknown";
    try { size = fs.statSync(filePath).size.toLocaleString() + " bytes"; } catch (error) { /* ignore */ }

    if (mod === undefined) return "loaded but imported as undefined (" + size + ")";
    if (mod === null) return "exported null (" + size + ")";

    const keys = typeof mod === "object" ? Object.keys(mod) : [];
    return "exported " + typeof mod +
        (keys.length ? " with keys [" + keys.join(", ") + "]" : " with no keys") +
        " — file is " + size;
}

let dmHandler = null;
let dmProblem = null;
let dmShape = "not loaded";

(function loadDmHandler() {
    const filePath = path.join(ROOT, "api", "dm.js");

    if (!fs.existsSync(filePath)) {
        dmProblem = "api/dm.js does not exist.";
        return;
    }

    let mod;
    try {
        mod = require(filePath);
    } catch (error) {
        dmProblem = "api/dm.js could not be loaded: " + error.message;
        return;
    }

    dmShape = describeModule(mod, filePath);
    dmHandler = resolveHandler(mod);

    if (!dmHandler) {
        dmProblem = "api/dm.js loaded, but it does not export a callable function. It " + dmShape + ".";
    }
})();

/* ---------------------------------------------------------------------------
 * 3. Static file serving
 * ------------------------------------------------------------------------ */

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json"
};

function serveStatic(req, res) {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const filePath = path.join(ROOT, relative);

    /* Path traversal guard: never serve anything outside the project root. */
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
    }

    fs.stat(filePath, function (statError, stats) {
        if (statError || !stats.isFile()) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("404 — not found: " + relative);
            return;
        }

        const extension = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            "Content-Type": MIME[extension] || "application/octet-stream",
            "Cache-Control": "no-store",
            "Content-Length": stats.size
        });

        if (req.method === "HEAD") { res.end(); return; }

        const stream = fs.createReadStream(filePath);
        stream.on("error", function () {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Read error");
        });
        stream.pipe(res);
    });
}

/* ---------------------------------------------------------------------------
 * 4. API routing
 * ------------------------------------------------------------------------ */

function serveHealth(res) {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
        ok: true,
        handlerReady: Boolean(dmHandler),
        handlerShape: dmShape,
        handlerProblem: dmProblem,
        keyLoaded: Boolean(process.env.GROQ_API_KEY),
        model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
        fallbacks: String(process.env.GROQ_MODEL_FALLBACKS || "").split(",").filter(Boolean),
        apiBase: process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1",
        envFiles: loadedEnvFiles
    }));
}

function serveHandlerProblem(res) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
        ok: false,
        error: {
            code: "handler_not_callable",
            message: dmProblem + " Run this to see exactly what is in the file:\n" +
                "  node -e \"const m=require('./api/dm.js');console.log(typeof m, Object.keys(m))\"\n" +
                "Then replace api/dm.js with the Step 4.1 version (it exports all three shapes).",
            shape: dmShape
        }
    }));
}

function createServer() {
    return http.createServer(function (req, res) {
        const urlPath = (req.url || "/").split("?")[0];

        if (urlPath === "/api/health") {
            serveHealth(res);
            return;
        }

        if (urlPath === "/api/dm" || urlPath.startsWith("/api/")) {
            if (!dmHandler) {
                serveHandlerProblem(res);
                return;
            }
            try {
                Promise.resolve(dmHandler(req, res)).catch(function (error) {
                    console.error("[dev-server] handler threw:", error);
                    if (!res.headersSent) {
                        res.writeHead(500, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({
                            ok: false,
                            error: { code: "handler_crash", message: error.message }
                        }));
                    }
                });
            } catch (error) {
                /* A synchronous throw from the handler must not kill the server. */
                console.error("[dev-server] handler threw synchronously:", error);
                if (!res.headersSent) {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                        ok: false,
                        error: { code: "handler_crash", message: error.message }
                    }));
                }
            }
            return;
        }

        serveStatic(req, res);
    });
}

/* ---------------------------------------------------------------------------
 * 5. Start (only when run directly, so tests can require this file)
 * ------------------------------------------------------------------------ */

function banner() {
    const keyState = process.env.GROQ_API_KEY
        ? "found (" + String(process.env.GROQ_API_KEY).slice(0, 7) + "…)"
        : "NOT SET — the game will fall back to the offline Lite DM";

    console.log("");
    console.log("  ┌────────────────────────────────────────────────┐");
    console.log("  │  ROGUE-TEXT — local dungeon                    │");
    console.log("  └────────────────────────────────────────────────┘");
    console.log("  URL       http://localhost:" + PORT);
    console.log("  Model     " + (process.env.GROQ_MODEL || "openai/gpt-oss-120b") +
        (process.env.GROQ_MODEL_FALLBACKS ? "  (fallbacks: " + process.env.GROQ_MODEL_FALLBACKS + ")" : ""));
    console.log("  Endpoint  " + (process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1"));
    console.log("  API key   " + keyState);
    console.log("  Env files " + (loadedEnvFiles.length ? loadedEnvFiles.join(", ") : "none found"));

    if (dmHandler) {
        console.log("  Handler   api/dm.js loaded and callable");
    } else {
        console.log("");
        console.log("  ┌─ ⚠  api/dm.js IS NOT CALLABLE ─────────────────────────┐");
        console.log("  │  " + String(dmProblem).slice(0, 54));
        console.log("  │  Shape: " + dmShape.slice(0, 46));
        console.log("  │");
        console.log("  │  The server is still running, so you can play via");
        console.log("  │  the Lite DM. Fix the handler, then restart.");
        console.log("  │");
        console.log("  │  Diagnose:");
        console.log("  │    node -e \"const m=require('./api/dm.js');");
        console.log("  │             console.log(typeof m, Object.keys(m))\"");
        console.log("  └────────────────────────────────────────────────────────┘");
    }

    console.log("");
    console.log("  Press Ctrl+C to stop.");
    console.log("");
}

if (require.main === module) {
    banner();
    createServer().listen(PORT, HOST);
}

/* Exported for the test suite. */
module.exports = {
    createServer: createServer,
    resolveHandler: resolveHandler,
    describeModule: describeModule
};