const path = require('path');
const rt = require(path.join(__dirname, '..', 'app.js'));
let fails = 0;
const ok = (cond, name, extra) => { if (!cond) { fails++; console.log('  ✗ FAIL:', name, extra ?? ''); } else console.log('  ✓', name); };

console.log('\n=== A. sanitizeScene survives hostile input ===');
[null, undefined, 'nonsense', 42, [], {}, {hpDelta: 'NaN', exits: 'north', itemsFound: 'x'},
 {narration: null, exits: [1,2,'north','north','NORTH'], hpDelta: -9999, scoreDelta: 99999,
  itemsFound: [{}, {name:'a'}, 'plain string', null], enemy: {name:'x', hp:'bad', maxHp:-5}},
 {status:'ZOMBIE', hint: {}}].forEach((raw, i) => {
  const s = rt.sanitizeScene(raw);
  ok(s && typeof s.narration === 'string' && s.narration.length > 0, `input #${i} -> valid narration`);
  ok(s.hpDelta >= -25 && s.hpDelta <= 25, `input #${i} -> hpDelta clamped (${s.hpDelta})`);
  ok(['playing','dead','victory'].includes(s.status), `input #${i} -> status valid (${s.status})`);
  ok(Array.isArray(s.exits) && s.exits.length <= 6, `input #${i} -> exits array`);
});

console.log('\n=== B. Reducer: damage, death, loot, enemy lifecycle ===');
let st = rt.initialState();
let r = rt.applyScene(st, rt.sanitizeScene({ narration:'You enter.', roomName:'Hall', exits:['north'], hpDelta:0 }), 'look');
st = r.state;
ok(st.turns === 1 && st.location === 'Hall', 'turn advanced + moved');
r = rt.applyScene(st, rt.sanitizeScene({ narration:'A goblin!', enemy:{name:'goblin', hp:6, maxHp:6, description:'small'},
  itemsFound:[{name:'rusty key', description:'teeth'}], scoreDelta: 5 }), 'go north');
st = r.state;
ok(st.enemy && st.enemy.hp === 6, 'enemy spawned');
ok(st.inventory.includes('rusty key') && st.items[0].description === 'teeth', 'loot added to inventory + items');
ok(st.score === 5, 'score applied');
r = rt.applyScene(st, rt.sanitizeScene({ narration:'You kill it.', enemy:null, enemyDefeated:true }), 'attack');
st = r.state;
ok(st.enemy === null, 'enemy cleared');
ok(st.score === 30, 'kill bonus (+25) applied -> ' + st.score);
ok(rt.describeEvents(r.events, {}).some(l => /destroyed/.test(l.text)), 'defeat line generated');
// Death
r = rt.applyScene(st, rt.sanitizeScene({ narration:'Fatal.', hpDelta:-25 }), 'go down');
st = r.state;
ok(st.hp === 0 && st.status === 'dead', 'death at 0 hp');
ok(rt.describeEvents(r.events, {}).some(l => l.kind === 'death'), 'death line generated');
// No resurrection
r = rt.applyScene(st, rt.sanitizeScene({ narration:'heal', hpDelta: 5 }), 'rest');
ok(r.state.hp === 5, 'hp can recover numerically (UI still blocks commands when dead)');
// Overflow guard
let st2 = rt.initialState();
r = rt.applyScene(st2, rt.sanitizeScene({ narration:'x', hpDelta: 99 }), 'rest');
ok(r.state.hp === st2.maxHp, 'heal clamped to maxHp');

console.log('\n=== C. Lite DM: 300 random turns, no crashes ===');
const cmds = ['look','inventory','attack','take all','rest','search the room','go north','go south','go east',
 'go west','go up','go down','frobnicate the obelisk','n','s','score','help','examine the wall','take the rusty key','flee'];
rt.liteReset();
let s3 = rt.initialState(); let deaths = 0; let scenes = 0; let bad = 0;
for (let i = 0; i < 300; i++) {
  if (s3.status !== 'playing') { s3 = rt.initialState(); rt.liteReset(); }
  const cmd = cmds[i % cmds.length];
  const scene = rt.sanitizeScene(rt.liteDM(cmd, s3));
  if (!scene.narration || scene.narration.length < 10) bad++;
  if (scene.narration.length > 4000) bad++;
  const applied = rt.applyScene(s3, scene, cmd);
  s3 = applied.state; scenes++;
  if (s3.status === 'dead') deaths++;
  if (s3.hp < 0 || s3.hp > s3.maxHp) { bad++; }
  if (!Array.isArray(s3.inventory)) bad++;
}
ok(bad === 0, `300 turns, ${bad} malformed scenes`);
ok(scenes === 300, `loop completed ${scenes} scenes`);
console.log(`    → deaths: ${deaths}, inventory: [${s3.inventory.join(', ')}], pos: ${s3.location}, score: ${s3.score}`);

console.log('\n=== D. Combat is lethal to an aggressive player (stand and fight) ===');
let lethal = 0, instant = 0, totalTurns = 0;
for (let run = 0; run < 50; run++) {
  rt.liteReset(); let s = rt.initialState(); let t = 0;
  for (t = 0; t < 80 && s.status === 'playing'; t++) {
    // Aggressive AI: fight what is in front of you, otherwise explore.
    const cmd = s.enemy ? 'attack' : 'go ' + ['north','south','east','west'][t % 4];
    const scene = rt.sanitizeScene(rt.liteDM(cmd, s));
    s = rt.applyScene(s, scene, cmd).state;
  }
  totalTurns += t;
  if (s.status === 'dead') { lethal++; if (t <= 3) instant++; }
}
ok(lethal > 0, `aggressive play dies in ${lethal}/50 runs`);
ok(instant === 0, `never an instant death (${instant} runs died in <=3 turns)`);
console.log(`    → mean survival: ${(totalTurns/50).toFixed(1)} turns`);

console.log('\n=== D2. Cautious play (flee + rest) survives longer ===');
let cautiousDeaths = 0, cautiousTurns = 0;
for (let run = 0; run < 50; run++) {
  rt.liteReset(); let s = rt.initialState(); let t = 0;
  for (t = 0; t < 80 && s.status === 'playing'; t++) {
    let cmd;
    if (s.hp <= 8) cmd = 'rest';
    else if (s.enemy) cmd = 'go north';
    else cmd = 'go ' + ['north','south','east','west'][t % 4];
    const scene = rt.sanitizeScene(rt.liteDM(cmd, s));
    s = rt.applyScene(s, scene, cmd).state;
  }
  cautiousTurns += t;
  if (s.status === 'dead') cautiousDeaths++;
}
ok(cautiousDeaths <= lethal, `cautious deaths (${cautiousDeaths}) <= aggressive deaths (${lethal})`);
console.log(`    → mean survival: ${(cautiousTurns/50).toFixed(1)} turns`);

console.log('\n=== E. Offline contract shape matches what the UI expects ===');
const sceneKeys = Object.keys(rt.sanitizeScene(rt.liteDM('look', rt.initialState()))).sort().join(',');
console.log('    keys:', sceneKeys);
ok(sceneKeys === 'enemy,enemyDefeated,exits,hint,hpDelta,itemsFound,itemsLost,narration,roomName,scoreDelta,status', 'contract is complete');
ok(rt.serializeState(rt.initialState()).hasOwnProperty('enemy'), 'serializeState shape ok');



/* ---------------------------------------------------------------------------
 * Regression: a 0-HP enemy must never be resurrected by falsy-coercion.
 * (`Number(hp) || maxHp` turns 0 into maxHp — a silent state-corruption bug.)
 * ------------------------------------------------------------------------ */
console.log('\n=== F. Dead enemies stay dead (0 is not falsy) ===');
const deadScene = rt.sanitizeScene({ narration: 'It falls and stops moving.', enemy: { name: 'grave-wight', hp: 0, maxHp: 8 }, status: 'playing' });
ok(deadScene.enemy === null, 'enemy reported at hp:0 is cleared, not resurrected to ' + (deadScene.enemy ? deadScene.enemy.hp : 'n/a'));
ok(deadScene.enemyDefeated === true, 'a 0-HP enemy is marked defeated even if the DM forgot enemyDefeated');
const half = rt.sanitizeScene({ narration: 'x', enemy: { name: 'wight', hp: 4, maxHp: 8 } });
ok(half.enemy && half.enemy.hp === 4 && half.enemy.maxHp === 8, 'a wounded enemy keeps its real hp (4/8)');
const stat = rt.sanitizeScene({ narration: 'x', enemy: { name: 'wight', maxHp: 8 } });
ok(stat.enemy && stat.enemy.hp === 8, 'missing hp defaults to full health');
const weird = rt.sanitizeScene({ narration: 'x', enemy: { name: 'wight', hp: 'NaN', maxHp: 'bad' } });
ok(weird.enemy && weird.enemy.maxHp === 6 && weird.enemy.hp === 6, 'garbage enemy numbers fall back to a safe 6/6');
const zeroMax = rt.sanitizeScene({ narration: 'x', enemy: { name: 'wight', hp: 5, maxHp: 0 } });
ok(zeroMax.enemy && zeroMax.enemy.maxHp === 5 && zeroMax.enemy.hp === 5, 'maxHp 0 defers to hp instead of producing 0/0');

let lethalEnemy = rt.initialState();
lethalEnemy = rt.applyScene(lethalEnemy, rt.sanitizeScene({ narration: 'A wight!', enemy: { name: 'grave-wight', hp: 8, maxHp: 8 } }), 'look').state;
const killed = rt.applyScene(lethalEnemy, deadScene, 'attack');
ok(killed.state.enemy === null && killed.state.score >= 25, 'kill through the reducer clears the enemy and pays the bonus');
ok(rt.describeEvents(killed.events, deadScene).some(l => /destroyed/.test(l.text)), 'kill is narrated as a system line');

console.log(fails === 0 ? '\n✅ ALL SMOKE TESTS PASSED' : `\n❌ ${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
