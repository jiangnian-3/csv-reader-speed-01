import assert from 'node:assert/strict';
import { run } from '../solve.js';

const cases = [
  {
    name: 'BOM and header',
    input: { text: '\uFEFFa,b\r\n1,2\r\n', header: true },
    expected: { columns: ['a', 'b'], rows: [['1', '2']], errors: [] },
  },
  {
    name: 'blank records',
    input: { text: '\n\r\nA\n\nB', header: false },
    expected: { columns: null, rows: [['A'], ['B']], errors: [] },
  },
  {
    name: 'stray CR is dropped',
    input: { text: 'A\rB,C\r\n', header: false },
    expected: {
      columns: null,
      rows: [['AB', 'C']],
      errors: [{ code: 'stray_cr', line: 1, row: 0 }],
    },
  },
  {
    name: 'quoted line endings normalize to LF',
    input: { text: '"a\r\nb\rc\n",x\r\n', header: false },
    expected: { columns: null, rows: [['a\nb\nc\n', 'x']], errors: [] },
  },
  {
    name: 'escaped quote and quote junk',
    input: { text: '"a""b" kg,tail\n', header: false },
    expected: {
      columns: null,
      rows: [['a"b kg', 'tail']],
      errors: [{ code: 'quote_junk', line: 1, row: 0 }],
    },
  },
  {
    name: 'unterminated quote falls back to unquoted parsing',
    input: { text: '"open,tail\nnext,row\n', header: false },
    expected: {
      columns: null,
      rows: [['"open', 'tail'], ['next', 'row']],
      errors: [{ code: 'unterminated_quote', line: 1, row: 0 }],
    },
  },
  {
    name: 'quote inside unquoted field is literal',
    input: { text: 'a"b,c\n', header: false },
    expected: { columns: null, rows: [['a"b', 'c']], errors: [] },
  },
  {
    name: 'short and long rows use first-record width',
    input: { text: 'a,b,c\n1\n2,3,4,5\n', header: true },
    expected: {
      columns: ['a', 'b', 'c'],
      rows: [['1', '', ''], ['2', '3', '4']],
      errors: [
        { code: 'short_row', line: 2, row: 0, fields: 1 },
        { code: 'long_row', line: 3, row: 1, extra: ['5'] },
      ],
    },
  },
  {
    name: 'stray CR-only blank record',
    input: { text: '\r\r\nA\n', header: false },
    expected: {
      columns: null,
      rows: [['A']],
      errors: [{ code: 'stray_cr', line: 1, row: 0 }],
    },
  },
  {
    name: 'stray CR precedes quote-junk error',
    input: { text: '"a"\rX,z\n', header: false },
    expected: {
      columns: null,
      rows: [['aX', 'z']],
      errors: [
        { code: 'stray_cr', line: 1, row: 0 },
        { code: 'quote_junk', line: 1, row: 0 },
      ],
    },
  },
  {
    name: 'long row line is its start after quoted newlines',
    input: { text: 'a,b\n"x\ny",1,2\n', header: true },
    expected: {
      columns: ['a', 'b'],
      rows: [['x\ny', '1']],
      errors: [{ code: 'long_row', line: 2, row: 0, extra: ['2'] }],
    },
  },
  {
    name: 'trailing comma at EOF and UTF-16 strings',
    input: { text: '\ud800,😀,', header: false },
    expected: { columns: null, rows: [['\ud800', '😀', '']], errors: [] },
  },
];

for (const test of cases) {
  assert.deepEqual(run(test.input), test.expected, test.name);
}

console.log(`${cases.length} edge cases passed`);
