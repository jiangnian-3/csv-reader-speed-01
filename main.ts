import { Buffer } from 'node:buffer';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');
const { run } = await import('./solve.js');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const fd = openSync(join(outputDir, 'answers.json'), 'w');
const opening = Buffer.from('[');
const separator = Buffer.from(',');
const closing = Buffer.from(']');
const maxWrite = 65536;

function writeAll(bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, Math.min(maxWrite, bytes.length - offset));
    if (written === 0) throw new Error('Output write made no progress');
    offset += written;
  }
}

try {
  writeAll(opening);
  for (let i = 0; i < cases.length; i++) {
    if (i !== 0) writeAll(separator);
    run(cases[i].input, writeAll);
  }
  writeAll(closing);
} finally {
  closeSync(fd);
}
