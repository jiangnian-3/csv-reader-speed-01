import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

const { createJsonSink, run } = await import(new URL('./solve.js', import.meta.url).href);
const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const outputFd = openSync(join(outputDir, 'answers.json'), 'w');
const sink = createJsonSink((chunk) => {
  let offset = 0;
  while (offset < chunk.length) {
    offset += writeSync(outputFd, chunk, offset, chunk.length - offset);
  }
});

try {
  sink.beginOutput();
  for (let i = 0; i < cases.length; i += 1) {
    sink.beginCase();
    run(cases[i].input, sink);
  }
  sink.endOutput();
} finally {
  closeSync(outputFd);
}
