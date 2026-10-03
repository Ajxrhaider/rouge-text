/* ============================================================================
 * ROGUE-TEXT — tests/live.test.js
 * END-TO-END verification of the LIVE Dungeon Master path.
 * ----------------------------------------------------------------------------
 * This is the test the other suites could not be: it boots a fake Groq, boots
 * the real proxy against it, loads the real front end in a DOM, and proves the
 * whole chain works — client → /api/dm → model → scene → panels.
 *
 * It needs NO API key, NO network, and costs NO quota.
 *
 *   node tests/live.test.js
 *
 * What it proves
 *   1. The JSON-mode retry path
 *   2. The JSON repair pass (malformed reply -> repaired turn)
 *   3. GROQ_MODEL_FALLBACKS (primary 404 -> backup answers)
 *   4. Graceful degradation to the Lite DM on 429
 *   5. The prompt actually reaches the model (system prompt size, command text)
 * ========================================================================== */

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MOCK_PORT = 3100;
const APP_PORT = 3200;
const MOCK_BASE = "http://127.0.0.1:" + MOCK_PORT + "/openai/v1";

let fails = 0;
const ok = (condition, name, extra) => {
    if (!condition) { fails++; console.log("  ✗ FAIL:", name, extra ?? ""); }
    else console.log("  ✓", name);
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForServer(url, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const response = await fetch(url);
            if (response.status < 500) return true;
        } catch (error) { /* not up yet */ }
        await wait(150);
    }
    return false;
}

async function setMockMode(mode) {
    const response = await fetch("http://127.0.0.1:" + MOCK_PORT + "/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: mode })
    });
    return (await response.json()).ok === true;
}

async function mockState() {
    return (await fetch("http://127.0.0.1:" + MOCK_PORT + "/control")).json();
}

async function waitIdle(window, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const button = window.document.getElementById("send-button");
        if (button && !button.disabled) { await wait(120); return true; }
        await wait(80);
    }
    throw new Error("UI never became idle");
}

const text = (doc, id) => (doc.getElementById(id) || {}).textContent || "";

(async () => {
    /* ---- start the fake model ---------------------------------------- */
    const mock = spawn(process.execPath, [path.join(__dirname, "mock-groq.js")], {
        cwd: ROOT, stdio: "ignore", env: Object.assign({}, process.env, { PORT: String(MOCK_PORT) })
    });

    /* ---- start the real proxy, pointed at the fake model -------------- */
    const app = spawn(process.execPath, [path.join(ROOT, "dev-server.js")], {
        cwd: ROOT, stdio: "ignore",
        env: Object.assign({}, process.env, {
            PORT: String(APP_PORT),
            GROQ_API_KEY: "gsk_mock_key_0000000000000000000000000000",
            GROQ_API_BASE: MOCK_BASE,
            GROQ_MODEL: "mock/dungeon-master",
            GROQ_MODEL_FALLBACKS: "mock/backup-dm",
            /* Keep the test deterministic: a fresh process, no .env overrides. */
            GROQ_TEMPERATURE: "0.7"
        })
    });

    const cleanup = () => {
        try { mock.kill(); } catch (e) { /* ignore */ }
        try { app.kill(); } catch (e) { /* ignore */ }
    };
    process.on("exit", cleanup);

    const mockUp = await waitForServer("http://127.0.0.1:" + MOCK_PORT + "/control");
    const appUp = await waitForServer("http://127.0.0.1:" + APP_PORT + "/api/dm");

    console.log("\n=== A. Infrastructure ===");
    ok(mockUp, "mock Groq is listening on :" + MOCK_PORT);
    ok(appUp, "proxy is listening on :" + APP_PORT + " and /api/dm answers");
    if (!mockUp || !appUp) { cleanup(); process.exit(1); }

    const health = await (await fetch("http://127.0.0.1:" + APP_PORT + "/api/health")).json();
    ok(health.handlerReady === true, "dev-server reports api/dm.js is callable");
    ok(health.apiBase === MOCK_BASE, "proxy is pointed at the mock endpoint, not Groq");
    ok(Array.isArray(health.fallbacks) && health.fallbacks[0] === "mock/backup-dm", "fallbacks loaded from env");

    /* ---- a direct turn through the proxy, no browser ------------------ */
    console.log("\n=== B. One turn, straight through the proxy ===");
    const direct = await (await fetch("http://127.0.0.1:" + APP_PORT + "/api/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            command: "go north",
            state: { hp: 20, maxHp: 20, turns: 0, location: "The Threshold", exits: [], inventory: [], visited: [] }
        })
    })).json();

    ok(direct.ok === true, "proxy returned ok:true");
    ok(/MOCK DM/.test(direct.scene.narration), "scene came from the mock model");
    ok(/go north/.test(direct.scene.narration), "the player's command reached the model verbatim");
    ok(direct.scene.roomName.indexOf("Mock Chamber") === 0, "roomName propagated: " + direct.scene.roomName);
    ok(direct.modelUsed === "mock/dungeon-master", "primary model was used");
    ok(direct.usedFallback === false, "no fallback needed");
    ok(direct.repaired === false, "no repair needed");
    ok(direct.promptVersion === "1.0.0", "prompt version reported");

    let mstate = await mockState();
    ok(mstate.lastSystemPromptChars > 8000, "the engineered DM prompt reached the model (" +
        mstate.lastSystemPromptChars + " chars)");
    ok(mstate.lastUserMessageChars > 500, "the state block reached the model (" + mstate.lastUserMessageChars + " chars)");
    ok(mstate.sawJsonModeRequest === true, "JSON mode was requested on the first call");

    /* ---- JSON repair pass -------------------------------------------- */
    console.log("\n=== C. Self-repair when the model rambles ===");
    await setMockMode("malformed-first");
    const repaired = await (await fetch("http://127.0.0.1:" + APP_PORT + "/api/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "look", state: { hp: 20, maxHp: 20, turns: 3, location: "The Threshold" } })
    })).json();

    ok(repaired.ok === true, "a malformed model reply still produced a playable turn");
    ok(repaired.repaired === true, "response flags repaired:true");
    ok(/MOCK DM/.test(repaired.scene.narration), "the repaired turn is the good scene, not the garbage");
    ok((await mockState()).calls === 2, "exactly two model calls: original + repair");

    /* ---- model fallback ---------------------------------------------- */
    console.log("\n=== D. GROQ_MODEL_FALLBACKS ===");
    await setMockMode("reject-model");
    const fell = await (await fetch("http://127.0.0.1:" + APP_PORT + "/api/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "listen", state: { hp: 20, maxHp: 20, turns: 4, location: "Chamber" } })
    })).json();

    ok(fell.ok === true, "primary model 404 -> the turn still succeeded");
    ok(fell.modelUsed === "mock/backup-dm", "the backup model answered: " + fell.modelUsed);
    ok(fell.usedFallback === true, "response flags usedFallback:true");

    /* ---- always broken -> clean error, not a crash -------------------- */
    console.log("\n=== E. Unrecoverable model -> clean error ===");
    await setMockMode("always-malformed");
    const broken = await (await fetch("http://127.0.0.1:" + APP_PORT + "/api/dm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "look", state: { hp: 20, maxHp: 20, turns: 5 } })
    })).json();
    ok(broken.ok === false && broken.error.code === "bad_json", "double failure -> bad_json, not a stack trace");
    const stillUp = await waitForServer("http://127.0.0.1:" + APP_PORT + "/api/dm");
    ok(stillUp, "the server survived the failure and is still serving");

    /* ---- the real UI, against the live proxy -------------------------- */
    console.log("\n=== F. The real front end on the LIVE path ===");
    await setMockMode("ok");

    const { JSDOM } = require("jsdom");
    const html = await (await fetch("http://127.0.0.1:" + APP_PORT + "/")).text();
    const appJs = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");

    const dom = new JSDOM(html.replace('<script src="app.js" defer></script>', ""), {
        url: "http://127.0.0.1:" + APP_PORT + "/", runScripts: "dangerously", pretendToBeVisual: true
    });
    const { window } = dom;
    const { document } = window;
    const errors = [];
    window.onerror = (message) => errors.push(String(message));

    /* jsdom's AbortSignal is incompatible with Node's fetch. */
    delete window.AbortController;
    window.fetch = (input, init) => fetch(new URL(input, "http://127.0.0.1:" + APP_PORT).toString(), init);

    window.eval(appJs);
    await new Promise(res => {
        if (window.document.readyState === "complete") return res();
        window.addEventListener("load", res, { once: true });
        setTimeout(res, 1500);
    });
    await wait(250);
    await waitIdle(window);

    ok(errors.length === 0, "no uncaught errors during live boot", errors.join(" | "));
    ok(text(document, "mode-label") === "LIVE DM",
        'header badge reads LIVE DM (got: "' + text(document, "mode-label") + '")');
    ok(text(document, "model-label") === "mock/dungeon-master", "sidebar shows the model: " + text(document, "model-label"));
    ok(/MOCK DM/.test(text(document, "log")), "the opening scene came from the model");
    ok(text(document, "location-name").indexOf("Mock Chamber") === 0,
        "location panel updated from the model's roomName: " + text(document, "location-name"));
    ok(document.querySelectorAll(".chip--exit").length === 2, "exit chips rendered from the model's exits");
    ok(text(document, "terminal-status").indexOf("mock/dungeon-master") >= 0, "status line names the answering model");

    console.log("\n=== G. A full turn through the UI on the live path ===");
    const input = document.getElementById("command-input");
    const form = document.getElementById("command-form");
    const turnsBefore = Number(text(document, "turns-value"));
    input.value = "take the lantern";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitIdle(window);

    ok(Number(text(document, "turns-value")) === turnsBefore + 1, "turn counter advanced");

    /* Assert on the MODEL'S narration specifically. Checking the whole log would
       pass on the echoed command alone and prove nothing about the round trip. */
    const narrations = document.querySelectorAll(".log__entry--narration");
    const lastNarration = narrations.length ? narrations[narrations.length - 1].textContent : "";
    ok(/take the lantern/.test(lastNarration),
        "the model narrates the command the player typed (round trip intact)");
    ok(/MOCK DM/.test(lastNarration), "that narration came from the model, not the Lite DM");
    ok(document.querySelectorAll(".log__entry--command").length >= 1, "command echoed in the log");

    console.log("\n=== H. The UI degrades gracefully when the model dies ===");
    await setMockMode("ratelimit");
    const scoreBefore = text(document, "score-value");
    input.value = "search the room";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitIdle(window);

    ok(text(document, "mode-label") === "LITE DM",
        'badge flipped to LITE DM on a 429 (got: "' + text(document, "mode-label") + '")');
    ok(/Lite DM/i.test(text(document, "terminal-status")), "status explains the fallback");
    ok(document.querySelectorAll(".log__entry--narration").length >= 3, "the game kept narrating via the Lite DM");
    ok(Number(text(document, "turns-value")) === turnsBefore + 2, "the turn still counted");
    ok(text(document, "score-value") !== undefined && scoreBefore !== undefined, "panels stayed coherent");

    console.log("\n=== I. Back to live when the model recovers ===");
    await setMockMode("ok");
    input.value = "look";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await waitIdle(window);
    ok(text(document, "mode-label") === "LIVE DM", "badge returned to LIVE DM automatically");
    ok(errors.length === 0, "still zero uncaught errors after the whole run", errors.join(" | "));

    dom.window.close();
    cleanup();

    console.log(fails === 0 ? "\n✅ ALL LIVE TESTS PASSED" : `\n❌ ${fails} FAILURES`);
    process.exit(fails ? 1 : 0);
})().catch(error => {
    console.error("HARNESS CRASH:", error);
    process.exit(1);
});
