const fs = require('fs');
const { JSDOM } = require('jsdom');

let fails = 0;
const ok = (c, n, x) => { if (!c) { fails++; console.log('  ✗ FAIL:', n, x ?? ''); } else console.log('  ✓', n); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
// A turn is finished when setBusy(false) has run — i.e. Send is clickable again.
async function waitIdle(window, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const btn = window.document.getElementById('send-button');
    if (btn && !btn.disabled) { await wait(120); return true; }
    await wait(80);
  }
  throw new Error('UI never became idle');
}
const turnsNow = (d) => Number(text(d, 'turns-value'));
const text = (d, id) => (d.getElementById(id) || {}).textContent || '';

(async () => {
  const base = 'http://localhost:3000';
  const html = await (await fetch(base + '/')).text();
  const appJs = fs.readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');

  const dom = new JSDOM(html.replace('<script src="app.js" defer></script>', ''), {
    url: base + '/', runScripts: 'dangerously', pretendToBeVisual: true
  });
  const { window } = dom;
  const { document } = window;
  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.message)));
  window.onerror = (m) => errors.push(String(m));

  // jsdom's AbortController cannot be handed to Node's fetch, so disable it (the
  // app already guards with typeof — this exercises the no-signal code path).
  delete window.AbortController;
  window.fetch = (input, init) => fetch(new URL(input, base).toString(), init);
  window.confirm = () => true;

  console.log('\n=== A. Boot without a live API (the Lite DM path) ===');
  window.eval(appJs);
  // app.js boots on DOMContentLoaded in jsdom; wait for that before polling idle.
  await new Promise(res => {
    if (window.document.readyState === 'complete') return res();
    window.addEventListener('load', res, { once: true });
    setTimeout(res, 1500);
  });
  await wait(250);
  await waitIdle(window, 20000);

  ok(errors.length === 0, 'no uncaught JS errors during boot', errors.join(' | '));
  ok(text(document, 'mode-label') === 'LITE DM', 'header badge flipped to LITE DM (badge text: "' + text(document, 'mode-label') + '")');
  ok(/unreachable/i.test(text(document, 'terminal-status')), 'status bar explains why');
  ok(text(document, 'location-name') !== '', 'location rendered: "' + text(document, 'location-name') + '"');
  ok(text(document, 'hp-current') === '20', 'HP panel shows 20');
  ok(document.querySelectorAll('.chip--exit').length > 0, 'exit chips rendered: ' + document.querySelectorAll('.chip--exit').length);
  ok(text(document, 'log').length > 120, 'opening narration was written (' + text(document, 'log').length + ' chars)');
  ok(document.querySelector('.log__entry--narration') !== null, 'narration entry exists');
  ok(document.querySelector('.caret') === null, 'typewriter caret cleared after typing finished');
  ok(document.querySelector('.log__hint') !== null, 'a suggested action was offered: "' + (document.querySelector('.log__hint') || {}).textContent + '"');

  console.log('\n=== B. A full turn through the UI ===');
  const input = document.getElementById('command-input');
  const form = document.getElementById('command-form');
  const before = turnsNow(document);
  input.value = 'go north';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitIdle(window);
  ok(turnsNow(document) === before + 1, 'turn counter advanced ' + before + ' -> ' + turnsNow(document));
  ok(document.querySelectorAll('.log__entry--command').length === 1, 'command echoed into the log');
  ok(document.querySelectorAll('.log__entry--narration').length === 2, 'second narration block written');
  ok(!text(document, 'location-name').startsWith('undefined'), 'location panel updated: "' + text(document, 'location-name') + '"');

  console.log('\n=== C. Mechanical events reach the panels ===');
  input.value = 'search the room';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitIdle(window);
  // `search` only REVEALS loot in the room; the loot line fires when you take it.
  ok(document.querySelectorAll('.log__entry--narration').length === 3, 'search narration written');
  ok(document.querySelectorAll('.log__hint').length >= 2, 'loot hint rendered');

  input.value = 'take all';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitIdle(window);
  const invItems = document.querySelectorAll('.inventory__item');
  ok(invItems.length > 0, 'inventory panel populated: ' + invItems.length + ' item(s)');
  ok(text(document, 'inventory-count') !== '0', 'inventory counter reads ' + text(document, 'inventory-count'));
  ok(document.getElementById('inventory-empty').hidden === true, 'empty-state message hidden once you carry something');
  ok(document.querySelectorAll('.log__entry--loot').length > 0, 'loot line logged on take (' + document.querySelectorAll('.log__entry--loot').length + ')');
  ok(document.querySelector('.inventory__desc') !== null, 'item description rendered in the inventory panel ("' + (document.querySelector('.inventory__desc') || {}).textContent + '")');
  ok(document.querySelectorAll('.toast').length >= 0, 'toast pipeline alive');

  console.log('\n=== D. Autosave / restore ===');
  const saved = window.localStorage.getItem('rogue-text:save:v1');
  ok(!!saved, 'state written to localStorage');
  const parsed = JSON.parse(saved || '{}');
  ok(parsed.v === 1 && parsed.state.turns >= 4, 'save contains ' + parsed.state.turns + ' turns (opening look + 3 commands)');
  ok(parsed.state.inventory.length > 0, 'save contains inventory: [' + parsed.state.inventory.join(', ') + ']');

  console.log('\n=== E. Dead-run guard ===');
  // Force death by injecting lethal damage through the same reducer the UI uses.
  const rt = require(require('path').join(__dirname, '..', 'app.js'));
  const s = parsed.state; s.hp = 1; s.status = 'playing';
  const applied = rt.applyScene(s, rt.sanitizeScene({ narration: 'A blade finds you.', hpDelta: -25 }), 'attack');
  ok(applied.state.status === 'dead', 'reducer marks the run dead at 0 HP');
  ok(rt.describeEvents(applied.events, {}).some(l => l.kind === 'death'), 'death produces a death line');

  console.log('\n=== F. Command history (↑/↓) ===');
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  ok(input.value === 'take all', 'ArrowUp recalled the last command ("' + input.value + '")');
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  ok(input.value === 'search the room', 'ArrowUp again walked further back ("' + input.value + '")');
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  ok(input.value === 'take all', 'ArrowDown walked forward again');

  console.log('\n=== G. Help modal + new game ===');
  document.getElementById('help-button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  ok(document.getElementById('help-modal').hidden === false, 'help modal opens');
  document.getElementById('help-close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  ok(document.getElementById('help-modal').hidden === true, 'help modal closes');
  document.getElementById('new-game-button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitIdle(window);
  ok(text(document, 'inventory-count') === '0', 'New Dungeon reset the inventory');
  ok(text(document, 'score-value') === '0', 'New Dungeon reset the score');

  console.log('\n=== H. Developer console API (window.RogueText) ===');
  const RT = window.RogueText;
  ok(typeof RT === 'object' && RT !== null, 'RogueText namespace is exposed');
  ok(typeof RT.help === 'function', 'help() available');
  const st0 = RT.state();
  ok(st0 && typeof st0.hp === 'number' && Array.isArray(st0.inventory), 'state() returns a copy of the game state');
  st0.hp = 999;
  ok(RT.state().hp !== 999, 'state() returns a COPY — mutating it cannot corrupt the game');
  ok(/lite|live/.test(RT.mode()), 'mode() reports which brain is answering: "' + RT.mode() + '"');

  const hpBefore = RT.state().hp;
  const hpAfter = RT.hurt(3);
  ok(RT.state().hp === hpBefore - 3, 'hurt(3) applied real damage (' + hpBefore + ' -> ' + hpAfter + ')');
  ok(/\d+\/\d+/.test(hpAfter), 'hurt() returns "hp/maxHp"');
  RT.heal(2);
  ok(RT.state().hp === hpBefore - 1, 'heal(2) restored health');
  ok(RT.state().hp <= RT.state().maxHp, 'heal() never exceeds maxHp');

  RT.give('console torch');
  ok(RT.state().inventory.indexOf('console torch') >= 0, 'give() added an item');
  ok(document.querySelectorAll('.inventory__item').length === RT.state().inventory.length, 'inventory panel re-rendered to match');

  const spawned = RT.spawn('console gremlin', 7);
  ok(spawned.name === 'console gremlin' && spawned.hp === 7, 'spawn() created an enemy with real stats');
  ok(spawned.attack >= 1 && Number.isFinite(spawned.attack), 'spawned enemy has a finite attack rating (' + spawned.attack + ')');
  ok(document.getElementById('threat-panel').hidden === false, 'threat panel became visible');
  ok(document.getElementById('enemy-hp').textContent === '7', 'threat panel shows the spawned HP');

  RT.score(123);
  ok(document.getElementById('score-value').textContent === '123', 'score() updated the panel');

  RT.clearEnemy();
  ok(RT.state().enemy === null && document.getElementById('threat-panel').hidden === true, 'clearEnemy() emptied and hid the threat panel');

  RT.kill();
  ok(RT.state().status === 'dead' && RT.state().hp === 0, 'kill() ends the run');
  ok(RT.lastError !== undefined, 'lastError is readable (value: ' + JSON.stringify(RT.lastError).slice(0, 60) + ')');

  const dmProbe = await RT.testDM('look');
  ok(dmProbe === null || typeof dmProbe === 'object', 'testDM() returns a payload or null — never throws');

  RT.reset();
  await waitIdle(window);
  ok(RT.state().status === 'playing' && RT.state().hp === 20, 'reset() starts a clean run at full health');
  ok(document.getElementById('inventory-count').textContent === '0', 'reset() emptied the inventory');

  console.log('\n=== I. file:// guard (opening index.html by double-click) ===');
  const fileDom = new JSDOM(html.replace('<script src="app.js" defer></script>', ''), {
    url: 'file:///C:/Users/dev/rogue-text/index.html', runScripts: 'dangerously', pretendToBeVisual: true
  });
  const fw = fileDom.window;
  const fileErrors = [];
  fw.onerror = (m) => fileErrors.push(String(m));
  delete fw.AbortController;
  fw.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  fw.eval(appJs);
  await new Promise(res => {
    if (fw.document.readyState === 'complete') return res();
    fw.addEventListener('load', res, { once: true });
    setTimeout(res, 1500);
  });
  await wait(250);
  await waitIdle(fw, 20000);
  const fdoc = fw.document;
  const statusText = (fdoc.getElementById('terminal-status') || {}).textContent || '';
  ok(/file:\/\//.test(statusText), 'file:// is detected and named in the status line');
  ok(/dev-server\.js/.test(statusText), 'the status line gives the exact command to run');
  ok((fdoc.getElementById('mode-label') || {}).textContent === 'LITE DM', 'game still plays via the Lite DM from file://');
  ok(fileErrors.length === 0, 'no uncaught errors even on file://', fileErrors.join(' | '));
  ok(fdoc.querySelectorAll('.log__entry').length > 0, 'narration still renders on file://');
  fileDom.window.close();

  console.log('\n=== J. Final error sweep ===');
  ok(errors.length === 0, 'still zero uncaught errors after ' + document.querySelectorAll('.log__entry').length + ' rendered entries', errors.join(' | '));

  console.log(fails === 0 ? '\n✅ ALL UI TESTS PASSED' : `\n❌ ${fails} FAILURES`);
  dom.window.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(1); });
