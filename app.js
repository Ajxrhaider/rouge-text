/* ============================================================================
 * ROGUE-TEXT — app.js
 * Hizaki Labs | A Groq-powered Zork-style text adventure
 * ----------------------------------------------------------------------------
 * ARCHITECTURE
 *   This file is a plain browser script — no modules, no build step, no
 *   dependencies. It is split in two halves:
 *
 *     PART A — PURE LOGIC (no DOM access)
 *       state factory, scene contract, reducer, offline "Lite DM".
 *       Safe to `require()` in Node for testing (see the export block at the
 *       bottom). This is what makes Step 4's smoke tests possible.
 *
 *     PART B — UI LAYER (all DOM access lives here)
 *       Cache elements, render panels, typewriter effect, toasts, transport.
 *       Boots only when a document exists.
 *
 * SECURITY
 *   There is NO API key in this file, by design. All model traffic goes through
 *   POST /api/dm — a same-origin serverless function that holds GROQ_API_KEY in
 *   an environment variable. Same origin also means no CORS preflight, so the
 *   classic "blocked by CORS policy" failure cannot happen here.
 *
 * RESILIENCE
 *   If the live Dungeon Master is unreachable (no key, quota, offline, opened
 *   from file://), the client transparently falls back to the Lite DM — a local
 *   procedural narrator with the same response contract. The game never dies.
 *   The header badge tells you which brain you are talking to.
 * ========================================================================== */

"use strict";

/* ============================================================================
 * 00. CONFIGURATION
 * ========================================================================== */

const CONFIG = {
    /** Same-origin serverless endpoint. Never call api.groq.com from the browser. */
    DM_ENDPOINT: "/api/dm",

    /** Shown in the UI; the real model ID is owned by the proxy's GROQ_MODEL env var. */
    DEFAULT_MODEL_LABEL: "openai/gpt-oss-120b",

    /** Give up on a request after this long and engage the Lite DM. */
    REQUEST_TIMEOUT_MS: 30000,

    /** Turns of conversation sent back to the model as context. */
    MAX_HISTORY_TURNS: 8,

    /** Characters kept per transcript entry in the outbound history. */
    MAX_HISTORY_CHARS: 600,

    /** Local autosave. */
    SAVE_KEY: "rogue-text:save:v1",
    MAX_TRANSCRIPT: 140,

    /** Typewriter pacing (characters per tick, ms per tick). */
    TYPE_CHARS_PER_TICK: 3,
    TYPE_TICK_MS: 16,

    /** Starting stats. */
    START_HP: 20
};

/** Canonical movement words, used for validation and quick UI affordances. */
const DIRECTIONS = ["north", "south", "east", "west", "up", "down", "in", "out"];

/** Words that imply a weapon is being used, for the Lite DM's damage math. */
const WEAPON_HINTS = /sword|axe|blade|dagger|knife|mace|club|spear|staff|hammer|wrench|pipe|scythe|bow|crossbow|trident|cleaver/i;

/** Words that imply light, used by the Lite DM's darkness flavour. */
const LIGHT_HINTS = /lantern|torch|light|candle|lamp|glowstone|flint/i;


/* ============================================================================
 * 01. SMALL UTILITIES
 * ========================================================================== */

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

function pickMany(list, count) {
    const pool = list.slice();
    const out = [];
    while (pool.length && out.length < count) {
        out.push(pool.splice(randInt(0, pool.length - 1), 1)[0]);
    }
    return out;
}

/** Trim to a safe, model-friendly string. */
function safeString(value, maxLength) {
    if (value === null || value === undefined) return "";
    const str = typeof value === "string" ? value : String(value);
    const limit = maxLength || 4000;
    return str.length > limit ? str.slice(0, limit).trim() + "\u2026" : str.trim();
}

/**
 * NaN-safe number coercion. Critically, 0 is a REAL value: `Number(x) || fallback`
 * would turn an enemy at 0 HP into a full-health enemy and resurrect it.
 */
function toFiniteNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The enemy's damage rating. The live DM may or may not send an `attack` field,
 * so we derive a sane one from its toughness when it is missing. Returning a
 * finite number here is critical: an `undefined` would silently become NaN and
 * erase all incoming damage.
 */
function enemyAttackRating(enemy) {
    const explicit = Number(enemy && enemy.attack);
    if (Number.isFinite(explicit) && explicit > 0) {
        return clamp(Math.round(explicit), 1, 8);
    }
    const maxHp = Number(enemy && enemy.maxHp) || 6;
    return clamp(Math.ceil(maxHp / 2), 1, 6);
}

function titleCase(value) {
    return String(value || "")
        .split(/\s+/)
        .map(function (word) {
            return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
        })
        .join(" ");
}


/* ============================================================================
 * 02. STATE
 * ========================================================================== */

/**
 * A fresh adventurer.
 * @returns {object} game state
 */
function initialState() {
    return {
        hp: CONFIG.START_HP,
        maxHp: CONFIG.START_HP,
        score: 0,
        turns: 0,
        location: "The Threshold",
        exits: [],
        inventory: [],      // array of item names
        items: [],          // array of { name, description } — parallel to inventory
        visited: [],
        enemy: null,        // { name, hp, maxHp, description } | null
        status: "playing",  // playing | dead | victory
        mode: "live",       // live | lite  (which narrator answered last)
        model: CONFIG.DEFAULT_MODEL_LABEL,
        history: [],        // [{ role, content }] — outbound model context
        transcript: []      // [{ kind, text }] — for restoring the visible log
    };
}

/**
 * Compact the state we send to the model. Small payloads = fast, cheap turns.
 */
function serializeState(state) {
    return {
        hp: state.hp,
        maxHp: state.maxHp,
        score: state.score,
        turns: state.turns,
        location: state.location,
        exits: state.exits.slice(0, 8),
        inventory: state.inventory.slice(0, 20),
        visited: state.visited.slice(-12),
        enemy: state.enemy
            ? {
                name: state.enemy.name,
                hp: state.enemy.hp,
                maxHp: state.enemy.maxHp,
                attack: enemyAttackRating(state.enemy)
            }
            : null,
        status: state.status
    };
}


/* ============================================================================
 * 03. THE SCENE CONTRACT
 * ----------------------------------------------------------------------------
 * The Dungeon Master must answer with a strict JSON object. Every field is
 * optional in practice — sanitizeScene() repairs anything missing or malformed,
 * so a creatively broken model reply degrades instead of crashing the runtime.
 *
 * {
 *   narration:     string,                     // the prose the player reads
 *   roomName:      string,                     // current room after this turn
 *   exits:         string[],                   // valid directions from here
 *   hpDelta:       number,                     // negative = damage taken
 *   scoreDelta:    number,                     // points earned this turn
 *   itemsFound:    [{ name, description }],    // loot that lands in inventory
 *   itemsLost:     string[],                   // item names removed
 *   enemy:         { name, hp, maxHp, description } | null,
 *   enemyDefeated: boolean,
 *   status:        "playing" | "dead" | "victory",
 *   hint:          string | null               // suggested next command
 * }
 * ========================================================================== */

function sanitizeScene(raw) {
    const source = isPlainObject(raw) ? raw : {};

    const narration = safeString(source.narration, 4000) ||
        "The Dungeon Master says nothing. The silence is somehow worse than an answer.";

    const roomName = safeString(source.roomName, 120) || "";

    const exits = Array.isArray(source.exits)
        ? source.exits
            .map(function (direction) { return safeString(direction, 24).toLowerCase(); })
            .filter(function (direction, index, all) {
                return direction && all.indexOf(direction) === index;
            })
            .slice(0, 6)
        : [];

    const hpDelta = clamp(Number(source.hpDelta) || 0, -25, 25);
    const scoreDelta = clamp(Number(source.scoreDelta) || 0, -100, 500);

    const itemsFound = Array.isArray(source.itemsFound)
        ? source.itemsFound
            .map(function (item) {
                if (typeof item === "string") {
                    return { name: safeString(item, 80), description: "" };
                }
                if (isPlainObject(item)) {
                    return {
                        name: safeString(item.name, 80),
                        description: safeString(item.description, 200)
                    };
                }
                return null;
            })
            .filter(function (item) { return item && item.name; })
            .slice(0, 6)
        : [];

    const itemsLost = Array.isArray(source.itemsLost)
        ? source.itemsLost
            .map(function (name) { return safeString(name, 80); })
            .filter(Boolean)
            .slice(0, 6)
        : [];

    let enemy = null;
    if (isPlainObject(source.enemy) && safeString(source.enemy.name, 80)) {
        const rawHp = toFiniteNumber(source.enemy.hp, NaN);
        const rawMaxHp = toFiniteNumber(source.enemy.maxHp, NaN);
        const maxHp = clamp(Math.round(
            rawMaxHp > 0 ? rawMaxHp : (rawHp > 0 ? rawHp : 6)
        ), 1, 999);
        const hp = clamp(Math.round(Number.isFinite(rawHp) ? rawHp : maxHp), 0, maxHp);

        if (hp <= 0) {
            /* The DM reported a dead creature. Do not resurrect it. */
            enemy = null;
        } else {
            enemy = {
                name: safeString(source.enemy.name, 80),
                maxHp: maxHp,
                hp: hp,
                description: safeString(source.enemy.description, 240),
                attack: enemyAttackRating({ attack: source.enemy.attack, maxHp: maxHp })
            };
        }
    }

    const rawStatus = safeString(source.status, 16).toLowerCase();
    const status = ["playing", "dead", "victory"].indexOf(rawStatus) >= 0 ? rawStatus : "playing";

    return {
        narration: narration,
        roomName: roomName,
        exits: exits,
        hpDelta: hpDelta,
        scoreDelta: scoreDelta,
        itemsFound: itemsFound,
        itemsLost: itemsLost,
        enemy: enemy,
        enemyDefeated: source.enemyDefeated === true ||
            (isPlainObject(source.enemy) && !enemy && toFiniteNumber(source.enemy.hp, 1) <= 0),
        status: status,
        hint: source.hint ? safeString(source.hint, 120) : null
    };
}

/**
 * Apply a sanitized scene to the state. This function owns the truth: the model
 * only *proposes* deltas, the runtime *decides* what sticks.
 *
 * @returns {{ state: object, events: Array<{type: string, [k: string]: any}> }}
 */
function applyScene(state, scene, command) {
    const next = Object.assign({}, state, {
        inventory: state.inventory.slice(),
        items: state.items.slice(),
        visited: state.visited.slice(),
        exits: state.exits.slice(),
        history: state.history.slice(),
        transcript: state.transcript.slice()
    });

    const events = [];
    const isOpening = next.turns === 0;
    const previousEnemy = next.enemy;

    next.turns += 1;

    /* ---- health ---- */
    if (scene.hpDelta > 0) {
        const before = next.hp;
        next.hp = clamp(next.hp + scene.hpDelta, 0, next.maxHp);
        if (next.hp > before) {
            events.push({ type: "heal", amount: next.hp - before, hp: next.hp, maxHp: next.maxHp });
        }
    } else if (scene.hpDelta < 0) {
        const before = next.hp;
        next.hp = clamp(next.hp + scene.hpDelta, 0, next.maxHp);
        if (next.hp < before) {
            events.push({ type: "damage", amount: before - next.hp, hp: next.hp, maxHp: next.maxHp });
        }
    }

    /* ---- score ---- */
    if (scene.scoreDelta !== 0) {
        next.score = Math.max(0, next.score + scene.scoreDelta);
        events.push({ type: "score", amount: scene.scoreDelta });
    }

    /* ---- loot in ---- */
    scene.itemsFound.forEach(function (item) {
        const exists = next.inventory.some(function (name) {
            return name.toLowerCase() === item.name.toLowerCase();
        });
        if (!exists) {
            next.inventory.push(item.name);
            next.items.push({ name: item.name, description: item.description || "" });
            events.push({ type: "loot", name: item.name, description: item.description || "" });
        }
    });

    /* ---- loot out ---- */
    scene.itemsLost.forEach(function (name) {
        const index = next.inventory.findIndex(function (owned) {
            return owned.toLowerCase() === name.toLowerCase();
        });
        if (index >= 0) {
            const removed = next.inventory.splice(index, 1)[0];
            next.items = next.items.filter(function (item) {
                return item.name.toLowerCase() !== removed.toLowerCase();
            });
            events.push({ type: "lost", name: removed });
        }
    });

    /* ---- enemy lifecycle ---- */
    if (previousEnemy && !scene.enemy) {
        if (scene.enemyDefeated || previousEnemy.hp <= 0) {
            next.score += 25;
            events.push({ type: "defeat", name: previousEnemy.name, bonus: 25 });
        } else {
            events.push({ type: "evade", name: previousEnemy.name });
        }
    } else if (!previousEnemy && scene.enemy) {
        events.push({ type: "encounter", name: scene.enemy.name });
    } else if (previousEnemy && scene.enemy && previousEnemy.name.toLowerCase() !== scene.enemy.name.toLowerCase()) {
        events.push({ type: "encounter", name: scene.enemy.name });
    }
    next.enemy = scene.enemy;

    /* ---- movement ---- */
    if (scene.roomName && scene.roomName !== next.location) {
        if (!isOpening) {
            next.visited.push(next.location);
            events.push({ type: "move", to: scene.roomName });
        }
        next.location = scene.roomName;
    }

    if (scene.exits.length) {
        next.exits = scene.exits;
    }

    /* ---- run status ---- */
    if (next.hp <= 0) {
        next.status = "dead";
        events.push({ type: "death", score: next.score, turns: next.turns });
    } else if (scene.status === "victory") {
        next.status = "victory";
        events.push({ type: "victory", score: next.score, turns: next.turns });
    } else {
        next.status = "playing";
    }

    /* ---- model context ---- */
    next.history.push({ role: "user", content: safeString(command, 300) });
    next.history.push({
        role: "assistant",
        content: JSON.stringify({
            narration: safeString(scene.narration, CONFIG.MAX_HISTORY_CHARS),
            roomName: scene.roomName,
            exits: scene.exits,
            enemy: scene.enemy ? { name: scene.enemy.name, hp: scene.enemy.hp } : null
        })
    });
    if (next.history.length > CONFIG.MAX_HISTORY_TURNS * 2) {
        next.history = next.history.slice(-CONFIG.MAX_HISTORY_TURNS * 2);
    }

    return { state: next, events: events };
}

/**
 * Turn mechanical events into player-readable system lines.
 * @returns {Array<{kind: string, text: string}>}
 */
function describeEvents(events, scene) {
    const lines = [];

    events.forEach(function (event) {
        switch (event.type) {
            case "damage":
                lines.push({
                    kind: "harm",
                    text: "You take " + event.amount + " damage. (" + event.hp + "/" + event.maxHp + " health remaining.)"
                });
                break;
            case "heal":
                lines.push({
                    kind: "heal",
                    text: "You recover " + event.amount + " health. (" + event.hp + "/" + event.maxHp + " health remaining.)"
                });
                break;
            case "loot":
                lines.push({
                    kind: "loot",
                    text: "Taken: " + event.name + (event.description ? " \u2014 " + event.description : "")
                });
                break;
            case "lost":
                lines.push({ kind: "system", text: "Lost from your pack: " + event.name + "." });
                break;
            case "score":
                lines.push({
                    kind: "score",
                    text: (event.amount > 0 ? "+" : "") + event.amount + " points."
                });
                break;
            case "defeat":
                lines.push({
                    kind: "loot",
                    text: "The " + event.name + " is destroyed. +" + event.bonus + " bonus points."
                });
                break;
            case "evade":
                lines.push({ kind: "system", text: "You leave the " + event.name + " behind." });
                break;
            case "encounter":
                lines.shift();
                lines.push({ kind: "harm", text: "Something hostile is here: " + event.name + "." });
                break;
            case "move":
                lines.push({ kind: "system", text: "Now in: " + event.to + "." });
                break;
            case "victory":
                lines.push({
                    kind: "victory",
                    text: "You have conquered the dungeon. Final score: " + event.score + " in " + event.turns + " turns."
                });
                break;
            case "death":
                lines.push({
                    kind: "death",
                    text: "You die in the dark. Final score: " + event.score + " after " + event.turns + " turns."
                });
                break;
            default:
                break;
        }
    });

    return lines;
}


/* ============================================================================
 * 04. LITE DM — the offline fallback narrator
 * ----------------------------------------------------------------------------
 * Not a stub, not an apology screen: a small procedural DM with the same
 * response contract. It makes the game fully playable with zero API access,
 * which is exactly what you want when Groq is rate-limited mid-stream, the key
 * is wrong, or the page is opened from file:// during development.
 * ========================================================================== */

const LITE = {
    rooms: [
        { name: "Dust-Choked Antechamber", desc: "Grit hangs in the air like suspended ash. A collapsed arch yawns to one side, and someone has scratched three tally marks into the stone — then stopped." },
        { name: "The Weeping Cistern", desc: "Water beads down the walls and gathers in a black pool. Something metallic glints beneath the surface, exactly far enough away to be annoying." },
        { name: "Hall of Small Statues", desc: "A dozen stone figures stand in a ring, all facing inward, all missing their hands. The floor between them is scuffed with drag marks." },
        { name: "The Long Gallery", desc: "Portraits of people long dead line the walls. Every one of them has been painted with their eyes open, and every pair of eyes follows you." },
        { name: "Collapsed Scriptorium", desc: "Shelves have rotted into a damp paste. Scrolls lie shredded like confetti, save for one wax-sealed cylinder that looks suspiciously untouched." },
        { name: "Fungal Stair", desc: "Wide steps spiral down into grey, luminous growth. The mushrooms breathe in slow unison, which is not a thing mushrooms should do." },
        { name: "The Ossuary", desc: "Femurs are stacked into neat walls, and a chandelier of skulls hangs from the ceiling on rusted chain. It is, objectively, well organised." },
        { name: "Iron Chapel", desc: "A rusted grate separates you from a small altar. Wax has pooled and hardened into a pale drift. The air tastes like old coins." },
        { name: "The Drowned Cell", desc: "Ankle-deep water, a single barred window above the waterline, and a wooden bench. Whoever was kept here carved a calendar of 412 days." },
        { name: "Vault of Cold Coins", desc: "Copper coins spill from overturned chests and pool in the corners. The temperature here would make your breath visible if you still had breath to spare." },
        { name: "Whispering Corridor", desc: "The corridor bends in a way that geometry does not permit. The whispers stop when you stop and start again before you do." },
        { name: "The Broken Bell Tower", desc: "A cracked bell the size of a cart sits in a nest of beams. Every few minutes it rings anyway. Nothing visible strikes it." }
    ],

    enemies: [
        { name: "grave-wight", desc: "A tall shape wrapped in burial linen, moving with the terrible patience of the recently risen.", hp: 8, attack: 3 },
        { name: "cave goblin pickpocket", desc: "Knee-high, over-armed, and grinning with more teeth than is strictly correct.", hp: 6, attack: 2 },
        { name: "rust-scarab swarm", desc: "A carpet of chittering iron shells that eats metal and leaves the leather.", hp: 7, attack: 2 },
        { name: "gloom bat patriarch", desc: "A bat the size of a large dog, with wings you can hear coming from two rooms away.", hp: 5, attack: 2 },
        { name: "chained revenant", desc: "It still wears its manacles, and it drags them at you like a flail it has grown fond of.", hp: 10, attack: 4 },
        { name: "salt-marsh lurker", desc: "Something smooth and patient that has been waiting in the wet for a very long time.", hp: 9, attack: 3 },
        { name: "hollow sentinel", desc: "An empty suit of antique armour held upright by spite, or something very like it.", hp: 11, attack: 4 },
        { name: "the thing in the well", desc: "You cannot describe it. Your eyes keep sliding off its edges like water off wax.", hp: 12, attack: 5 }
    ],

    loot: [
        { name: "rusted lantern", description: "Still half full. Warm to the touch, which is odd." },
        { name: "chipped short sword", description: "Chipped, honest, and heavier than it looks." },
        { name: "unlabelled brass key", description: "No tag, no owner, all teeth." },
        { name: "clay flask of bitter water", description: "Tastes of minerals and bad decisions. Restores a little." },
        { name: "silver locket", description: "Contains a miniature portrait of a stranger who looks relieved." },
        { name: "bundle of dry rope", description: "Twenty feet. Smells of tar." },
        { name: "tarnished dagger", description: "Bears a maker's mark from a city that no longer exists." },
        { name: "cracked leather satchel", description: "Holds more than its shape suggests." },
        { name: "obsidian shard", description: "Cold, and it hums when someone lies nearby." },
        { name: "bone dice", description: "Weighted, obviously. Still your best friend down here." },
        { name: "wax-sealed scroll", description: "The seal bears a sigil you half recognise from a bad dream." },
        { name: "heavy coin purse", description: "Stitched shut. Something inside is still moving." }
    ]
};

const liteRuntime = {
    rooms: {},   // location name -> { desc }
    loot: {}     // location name -> [{ name, description }]
};

function liteReset() {
    liteRuntime.rooms = {};
    liteRuntime.loot = {};
}

function liteRollRoom(previousName) {
    const candidates = LITE.rooms.filter(function (room) { return room.name !== previousName; });
    return pick(candidates.length ? candidates : LITE.rooms);
}

function liteEnsureRoom(state) {
    if (!liteRuntime.rooms[state.location]) {
        const room = state.location === "The Threshold"
            ? { name: "The Threshold", desc: "A short stair of wet stone descends into the dark. Someone has left a dead torch in a bracket, which is either thoughtful or a warning." }
            : liteRollRoom(state.location);
        liteRuntime.rooms[state.location] = room;
    }
    return liteRuntime.rooms[state.location];
}

function liteHasLight(state) {
    return state.inventory.some(function (item) { return LIGHT_HINTS.test(item); });
}

function liteWeaponBonus(state) {
    return state.inventory.some(function (item) { return WEAPON_HINTS.test(item); }) ? 2 : 0;
}

function liteDamageOutput(state) {
    return randInt(3, 6) + liteWeaponBonus(state);
}

/**
 * The Lite DM. Same contract, no network.
 * @returns {object} raw scene (will be sanitized by the caller)
 */
function liteDM(command, state) {
    const raw = String(command || "").trim().toLowerCase();
    const tokens = raw.split(/\s+/).filter(Boolean);
    const verb = tokens[0] || "look";
    const room = liteEnsureRoom(state);

    const exitsNow = state.exits.length ? state.exits.slice() : pickMany(DIRECTIONS.slice(0, 6), randInt(2, 4));
    const lootHere = liteRuntime.loot[state.location] || [];

    /* ---------------------------------------------------------------- look */
    if (/^(look|l)$/.test(verb) || /^look at/.test(raw)) {
        const lootLine = lootHere.length
            ? " Notable here: " + lootHere.map(function (i) { return "the " + i.name; }).join(", ") + "."
            : "";
        const enemyLine = state.enemy
            ? " The " + state.enemy.name + " is here, and it has noticed you."
            : "";
        return {
            narration: room.desc + lootLine + enemyLine,
            roomName: state.location,
            exits: exitsNow,
            hpDelta: 0,
            scoreDelta: 0,
            itemsFound: [],
            itemsLost: [],
            enemy: state.enemy,
            status: "playing",
            hint: lootHere.length ? "take the " + lootHere[0].name : "go " + exitsNow[0]
        };
    }

    /* ----------------------------------------------------------- inventory */
    if (/^(inventory|i|inv|pack)$/.test(verb)) {
        const carried = state.inventory.length
            ? "You are carrying: " + state.inventory.join(", ") + "."
            : "You are empty-handed.";
        return {
            narration: carried + " The dark does not care either way.",
            roomName: state.location,
            exits: exitsNow,
            enemy: state.enemy,
            hint: "go " + exitsNow[0]
        };
    }

    /* --------------------------------------------------------------- score */
    if (/^score$/.test(verb)) {
        return {
            narration: "You have scored " + state.score + " points across " + state.turns +
                " turns, and you are " + state.hp + " of " + state.maxHp + " healthy. The Dungeon Master declines to grade your technique.",
            roomName: state.location,
            exits: exitsNow,
            enemy: state.enemy,
            hint: "look"
        };
    }

    /* ---------------------------------------------------------------- help */
    if (/^(help|commands|\?)$/.test(verb)) {
        return {
            narration: "The Lite DM understands: look, go <direction>, take <item>, take all, attack, inventory, rest, search, score, help. " +
                "Speak plainly and it will improvise — but for real improvisation, reconnect to the live Dungeon Master.",
            roomName: state.location,
            exits: exitsNow,
            enemy: state.enemy,
            hint: "look"
        };
    }

    /* ---------------------------------------------------------------- rest */
    if (/^(rest|sleep|heal|wait)$/.test(verb)) {
        if (state.enemy) {
            return {
                narration: "You lower your guard for exactly one second. The " + state.enemy.name +
                    " uses it well. Resting is a thing you do when nothing is trying to kill you.",
                roomName: state.location,
                exits: exitsNow,
                hpDelta: -randInt(1, 3),
                enemy: state.enemy,
                hint: "attack"
            };
        }
        const healed = randInt(2, 4);
        return {
            narration: "You sit with your back to the wall and breathe until the shaking stops. It is not comfortable, but it is rest.",
            roomName: state.location,
            exits: exitsNow,
            hpDelta: healed,
            enemy: null,
            hint: "go " + exitsNow[0]
        };
    }

    /* -------------------------------------------------------------- attack */
    if (/^(attack|kill|hit|strike|fight|slay|stab|swing)$/.test(verb) || /^attack /.test(raw)) {
        if (!state.enemy) {
            return {
                narration: "You swing at the empty air with tremendous commitment. Nothing is here to appreciate it.",
                roomName: state.location,
                exits: exitsNow,
                enemy: null,
                hint: "look"
            };
        }
        const damage = liteDamageOutput(state);
        const enemyHp = Math.max(0, state.enemy.hp - damage);
        if (enemyHp <= 0) {
            const drop = pick(LITE.loot);
            if (!liteRuntime.loot[state.location]) liteRuntime.loot[state.location] = [];
            liteRuntime.loot[state.location].push(drop);
            return {
                narration: "You put everything you have into the swing. The " + state.enemy.name +
                    " comes apart — messily, and with a sound you will hear again tonight. It drops something as it falls.",
                roomName: state.location,
                exits: exitsNow,
                hpDelta: -randInt(0, 1),
                scoreDelta: 10,
                itemsFound: [],
                enemy: null,
                enemyDefeated: true,
                status: "playing",
                hint: "take the " + drop.name
            };
        }
        const shielded = state.inventory.some(function (item) {
            return /shield|buckler|plate|mail/i.test(item);
        });
        const retaliation = Math.max(1, enemyAttackRating(state.enemy) - (shielded ? 1 : 0));
        return {
            narration: "You connect — " + damage + " worth, by your estimate. The " + state.enemy.name +
                " staggers, then answers with its full weight behind the blow.",
            roomName: state.location,
            exits: exitsNow,
            hpDelta: -Math.max(1, retaliation),
            enemy: {
                name: state.enemy.name,
                hp: enemyHp,
                maxHp: state.enemy.maxHp,
                description: state.enemy.description,
                attack: state.enemy.attack
            },
            hint: "attack"
        };
    }

    /* ---------------------------------------------------------------- take */
    if (/^(take|get|grab|pick|loot|steal)$/.test(verb) || /^take /.test(raw)) {
        if (!lootHere.length) {
            return {
                narration: "You grope around and find nothing but grit, and one memorable sliver of something that gets under your fingernail.",
                roomName: state.location,
                exits: exitsNow,
                enemy: state.enemy,
                hint: "go " + exitsNow[0]
            };
        }
        const wanted = tokens.slice(1).join(" ");
        let index = 0;
        if (wanted && !/^all$/.test(wanted)) {
            const found = lootHere.findIndex(function (item) {
                return item.name.indexOf(wanted) >= 0 || wanted.indexOf(item.name) >= 0 ||
                    item.name.split(/\s+/).some(function (word) { return word.length > 3 && wanted.indexOf(word) >= 0; });
            });
            if (found >= 0) index = found;
        }
        const taken = lootHere.splice(index, 1)[0];
        if (!lootHere.length) delete liteRuntime.loot[state.location];
        return {
            narration: "You lift the " + taken.name + " clear of the floor and weigh it. " + taken.description,
            roomName: state.location,
            exits: exitsNow,
            itemsFound: [taken],
            scoreDelta: 5,
            enemy: state.enemy,
            hint: "look"
        };
    }

    /* -------------------------------------------------------------- search */
    if (/^(search|examine|inspect|open)$/.test(verb) || /^search /.test(raw)) {
        const found = pick(LITE.loot);
        if (!liteRuntime.loot[state.location]) liteRuntime.loot[state.location] = [];
        liteRuntime.loot[state.location].push(found);
        return {
            narration: "You go over the room with your hands instead of your eyes. Behind a loose stone you find the " +
                found.name + " — " + found.description,
            roomName: state.location,
            exits: exitsNow,
            enemy: state.enemy,
            hint: "take the " + found.name
        };
    }

    /* ---------------------------------------------------------------- move */
    const shortDirections = { n: "north", s: "south", e: "east", w: "west", u: "up", d: "down" };
    let direction = null;
    if (verb === "go" || verb === "move" || verb === "walk" || verb === "head") {
        direction = tokens[1] ? (shortDirections[tokens[1]] || tokens[1]) : null;
    } else if (shortDirections[verb]) {
        direction = shortDirections[verb];
    } else if (DIRECTIONS.indexOf(verb) >= 0) {
        direction = verb;
    }

    if (direction) {
        if (state.exits.length && state.exits.indexOf(direction) < 0) {
            return {
                narration: "There is no way " + direction + " from here. The wall is emphatic about it.",
                roomName: state.location,
                exits: state.exits,
                enemy: state.enemy,
                hint: "go " + state.exits[0]
            };
        }

        const newRoom = liteRollRoom(state.location);
        liteRuntime.rooms[newRoom.name] = newRoom;

        const scene = {
            narration: "You go " + direction + ", feeling your way along cold masonry. " + newRoom.desc,
            roomName: newRoom.name,
            exits: pickMany(DIRECTIONS.slice(0, 6), randInt(2, 4)),
            hpDelta: 0,
            enemy: null,
            status: "playing",
            hint: "look"
        };

        /* Turning your back on something is a decision with a price. */
        if (state.enemy && Math.random() < 0.55) {
            const parting = randInt(1, 2);
            scene.hpDelta = -parting;
            scene.narration += " The " + state.enemy.name +
                " lunges at your retreat and catches you across the shoulder before the dark closes between you.";
        }

        /* Encounter roll — roughly a third of new rooms are occupied. */
        if (Math.random() < 0.34) {
            const enemy = pick(LITE.enemies);
            scene.enemy = { name: enemy.name, hp: enemy.hp, maxHp: enemy.hp, description: enemy.desc, attack: enemy.attack };
            scene.narration += " And then, from somewhere close, the " + enemy.name + " introduces itself.";
            scene.hint = "attack";
        } else if (Math.random() < 0.45) {
            const drop = pick(LITE.loot);
            if (!liteRuntime.loot[newRoom.name]) liteRuntime.loot[newRoom.name] = [];
            liteRuntime.loot[newRoom.name].push(drop);
            scene.narration += " Something lies in the open here: the " + drop.name + ".";
            scene.hint = "take the " + drop.name;
        }

        /* Darkness flavour, using carried light sources. */
        if (!liteHasLight(state) && Math.random() < 0.35) {
            scene.narration += " It is very dark. You are likely to be eaten by a grue.";
        }

        return scene;
    }

    /* ----------------------------------------------------------- fallback */
    return {
        narration: "The Dungeon Master tilts its head at that one. \"" + safeString(command, 120) +
            "\"? Nothing in this room answers to that. You could look, search, take something, or go " + exitsNow[0] + ".",
        roomName: state.location,
        exits: exitsNow,
        enemy: state.enemy,
        status: "playing",
        hint: "look"
    };
}


/* ============================================================================
 * 05. TRANSPORT — talking to the serverless proxy
 * ========================================================================== */

/**
 * Ask the live Dungeon Master what happens next.
 * Throws on any failure so the caller can fall back to the Lite DM.
 *
 * @returns {Promise<{ scene: object, model: string, mode: string }>}
 */
async function requestScene(command, state) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller
        ? setTimeout(function () { controller.abort(); }, CONFIG.REQUEST_TIMEOUT_MS)
        : null;

    try {
        const response = await fetch(CONFIG.DM_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                command: safeString(command, 300),
                state: serializeState(state),
                history: state.history.slice(-CONFIG.MAX_HISTORY_TURNS * 2)
            }),
            signal: controller ? controller.signal : undefined
        });

        /* A 404 here almost always means the static site was deployed without
           the /api folder — the message below says so out loud. */
        if (response.status === 404) {
            throw new Error("no /api/dm endpoint found (is the serverless function deployed?)");
        }

        let payload = null;
        try {
            payload = await response.json();
        } catch (parseError) {
            throw new Error("the proxy returned a non-JSON response (HTTP " + response.status + ")");
        }

        if (!response.ok || payload.ok !== true) {
            const detail = payload && payload.error && payload.error.message
                ? payload.error.message
                : "HTTP " + response.status;
            throw new Error(detail);
        }

        return {
            scene: sanitizeScene(payload.scene),
            model: safeString(payload.model, 80) || CONFIG.DEFAULT_MODEL_LABEL,
            mode: "live"
        };
    } finally {
        if (timer) clearTimeout(timer);
    }
}


/* ============================================================================
 * 06. UI LAYER
 * ----------------------------------------------------------------------------
 * Everything below touches the DOM. It is invoked only from boot(), which is
 * itself guarded by a `typeof document` check, so this file stays requireable
 * in Node for headless tests.
 * ========================================================================== */

/** @type {object} game state (module scope: shared by UI and transport) */
let state = initialState();

function prefersReducedMotion() {
    return typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function boot() {
    /* ---------------------------------------------------------- elements */
    const els = {
        body: document.body,
        log: document.getElementById("log"),
        form: document.getElementById("command-form"),
        input: document.getElementById("command-input"),
        send: document.getElementById("send-button"),
        status: document.getElementById("terminal-status"),
        quickChips: document.getElementById("quick-chips"),
        exitsList: document.getElementById("exits-list"),
        exitsEmpty: document.getElementById("exits-empty"),
        hpCurrent: document.getElementById("hp-current"),
        hpMax: document.getElementById("hp-max"),
        hpBar: document.getElementById("hp-bar"),
        hpFill: document.getElementById("hp-fill"),
        score: document.getElementById("score-value"),
        turns: document.getElementById("turns-value"),
        runStatus: document.getElementById("status-value"),
        locationName: document.getElementById("location-name"),
        threatPanel: document.getElementById("threat-panel"),
        threatName: document.getElementById("threat-name"),
        threatDesc: document.getElementById("threat-desc"),
        enemyHp: document.getElementById("enemy-hp"),
        enemyHpMax: document.getElementById("enemy-hp-max"),
        enemyHpBar: document.getElementById("enemy-hp-bar"),
        enemyHpFill: document.getElementById("enemy-hp-fill"),
        inventoryList: document.getElementById("inventory-list"),
        inventoryEmpty: document.getElementById("inventory-empty"),
        inventoryCount: document.getElementById("inventory-count"),
        visitedCount: document.getElementById("visited-count"),
        modeBadge: document.getElementById("mode-badge"),
        modeLabel: document.getElementById("mode-label"),
        modelLabel: document.getElementById("model-label"),
        footerModel: document.getElementById("footer-model"),
        helpButton: document.getElementById("help-button"),
        helpModal: document.getElementById("help-modal"),
        helpClose: document.getElementById("help-close"),
        newGameButton: document.getElementById("new-game-button"),
        toasts: document.getElementById("toasts"),
        damageFlash: document.getElementById("damage-flash"),
        terminal: document.getElementById("terminal")
    };

    let busy = false;
    let lastError = null;           // last transport failure, exposed via window.RogueText.lastError
    const openedFromFile = window.location.protocol === "file:";
    let typing = null;              // active typewriter handle
    const commandHistory = [];      // submitted commands, oldest first
    let historyPointer = -1;        // -1 = editing a fresh command
    let lastFocused = null;         // for modal focus return

    /* ------------------------------------------------------- persistence */

    function saveNow() {
        try {
            state.transcript = state.transcript.slice(-CONFIG.MAX_TRANSCRIPT);
            window.localStorage.setItem(CONFIG.SAVE_KEY, JSON.stringify({ v: 1, state: state }));
        } catch (error) {
            /* Private browsing / storage disabled: the game still plays. */
        }
    }

    function loadSave() {
        try {
            const raw = window.localStorage.getItem(CONFIG.SAVE_KEY);
            if (!raw) return false;
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.v !== 1 || !isPlainObject(parsed.state)) return false;

            const restored = Object.assign(initialState(), parsed.state);
            restored.inventory = Array.isArray(restored.inventory) ? restored.inventory : [];
            restored.items = Array.isArray(restored.items) ? restored.items : [];
            restored.exits = Array.isArray(restored.exits) ? restored.exits : [];
            restored.visited = Array.isArray(restored.visited) ? restored.visited : [];
            restored.history = Array.isArray(restored.history) ? restored.history : [];
            restored.transcript = Array.isArray(restored.transcript) ? restored.transcript : [];
            restored.hp = clamp(Number(restored.hp) || CONFIG.START_HP, 0, restored.maxHp || CONFIG.START_HP);
            restored.status = ["playing", "dead", "victory"].indexOf(restored.status) >= 0 ? restored.status : "playing";

            if (!restored.turns && !restored.transcript.length) return false;

            state = restored;
            return true;
        } catch (error) {
            return false;
        }
    }

    function clearSave() {
        try { window.localStorage.removeItem(CONFIG.SAVE_KEY); } catch (error) { /* ignore */ }
    }

    /* -------------------------------------------------------- log writing */

    function isPinnedToBottom() {
        return els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 90;
    }

    function scrollLog(force) {
        if (force || isPinnedToBottom()) {
            els.log.scrollTop = els.log.scrollHeight;
        }
    }

    function appendEntry(kind, text) {
        const entry = document.createElement("p");
        entry.className = "log__entry log__entry--" + kind;
        entry.textContent = text;
        els.log.appendChild(entry);
        els.log.setAttribute("aria-live", kind === "narration" ? "polite" : "off");
        state.transcript.push({ kind: kind, text: text });
        scrollLog(false);
        return entry;
    }

    function appendCommandEcho(command) {
        const entry = appendEntry("command", command);
        entry.setAttribute("data-prompt", ">");
        return entry;
    }

    function appendPending() {
        const entry = document.createElement("p");
        entry.className = "log__entry log__entry--pending";
        entry.setAttribute("role", "status");
        entry.innerHTML = 'The Dungeon Master is thinking <span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>';
        els.log.appendChild(entry);
        scrollLog(true);
        return entry;
    }

    function appendHint(text) {
        if (!text) return;
        const entry = document.createElement("p");
        entry.className = "log__entry log__entry--hint";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "log__hint";
        button.textContent = "try: " + text;
        button.addEventListener("click", function () {
            els.input.value = text;
            els.input.focus();
        });
        entry.appendChild(button);
        els.log.appendChild(entry);
        state.transcript.push({ kind: "hint", text: text });
        scrollLog(false);
    }

    /* ------------------------------------------------------- typewriter */

    function typewrite(element, text) {
        return new Promise(function (resolve) {
            if (prefersReducedMotion()) {
                element.textContent = text;
                scrollLog(false);
                resolve();
                return;
            }

            const caret = document.createElement("span");
            caret.className = "caret";
            caret.setAttribute("aria-hidden", "true");
            element.textContent = "";
            element.appendChild(caret);

            let index = 0;

            function finish() {
                if (typing && typing.timer) clearInterval(typing.timer);
                element.textContent = text;
                typing = null;
                scrollLog(false);
                resolve();
            }

            const timer = setInterval(function () {
                index = Math.min(text.length, index + CONFIG.TYPE_CHARS_PER_TICK);
                element.textContent = text.slice(0, index);
                element.appendChild(caret);
                scrollLog(false);
                if (index >= text.length) finish();
            }, CONFIG.TYPE_TICK_MS);

            typing = { element: element, timer: timer, finish: finish };
        });
    }

    function skipTyping() {
        if (typing) typing.finish();
    }

    els.log.addEventListener("click", function () {
        if (typing) skipTyping();
    });

    /* ------------------------------------------------------------ panels */

    function renderVitals() {
        els.hpCurrent.textContent = String(state.hp);
        els.hpMax.textContent = String(state.maxHp);
        const percent = state.maxHp ? clamp((state.hp / state.maxHp) * 100, 0, 100) : 0;
        els.hpFill.style.width = percent + "%";
        els.hpFill.setAttribute("data-level", percent <= 25 ? "critical" : percent <= 55 ? "wounded" : "healthy");
        els.hpBar.setAttribute("aria-valuenow", String(state.hp));
        els.hpBar.setAttribute("aria-valuemax", String(state.maxHp));

        els.score.textContent = String(state.score);
        els.turns.textContent = String(state.turns);

        const label = state.status === "dead" ? "Dead" : state.status === "victory" ? "Victorious" : "Alive";
        els.runStatus.textContent = label;
        els.runStatus.setAttribute("data-status", state.status);
    }

    function renderLocation() {
        els.locationName.textContent = state.location;
        els.visitedCount.textContent = String(state.visited.length + (state.turns ? 1 : 0));

        els.exitsList.innerHTML = "";
        state.exits.forEach(function (direction) {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "chip chip--exit";
            chip.textContent = direction;
            chip.disabled = state.status !== "playing";
            chip.addEventListener("click", function () { submit("go " + direction, true); });
            els.exitsList.appendChild(chip);
        });
        els.exitsEmpty.hidden = state.exits.length > 0;
    }

    function renderThreat() {
        const enemy = state.enemy;
        if (!enemy) {
            els.threatPanel.hidden = true;
            return;
        }
        els.threatPanel.hidden = false;
        els.threatName.textContent = titleCase(enemy.name);
        els.threatDesc.textContent = enemy.description || "It is here. It is looking at you.";
        els.enemyHp.textContent = String(enemy.hp);
        els.enemyHpMax.textContent = String(enemy.maxHp);
        const percent = enemy.maxHp ? clamp((enemy.hp / enemy.maxHp) * 100, 0, 100) : 0;
        els.enemyHpFill.style.width = percent + "%";
        els.enemyHpFill.setAttribute("data-level", percent <= 50 ? "wounded" : "healthy");
        els.enemyHpBar.setAttribute("aria-valuenow", String(Math.round(percent)));
    }

    function renderInventory() {
        els.inventoryList.innerHTML = "";
        els.inventoryCount.textContent = String(state.inventory.length);
        els.inventoryEmpty.hidden = state.inventory.length > 0;

        state.inventory.forEach(function (name) {
            const detail = state.items.find(function (item) { return item.name === name; });
            const li = document.createElement("li");
            const button = document.createElement("button");
            button.type = "button";
            button.className = "inventory__item";
            button.title = "Examine the " + name;

            const body = document.createElement("span");
            const label = document.createElement("span");
            label.className = "inventory__name";
            label.textContent = name;
            body.appendChild(label);

            if (detail && detail.description) {
                const desc = document.createElement("span");
                desc.className = "inventory__desc";
                desc.textContent = detail.description;
                body.appendChild(desc);
            }

            button.appendChild(body);
            button.addEventListener("click", function () {
                els.input.value = "examine the " + name;
                els.input.focus();
                toast("Press Enter to examine the " + name + ".", "info");
            });

            li.appendChild(button);
            els.inventoryList.appendChild(li);
        });
    }

    function renderAll() {
        renderVitals();
        renderLocation();
        renderThreat();
        renderInventory();
    }

    /* ------------------------------------------------------------ status */

    function setStatus(message, tone) {
        els.status.textContent = message || "";
        if (tone) els.status.setAttribute("data-tone", tone);
        else els.status.removeAttribute("data-tone");
    }

    function setMode(mode, model) {
        state.mode = mode;
        if (model) {
            state.model = model;
            els.modelLabel.textContent = model;
            els.footerModel.textContent = model;
        }
        const live = mode === "live";
        els.modeBadge.classList.toggle("badge--live", live);
        els.modeBadge.classList.toggle("badge--lite", !live);
        els.modeLabel.textContent = live ? "LIVE DM" : "LITE DM";
        els.modeBadge.title = live
            ? "Connected to the Groq Dungeon Master (" + state.model + ")"
            : "Groq unreachable — running the offline Lite DM";
    }

    function setBusy(value) {
        busy = value;
        els.input.disabled = value;
        els.send.disabled = value;
        els.send.textContent = value ? "Thinking…" : "Send";
        els.terminal.setAttribute("aria-busy", value ? "true" : "false");
        Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (chip) {
            if (!chip.classList.contains("chip--exit")) chip.disabled = value || state.status !== "playing";
        });
        if (!value) els.input.focus();
    }

    function toast(message, tone) {
        const el = document.createElement("div");
        el.className = "toast toast--" + (tone || "info");
        el.textContent = message;
        els.toasts.appendChild(el);
        setTimeout(function () {
            el.classList.add("toast--leaving");
            setTimeout(function () { el.remove(); }, 260);
        }, tone === "harm" ? 5200 : 4000);
    }

    function flashDamage() {
        els.damageFlash.classList.remove("is-active");
        void els.damageFlash.offsetWidth;   /* restart the CSS animation */
        els.damageFlash.classList.add("is-active");
        els.terminal.classList.remove("shake");
        void els.terminal.offsetWidth;
        els.terminal.classList.add("shake");
    }

    function pulseOk() {
        const panel = els.hpBar.closest(".panel");
        if (!panel) return;
        panel.classList.remove("pulse-ok");
        void panel.offsetWidth;
        panel.classList.add("pulse-ok");
    }

    /* ------------------------------------------------------------ events */

    function handleEvents(events) {
        events.forEach(function (event) {
            switch (event.type) {
                case "damage":
                    flashDamage();
                    toast("\u2212" + event.amount + " health. " + event.hp + "/" + event.maxHp + " left.", "harm");
                    break;
                case "heal":
                    pulseOk();
                    toast("+" + event.amount + " health. " + event.hp + "/" + event.maxHp + ".", "loot");
                    break;
                case "loot":
                    toast("Acquired: " + event.name, "loot");
                    break;
                case "defeat":
                    toast("Defeated: " + event.name + " (+" + event.bonus + ")", "loot");
                    break;
                case "encounter":
                    toast("Threat: " + event.name, "harm");
                    break;
                case "death":
                    toast("You have died. Final score " + event.score + ".", "harm");
                    break;
                case "victory":
                    toast("Victory! Final score " + event.score + ".", "loot");
                    break;
                default:
                    break;
            }
        });
    }

    /* ------------------------------------------------------- the game loop */
    async function submit(rawCommand, echo) {
        const command = String(rawCommand === undefined || rawCommand === null ? "" : rawCommand).trim();
        if (!command || busy) return;

        if (state.status !== "playing") {
            toast("This run is over. Press “New Dungeon” to roll a fresh adventurer.", "warn");
            return;
        }

        skipTyping();
        if (echo !== false) appendCommandEcho(command);
        els.input.value = "";
        commandHistory.push(command);
        historyPointer = -1;

        setBusy(true);
        setStatus("Consulting the Dungeon Master…", "info");
        const pending = appendPending();

        let result = null;
        try {
            result = await requestScene(command, state);
            setMode("live", result.model);
            setStatus("Answered by " + result.model + " via Groq.", "info");
        } catch (error) {
            console.warn("[Rogue-Text] Live Dungeon Master unavailable:", error);
            lastError = { at: new Date().toISOString(), message: error.message, name: error.name };
            result = { scene: sanitizeScene(liteDM(command, state)), model: state.model, mode: "lite" };
            setMode("lite", null);
            if (openedFromFile) {
                setStatus("You opened index.html directly from disk (file://). No server is running " +
                    "to hold your Groq API key, so the Lite DM is narrating. Run `node dev-server.js` " +
                    "and open http://localhost:3000 for the live Dungeon Master.", "error");
            } else {
                setStatus("Live DM unreachable (" + error.message + ") — Lite DM engaged. " +
                    "Type RogueText.lastError in the console for details.", "warn");
            }
            toast("Groq unreachable — Lite DM took over.", "warn");
        }

        pending.remove();

        const scene = sanitizeScene(result.scene);
        const applied = applyScene(state, scene, command);
        state = applied.state;

        /* Narration first, typed out, then the mechanical lines beneath it. */
        const narrationEntry = document.createElement("p");
        narrationEntry.className = "log__entry log__entry--narration";
        els.log.appendChild(narrationEntry);
        state.transcript.push({ kind: "narration", text: scene.narration });

        await typewrite(narrationEntry, scene.narration);

        describeEvents(applied.events, scene).forEach(function (line) {
            appendEntry(line.kind, line.text);
        });

        if (state.status === "playing") appendHint(scene.hint);

        handleEvents(applied.events);
        renderAll();
        setBusy(false);
        scrollLog(true);
        saveNow();

        if (state.status === "dead") {
            setStatus("You died. Final score: " + state.score + ". Press “New Dungeon” to try again.", "error");
        } else if (state.status === "victory") {
            setStatus("Victory. Final score: " + state.score + ".", "info");
        }
    }

    /* ---------------------------------------------------------- listeners */

    /* ======================================================================
     * DEVELOPER CONSOLE API  —  window.RogueText
     * ----------------------------------------------------------------------
     * Everything below is for debugging from the browser console (F12).
     * It is not used by the game itself and adds no UI.
     *
     *   RogueText.help()            list every command
     *   RogueText.state()           the full game state, as JSON
     *   RogueText.send("look")      run a command as if you typed it
     *   RogueText.hurt(7)           take 7 damage (death tests)
     *   RogueText.heal(5)           restore 5 health
     *   RogueText.kill()            die immediately
     *   RogueText.give("a torch")   add an item to the pack
     *   RogueText.spawn("wight", 8) drop an enemy into the room
     *   RogueText.testDM("look")    call /api/dm directly, print the raw reply
     *   RogueText.lastError         why the live DM last failed
     *   RogueText.reset()           wipe the save and start fresh
     * ====================================================================== */
    window.RogueText = {
        version: "1.0.0",
        config: CONFIG,

        help: function () {
            const rows = [
                ["RogueText.state()", "the full game state as an object"],
                ["RogueText.send(cmd)", "run a command exactly as if typed"],
                ["RogueText.testDM(cmd)", "call /api/dm directly and log the raw reply"],
                ["RogueText.lastError", "why the live Dungeon Master last failed"],
                ["RogueText.hurt(n)", "take n damage"],
                ["RogueText.heal(n)", "restore n health"],
                ["RogueText.kill()", "die immediately"],
                ["RogueText.give(name)", "add an item to the inventory"],
                ["RogueText.spawn(name, hp)", "spawn an enemy in the current room"],
                ["RogueText.clearEnemy()", "remove the current enemy"],
                ["RogueText.score(n)", "set the score"],
                ["RogueText.mode()", 'which brain answered last: "live" or "lite"'],
                ["RogueText.reset()", "clear the save and start a new run"]
            ];
            console.log("%cRogue-Text — developer console API", "font-weight:bold");
            if (console.table) console.table(rows.map(function (r) { return { Command: r[0], Effect: r[1] }; }));
            else rows.forEach(function (r) { console.log("  " + r[0] + "  →  " + r[1]); });
            return "Cheat freely. The dungeon does not respect you either.";
        },

        state: function () {
            return JSON.parse(JSON.stringify(state));
        },

        send: function (command) {
            submit(command, true);
            return "sent: " + command;
        },

        testDM: async function (command) {
            const probe = command || "look";
            console.log("[RogueText] POST " + CONFIG.DM_ENDPOINT + " with command:", probe);
            try {
                const response = await fetch(CONFIG.DM_ENDPOINT, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ command: probe, state: serializeState(state), history: [] })
                });
                const payload = await response.json();
                console.log("[RogueText] HTTP " + response.status, payload);
                if (!response.ok) {
                    console.warn("[RogueText] The proxy returned an error. Read payload.error.message — " +
                        "it names the fix.");
                }
                return payload;
            } catch (error) {
                console.error("[RogueText] Network failure reaching " + CONFIG.DM_ENDPOINT + ":", error);
                console.warn("[RogueText] Most likely causes: (1) you opened index.html from the file " +
                    "system instead of http://, (2) the dev server is not running, (3) the site was " +
                    "deployed without the api/ folder.");
                return null;
            }
        },

        get lastError() {
            return lastError || "none — the last command was answered live, or the console was cleared.";
        },

        hurt: function (amount) {
            const applied = applyScene(state, sanitizeScene({
                narration: "(console) damage applied", hpDelta: -Math.abs(Number(amount) || 1)
            }), "debug");
            state = applied.state;
            handleEvents(applied.events);
            renderAll();
            saveNow();
            return state.hp + "/" + state.maxHp;
        },

        heal: function (amount) {
            const applied = applyScene(state, sanitizeScene({
                narration: "(console) healing applied", hpDelta: Math.abs(Number(amount) || 1)
            }), "debug");
            state = applied.state;
            renderAll();
            saveNow();
            return state.hp + "/" + state.maxHp;
        },

        kill: function () {
            return this.hurt(state.maxHp * 2);
        },

        give: function (name) {
            const item = safeString(name, 80) || "mystery object";
            state.inventory.push(item);
            state.items.push({ name: item, description: "Added from the developer console." });
            renderInventory();
            saveNow();
            return state.inventory;
        },

        spawn: function (name, hp) {
            const enemyName = safeString(name, 80) || "console gremlin";
            const enemyHp = clamp(Math.round(Number(hp) || 6), 1, 99);
            state.enemy = {
                name: enemyName,
                hp: enemyHp,
                maxHp: enemyHp,
                description: "Conjured from the developer console.",
                attack: enemyAttackRating({ maxHp: enemyHp })
            };
            renderThreat();
            saveNow();
            return state.enemy;
        },

        clearEnemy: function () {
            state.enemy = null;
            renderThreat();
            saveNow();
            return "enemy cleared";
        },

        score: function (points) {
            state.score = Math.max(0, Math.round(Number(points) || 0));
            renderVitals();
            saveNow();
            return state.score;
        },

        mode: function () {
            return state.mode === "live"
                ? "live — answered by " + state.model
                : "lite — the offline fallback is narrating";
        },

        reset: function () {
            clearSave();
            liteReset();
            state = initialState();
            els.log.innerHTML = "";
            setMode("live", CONFIG.DEFAULT_MODEL_LABEL);
            appendEntry("intro", "A fresh adventurer stands at the threshold of the Undervault.");
            renderAll();
            submit("look", false);
            return "new run started";
        }
    };

    /* ------------------------------------------------------------ listeners */

    els.form.addEventListener("submit", function (event) {
        event.preventDefault();
        submit(els.input.value, true);
    });

    els.input.addEventListener("keydown", function (event) {
        if (event.key === "ArrowUp") {
            if (!commandHistory.length) return;
            event.preventDefault();
            historyPointer = historyPointer < 0 ? commandHistory.length - 1 : Math.max(0, historyPointer - 1);
            els.input.value = commandHistory[historyPointer];
            els.input.setSelectionRange(els.input.value.length, els.input.value.length);
        } else if (event.key === "ArrowDown") {
            if (historyPointer < 0) return;
            event.preventDefault();
            historyPointer += 1;
            if (historyPointer >= commandHistory.length) {
                historyPointer = -1;
                els.input.value = "";
            } else {
                els.input.value = commandHistory[historyPointer];
            }
        } else if (event.key === "Escape" && typing) {
            skipTyping();
        }
    });

    els.quickChips.addEventListener("click", function (event) {
        const chip = event.target.closest(".chip");
        if (!chip) return;
        submit(chip.getAttribute("data-command"), true);
    });

    /* Help modal */
    function openHelp() {
        lastFocused = document.activeElement;
        els.helpModal.hidden = false;
        document.body.style.overflow = "hidden";
        els.helpClose.focus();
    }
    function closeHelp() {
        els.helpModal.hidden = true;
        document.body.style.overflow = "";
        if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
    }

    els.helpButton.addEventListener("click", openHelp);
    els.helpClose.addEventListener("click", closeHelp);
    els.helpModal.addEventListener("click", function (event) {
        if (event.target.hasAttribute("data-close-modal")) closeHelp();
    });
    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && !els.helpModal.hidden) closeHelp();
    });

    /* New game */
    function startFreshRun(announce) {
        const hasProgress = state.turns > 0 && state.status === "playing";
        if (announce && hasProgress) {
            const confirmed = window.confirm("Abandon this run and descend into a brand new dungeon?");
            if (!confirmed) return;
        }
        clearSave();
        liteReset();
        state = initialState();
        els.log.innerHTML = "";
        els.toasts.innerHTML = "";
        setMode("live", CONFIG.DEFAULT_MODEL_LABEL);
        appendEntry("intro", "You stand at the threshold of the Undervault with 20 health, no map, and no plan. The Dungeon Master is listening.");
        renderAll();
        submit("look", false);
    }

    els.newGameButton.addEventListener("click", function () { startFreshRun(true); });

    /* ------------------------------------------------------------- boot */

    const restored = loadSave();
    if (restored) {
        state.transcript.forEach(function (entry) {
            if (entry.kind === "hint") appendHint(entry.text);
            else {
                const element = appendEntry(entry.kind, entry.text);
                if (entry.kind === "command") element.setAttribute("data-prompt", ">");
            }
        });
        appendEntry("system", "Run restored from this browser. " + state.hp + "/" + state.maxHp +
            " health, " + state.score + " points, " + state.turns + " turns played.");
        setMode(state.mode === "lite" ? "lite" : "live", state.model);
        renderAll();
        scrollLog(true);
        setStatus("Welcome back. Type a command to continue.", "info");
    } else {
        startFreshRun(false);
    }

    els.input.focus();

    /* ------------------------------------------------- file:// warning ---
       Opening index.html by double-clicking it loads the UI but there is no
       server to hold the API key, so every command silently degrades to the
       Lite DM. Say so plainly instead of leaving the player puzzled. */
    if (openedFromFile) {
        toast("file:// detected — run `node dev-server.js` for the live DM.", "warn");
        console.warn("[Rogue-Text] Opened via file://. The live Dungeon Master cannot work here " +
            "because the API key must stay server-side.\n" +
            "  Fix: run  node dev-server.js  then open http://localhost:3000");
    }
}

/* ============================================================================
 * 07. BOOT (browser only)
 * ========================================================================== */

if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
}

/* ============================================================================
 * 08. TEST EXPORTS (Node only — no effect in the browser)
 * ----------------------------------------------------------------------------
 * Lets Step 4 run headless checks:
 *   node -e "const rt=require('./app.js'); console.log(rt.applyScene(...))"
 * ========================================================================== */

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        CONFIG: CONFIG,
        DIRECTIONS: DIRECTIONS,
        initialState: initialState,
        serializeState: serializeState,
        sanitizeScene: sanitizeScene,
        applyScene: applyScene,
        describeEvents: describeEvents,
        liteDM: liteDM,
        liteReset: liteReset,
        enemyAttackRating: enemyAttackRating,
        clamp: clamp
    };
}
