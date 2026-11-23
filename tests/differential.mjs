import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../solve.js';

const [mode, kit, shardText = '0'] = process.argv.slice(2);
const { run: oracle } = await import(pathToFileURL(resolve(kit, 'program/generator/oracle.js')).href);
const decoder = new TextDecoder('utf-8', { fatal: true });

function check(input, label) {
  const expected = oracle(input);
  assert.deepStrictEqual(run(input), expected, label);
  let calls = 0;
  assert.equal(run(input, (bytes) => {
    calls++;
    assert.equal(decoder.decode(bytes), JSON.stringify(expected), label);
  }), undefined, label);
  assert.equal(calls, 1, label);
}

if (mode === 'edges') {
  // The same twelve inputs used by v3/tests/edge-cases.mjs.
  const edges = [
    ['BOM and header', '\ufeffa,b\r\n1,2\r\n', true],
    ['blank records', '\n\r\nA\n\nB', false],
    ['stray CR', 'A\rB,C\r\n', false],
    ['quoted line endings', '"a\r\nb\rc\n",x\r\n', false],
    ['escaped quote and junk', '"a""b" kg,tail\n', false],
    ['unterminated quote', '"open,tail\nnext,row\n', false],
    ['unquoted quote', 'a"b,c\n', false],
    ['short and long rows', 'a,b,c\n1\n2,3,4,5\n', true],
    ['only stray CR', '\r\r\nA\n', false],
    ['error order', '"a"\rX,z\n', false],
    ['multiline record start', 'a,b\n"x\ny",1,2\n', true],
    ['trailing comma and surrogate', '\ud800,\ud83d\ude00,', false],
  ];
  for (const [label, text, header] of edges) check({ text, header }, label);
  console.log(`${edges.length} existing edges passed on both paths`);

  const endings = [
    ',x\r\n', '"a""b\r\nc\r",tail', '"a"\r\u0000,\n',
    '"\ud800"\udc00,x', '\udbff\r\udfff,\ud800\ud800',
    '"a\r\n,b\r\nnext,field', '""\r\n\r\r\n',
    '\ufeff"a",x', 'abc\r\n"b"junk\rmore,c,d',
  ];
  let count = 0;
  for (let offset = 0; offset < 24; offset++) {
    for (const suffix of endings) {
      for (const header of [false, true]) {
        check({ text: `\ufeff\r\n${'p'.repeat(offset)}${suffix}`, header }, `boundary ${count++}`);
      }
    }
  }
  for (const input of [
    { text: 0, header: 1 }, { text: undefined, header: true }, { text: null },
    { text: '\r\r\r', header: true }, { text: 'x\r,\r\n\r\r\"text\"', header: true },
    { text: String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)) },
  ]) check(input, `special ${count++}`);
  const huge = { text: `"${'Abcdefgh'.repeat(1 << 18)}\ud83d\ude00",x\n`, header: true };
  check(huge, 'linear-memory growth');
  assert.throws(() => run(huge, () => { throw new Error('sink error'); }), /sink error/);
  check({ text: 'a,\ud800\n', header: false }, 'reuse after throwing sink');
  let copied;
  const copiedInput = { text: 'one,two', header: false };
  run(copiedInput, (bytes) => { copied = Buffer.from(bytes); });
  run(huge);
  assert.equal(copied.toString('utf8'), JSON.stringify(oracle(copiedInput)));
  console.log(`${count} boundary/coercion tests plus memory growth and sink lifetime checks passed`);
} else if (mode === 'fuzz') {
  const shard = Number(shardText);
  assert.ok(Number.isInteger(shard) && shard >= 0 && shard < 3);
  const seed = [0x1571b2d9, 0xcb3a6611, 0x471acd85][shard];
  let state = seed;
  const random = (limit) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  };
  const pick = (xs) => xs[random(xs.length)];
  const alphabet = [',', '"', '\r', '\n', '\r\n', '\ud800', '\udc00', '\udbff', '\udfff',
    '\u0000', '\u0008', '\u000b', '\u001f', '\\', '\t', '\ufeff', '\u00e9', '\u6f22',
    '\u2028', '\ud83d\ude00', ' ', 'abc', '01234567', 'q'.repeat(31)];
  const quoteContent = ['a', '\ud800', '\udc00', '\r', '\r\n', '\n', '\\', ',', '""', 'w'.repeat(24)];
  const chunk = (max, tokens) => Array.from({ length: random(max + 1) }, () => pick(tokens)).join('');
  for (let i = 0; i < 10_000; i++) {
    let text = random(9) === 0 ? '\ufeff' : '';
    if (i % 3 === 0) {
      text += chunk(80, alphabet);
    } else {
      for (let row = random(8); row > 0; row--) {
        const width = random(8);
        const columns = [];
        for (let field = 0; field < width; field++) {
          const kind = random(5);
          let value = kind < 4 ? chunk(10, quoteContent) : chunk(12, alphabet);
          if (kind < 3) value = `"${value}"${kind === 0 ? chunk(5, alphabet) : ''}`;
          if (kind === 3) value = `"${value}`;
          columns.push(value);
        }
        text += columns.join(',') + pick(['\n', '\r\n', '\r\r\n', '\r', '']);
      }
    }
    const input = { text, header: random(2) === 0 };
    try {
      check(input, `shard ${shard} case ${i}`);
    } catch (error) {
      console.error(JSON.stringify({ shard, seed, case: i, input }));
      throw error;
    }
  }
  console.log(`shard=${shard} seed=0x${seed.toString(16)} passed=10000 (object and raw bytes)`);
} else {
  throw new Error('Usage: node tests/differential.mjs edges|fuzz KIT [shard: 0..2]');
}
