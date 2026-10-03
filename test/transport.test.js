/* ============================================================================
 * ROGUE-TEXT — tests/transport.test.js
 * Verifies the transport adapter embedded in index.html: the fix for the whole
 * "CORS / Failed to fetch / non-JSON from a static host" family of errors.
 *
 * The adapter is extracted from index.html and exercised in jsdom with a stubbed
 * fetch, so these are real behavioural tests of shipped code.
 *
 *   node tests/transport.test.js
 * ========================================================================== */

"use strict";

const fs = require("fs");
const path = require("path");

let JSDOM = null;
try {
    JSDOM = require("jsdom").JSDOM;
} catch (error) {
    console.log("\n  \u25cb SKIPPED: transport adapter tests need jsdom (npm install)\n");
    process.exit(0);
}

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

let fails = 0;
const ok = (condition, name, extra) => {
    if (!condition) { fails++; console.log("  \u2717 FAIL:", name, extra ?? ""); }
    else console.log("  \u2713", name);
};

/* Pull the adapter source out of index.html so we test the real thing. */
const adapterMatch = html.match(/window\.ROGUE_TEXT_CONFIG[\s\S]*?<\/script>/);
if (!adapterMatch) {
    console.log("  \u2717 FAIL: could not find the transport adapter in index.html");
    process.exit(1);
}
const adapterSource = adapterMatch[0].replace(/<\/script>$/, "");

const BANNER_HTML = `
    <div id="transport-warning" hidden>
        <strong id="transport-warning-title"></strong>
        <span id="transport-warning-body"></span>
        <button id="transport-warning-close"></button>
    </div>`;

function makeDom(options) {
    const opts = options || {};
    const dom = new JSDOM("<!DOCTYPE html><html><head></head><body>" + BANNER_HTML + "</body></html>", {
        url: opts.url || "http://localhost:3000/",
        runScripts: "outside-only",
        pretendToBeVisual: false
    });
    const { window } = dom;

    /* Stub fetch BEFORE the adapter captures it. */
    window.__calls = [];
    window.fetch = function (input, init) {
        window.__calls.push(typeof input === "string" ? input : String(input && input.url));
        if (opts.fetch) return opts.fetch(input, init);
        return Promise.resolve({ ok: true, status: 200,
            headers: { get: () => "application/json" }, json: async () => ({ ok: true }) });
    };

    window.eval(adapterSource);
    /* Fire DOMContentLoaded so the adapter's listeners run. */
    window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
    return dom;
}

const tick = () => new Promise(r => setTimeout(r, 20));

(async () => {
    console.log("\n=== A. The adapter installs and defaults to same-origin ===");
    let dom = makeDom();
    ok(typeof dom.window.ROGUE_TEXT_CONFIG === "object", "window.ROGUE_TEXT_CONFIG is defined");
    ok(dom.window.ROGUE_TEXT_CONFIG.dmEndpoint === "", "dmEndpoint defaults to empty (same origin)");
    ok(typeof dom.window.__rogueTextShowWarning === "function", "warning helper is exposed for app.js/debugging");

    await dom.window.fetch("/api/dm", { method: "POST" });
    ok(dom.window.__calls[0] === "/api/dm", "same-origin calls are passed through untouched (" + dom.window.__calls[0] + ")");
    dom.window.close();

    console.log("\n=== B. file:// is detected and explained, not silently broken ===");
    dom = makeDom({ url: "file:///Users/you/Desktop/rogue-text/index.html" });
    const banner = dom.window.document.getElementById("transport-warning");
    ok(banner.hidden === false, "warning banner becomes visible on file://");
    ok(/opened this file directly/i.test(dom.window.document.getElementById("transport-warning-title").textContent),
        "banner title states the actual problem");
    ok(/dev-server\.js/.test(dom.window.document.getElementById("transport-warning-body").textContent),
        "banner names the exact command to run (node dev-server.js)");
    ok(/localhost:3000/.test(dom.window.document.getElementById("transport-warning-body").textContent),
        "banner names the URL to use instead");

    let caught = null;
    try {
        await dom.window.fetch("/api/dm", { method: "POST" });
    } catch (error) {
        caught = error;
    }
    ok(caught === null, "a successful stubbed fetch is not interfered with");

    dom.window.close();

    console.log("\n=== C. Network failure produces an actionable sentence ===");
    dom = makeDom({ fetch: () => Promise.reject(new TypeError("Failed to fetch")) });
    caught = null;
    try { await dom.window.fetch("/api/dm", { method: "POST" }); } catch (e) { caught = e; }
    ok(caught !== null, "the failure still rejects (app.js can catch it)");
    ok(/cannot reach \/api\/dm/.test(caught.message), "message starts with what broke");
    ok(/api\/ folder deployed|serverless function did not answer/.test(caught.message),
        "message names the likely cause: \"" + caught.message.slice(0, 96) + "\"");
    dom.window.close();

    console.log("\n=== D. A static host answering with HTML is named explicitly ===");
    dom = makeDom({ fetch: () => Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => "text/html; charset=utf-8" },
        json: async () => { throw new SyntaxError("Unexpected token '<'"); }
    }) });
    caught = null;
    try { await dom.window.fetch("/api/dm", { method: "POST" }); } catch (e) { caught = e; }
    ok(caught !== null, "HTML-instead-of-JSON rejects");
    ok(/instead of JSON/.test(caught.message), "message explains the content-type mismatch");
    ok(/not deployed on this host/.test(caught.message), "message says the function is missing here");
    ok(!/Unexpected token/.test(caught.message), "the raw JSON parse error is replaced by a useful one");
    dom.window.close();

    console.log("\n=== E. Split-origin deployment rewrites the URL and explains CORS ===");
    dom = makeDom({ url: "https://ajxrhaider.github.io/" });
    dom.window.ROGUE_TEXT_CONFIG.dmEndpoint = "https://rogue-text.vercel.app";
    dom.window.close();

    /* Rebuild with the config set before the adapter evaluates. */
    const dom2 = new JSDOM("<!DOCTYPE html><html><head></head><body>" + BANNER_HTML + "</body></html>", {
        url: "https://ajxrhaider.github.io/", runScripts: "outside-only"
    });
    dom2.window.__calls = [];
    dom2.window.fetch = function (input) {
        dom2.window.__calls.push(String(input));
        return Promise.reject(new TypeError("Failed to fetch"));
    };
    dom2.window.eval("window.ROGUE_TEXT_CONFIG = { dmEndpoint: 'https://rogue-text.vercel.app/' };\n" + adapterSource);
    dom2.window.document.dispatchEvent(new dom2.window.Event("DOMContentLoaded", { bubbles: true }));

    caught = null;
    try { await dom2.window.fetch("/api/dm", { method: "POST" }); } catch (e) { caught = e; }
    ok(dom2.window.__calls[0] === "https://rogue-text.vercel.app/api/dm",
        "trailing slash handled and URL rewritten (" + dom2.window.__calls[0] + ")");
    ok(/ALLOWED_ORIGINS/.test(caught.message), "CORS failure message names the env var to fix");
    ok(/github\.io/.test(caught.message), "message names the origin that must be allowlisted");
    dom2.window.close();

    console.log("\n=== F. The adapter never touches unrelated fetches ===");
    dom = makeDom();
    await dom.window.fetch("/some/other/endpoint");
    await dom.window.fetch("https://api.example.com/thing");
    ok(dom.window.__calls.length === 2, "non-/api/dm calls pass straight through (" + dom.window.__calls.length + ")");
    ok(dom.window.__calls[1] === "https://api.example.com/thing", "absolute third-party URLs untouched");
    dom.window.close();

    console.log("\n=== G. The DOM contract app.js depends on is intact ===");
    const appJs = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
    const present = new Set((html.match(/id="([^"]+)"/g) || []).map(m => m.slice(4, -1)));
    const wanted = new Set((appJs.match(/getElementById\("([^"]+)"\)/g) || []).map(m => m.slice(16, -2)));
    const missing = [...wanted].filter(id => !present.has(id));
    ok(missing.length === 0, "all " + wanted.size + " ids app.js caches exist in index.html", missing.join(", "));
    ok(/REQUIRED DOM CONTRACT/.test(html), "the contract is documented in index.html for future edits");

    console.log(fails === 0 ? "\n\u2705 ALL TRANSPORT TESTS PASSED" : `\n\u274c ${fails} FAILURES`);
    process.exit(fails ? 1 : 0);
})().catch(error => { console.error("HARNESS CRASH:", error); process.exit(1); });
