import assert from 'assert';
import { parseMark, fieldFromOcr, applyTotalsRule, evaluate } from '../js/rules.js';
import { PART_A, PART_B } from '../js/template.js';
const t = (x, k) => parseMark(x, k);
assert.equal(t('2', 'Q1').value, 2); assert.equal(t('1+1', 'Q1').value, 2);
assert.ok(t('27', 'Q1').invalid && t('27', 'Q1').value === null, '27 never truncated');
assert.ok(t('3', 'Q1').invalid); assert.ok(t('2+1', 'Q1').invalid);
assert.ok(t('-', 'Q3').blank); assert.ok(t('', 'Q3').blank);
assert.equal(t('6+2', '12a').value, 8); assert.equal(t('11', '12a').value, 11);
assert.ok(t('12', '12a').invalid); assert.ok(t('6+6', '12a').invalid);
// record mirroring the sample booklet
const mk = (k, text, conf = 0.99, alts = []) => fieldFromOcr(k, { text, conf, alts });
const F = {};
for (const [k, v] of Object.entries({ Q1: '2', Q2: '2', Q3: '2', Q4: '2', Q5: '2', Q6: '1', Q7: '2', Q8: '2', Q9: '1', Q10: '2' })) F[k] = mk(k, v);
for (const k of PART_B) F[k] = mk(k, '');
F['11a'] = mk('11a', '88', 0.5, [{ text: '88', p: .6 }, { text: '8', p: .3 }]); F['12a'] = mk('12a', '11'); F['13b'] = mk('13b', '11'); F['14b'] = mk('14b', '7'); F['15a'] = mk('15a', '7');
F.totalA = mk('totalA', '18'); F.totalB = mk('totalB', '44'); F.grand = mk('grand', ''); F.coTotal = mk('coTotal', '62');
for (let i = 1; i <= 13; i++) F['reg' + i] = mk('reg' + i, '2116231801007'[i - 1]);
const rec = { fields: F }; applyTotalsRule(rec); const s = evaluate(rec);
assert.equal(F.grand.value, 62, 'grand filled from CO = A+B'); assert.equal(F.coTotal.value, 62);
assert.equal(rec.audit.totalsRule.grandRead, '', 'original reading preserved');
assert.equal(s.calcA, 18); assert.equal(s.calcB, 36);
assert.equal(F['11a'].value, null, '88 not forced into range');
assert.equal(F['11a'].suggestion.value, 8, 'suggests 8 to balance Part B');
// both alternatives answered → keep higher, flag the other
F['14a'] = mk('14a', '5'); evaluate(rec); assert.ok(F['14a'].excluded && !F['14b'].excluded);
// doubtful 1 vs 2 balancing (never auto-changed)
const G = JSON.parse(JSON.stringify(rec.fields)); G['14a'] = mk('14a', ''); G['11a'] = mk('11a', '8'); G.Q6 = mk('Q6', '1', 0.55, [{ text: '1', p: .52 }, { text: '2', p: .45 }]); G.totalA = mk('totalA', '19');
const r2 = { fields: G }; evaluate(r2); assert.equal(G.Q6.value, 1, 'value unchanged'); assert.equal(G.Q6.suggestion.value, 2, 'suggests 2');
assert.ok(G.Q6.flags.some(f => f.level === 'red'), 'marked red');
console.log('rules: all tests passed');
