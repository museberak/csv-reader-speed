// csv-reader 1.0.0, the house entry, make.fun's own reference program: the harness runs `node /bot/main.ts` (node22). It reads every case from /input/cases.json (a JSON
// array of {id, input}), answers each one alone with run() from solve.js, and writes /output/answers.json: a JSON
// array of the answers, one per case and in the cases' order. An entry keeps this driver and replaces solve.js with a
// faster module whose run(input) returns the same answer for every input. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// RECOMMENDED RESUBMIT VARIANT (22 Nov 2026): identical to main.ts except the
// V8 flags. Pooled bench (46 rounds, interleaved, fresh process, net of
// do-nothing control): `--no-incremental-marking --max-semi-space-size=128`
// is the fastest measured combination: gross median ~732-736k us, net
// ~547-550k us, -4.6% to -5.0% vs the `--no-incremental-marking` baseline,
// consistent in both batches it was measured in (n=20). The --no-lazy gain
// (-2.7%, n=46) does NOT stack with semi128 (combination -0.8%, inconsistent
// across batches), so it is deliberately NOT included here.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off + a 128 MB semi-space, set before solve.js is
// imported so all of its work runs under it (the rules: the house baseline
// runs with --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking --max-semi-space-size=128');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
