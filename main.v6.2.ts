// main.v6.ts — driver for the v6 raw buffer-to-buffer parser.
// Reads cases.json ONCE as a raw Buffer (no 'utf8', no JSON.parse),
// runs the fused parser, writes the output Buffer directly.
// Flag: --max-semi-space-size=128 only (G1), no --no-incremental-marking.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--max-semi-space-size=128');

const { runCases } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  runCases: (inBuf: Buffer, outBuf: Buffer) => { outPos: number; fallbackCases: number };
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const inBuf = readFileSync(join(INPUT_DIR, 'cases.json'));
const outBuf = Buffer.allocUnsafe(48 * 1024 * 1024);
const { outPos, fallbackCases } = runCases(inBuf, outBuf);
writeFileSync(join(OUTPUT_DIR, 'answers.json'), outBuf.subarray(0, outPos));
