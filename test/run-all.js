/* ============================================================================
 * ROGUE-TEXT — tests/run-all.js
 * Runs every suite and prints one summary.
 *
 *   node tests/run-all.js
 *   npm test
 * ========================================================================== */

"use strict";

const { spawnSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const SUITES = [
    { file: "logic.test.js", name: "Game logic & reducer", needs: null },
    { file: "prompt.test.js", name: "Dungeon Master prompt", needs: null },
    { file: "proxy.test.js", name: "Serverless Groq proxy", needs: null },
    { file: "ui.test.js", name: "Full UI in a real DOM", needs: "jsdom", startServer: true },
    { file: "live.test.js", name: "Live DM end-to-end (mock Groq)", needs: "jsdom", startServer: false }
];

function hasModule(name) {
    try { require.resolve(name); return true; } catch (error) { return false; }
}

const results = [];
let server = null;

console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║  ROGUE-TEXT — test suite                                 ║");
console.log("╚══════════════════════════════════════════════════════════╝");

/* The UI suite talks to the real dev server, so bring one up first. */
if (fs.existsSync(path.join(__dirname, "..", "dev-server.js"))) {
    server = spawn(process.execPath, [path.join(__dirname, "..", "dev-server.js")], {
        cwd: path.join(__dirname, ".."),
        env: Object.assign({}, process.env, { PORT: "3000" }),
        stdio: "ignore"
    });
    const started = Date.now();
    while (Date.now() - started < 4000) {
        try {
            require("child_process").execSync("curl -s -o /dev/null http://localhost:3000/");
            break;
        } catch (error) {
            require("child_process").execSync("node -e \"setTimeout(()=>{},100)\"");
        }
    }
    console.log("\n  dev server: running on :3000");
}

function finish(code) {
    if (server) { try { server.kill(); } catch (error) { /* ignore */ } }
    process.exit(code);
}

SUITES.forEach(function (suite) {
    const filePath = path.join(__dirname, suite.file);

    if (!fs.existsSync(filePath)) {
        results.push({ name: suite.name, status: "missing" });
        return;
    }

    if (suite.needs && !hasModule(suite.needs)) {
        results.push({ name: suite.name, status: "skipped", note: "npm install " + suite.needs });
        return;
    }

    console.log("\n── " + suite.name + " " + "─".repeat(Math.max(0, 52 - suite.name.length)));
    const run = spawnSync(process.execPath, [filePath], { cwd: path.join(__dirname, ".."), stdio: "inherit" });

    results.push({ name: suite.name, status: run.status === 0 ? "passed" : "FAILED", code: run.status });
});

console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║  SUMMARY                                                 ║");
console.log("╚══════════════════════════════════════════════════════════╝");
results.forEach(function (result) {
    const icon = result.status === "passed" ? "✓" : result.status === "skipped" ? "○" : "✗";
    const note = result.note ? "  (" + result.note + ")" : "";
    console.log("  " + icon + " " + result.name.padEnd(28) + result.status.toUpperCase() + note);
});

const failed = results.filter(function (result) { return result.status === "FAILED"; }).length;
console.log(failed ? "\n❌ " + failed + " suite(s) failed.\n" : "\n✅ All suites passed.\n");
finish(failed ? 1 : 0);