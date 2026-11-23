import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

const artifact = new URL('./target/wasm32-unknown-unknown/release/csv_wasm_local.wasm', import.meta.url);
const module = new WebAssembly.Module(readFileSync(artifact));
const { memory, alloc_input, free_input, run_csv, free_output } = new WebAssembly.Instance(module).exports;
const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Without a sink, return the public answer object. With a sink, call it once
 * with the borrowed UTF-8 JSON value. The sink must consume or copy the view
 * synchronously, before returning or reentering run (which can grow memory).
 */
export function run(input, rawAnswerSink) {
  const text = String(input.text);
  const header = input.header === true;
  const length = text.length;
  const inputPtr = alloc_input(length) >>> 0;
  let result;
  try {
    const byteLength = length * 2;
    const view = Buffer.from(memory.buffer, inputPtr, byteLength);
    if (view.write(text, 0, byteLength, 'utf16le') !== byteLength) {
      throw new Error('Incomplete UTF-16LE input copy');
    }
    result = run_csv(inputPtr, length, header ? 1 : 0);
  } finally {
    free_input(inputPtr, length);
  }
  const ptr = Number(result & 0xffffffffn);
  const size = Number(result >> 32n) >>> 0;
  try {
    // run_csv can grow linear memory, so refresh the buffer before reading it.
    const bytes = new Uint8Array(memory.buffer, ptr, size);
    if (rawAnswerSink !== undefined) {
      rawAnswerSink(bytes);
      return;
    }
    return JSON.parse(decoder.decode(bytes));
  } finally {
    free_output(ptr, size);
  }
}
