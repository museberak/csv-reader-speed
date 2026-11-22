# Fast CSV reader

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![Rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/museberak/csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![Reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/museberak/csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's own csv-reader 1.0.0, entered in
[Read broken CSV files faster, 21 November 2026](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
on [make.fun](https://make.fun).

`solve.js` is a dependency-free ES module whose `run(input)` returns exactly
what csv-reader 1.0.0 returns for every input — same columns, rows and errors
for quoted fields, doubled quotes, CRLF and lone CR, stray CR, unterminated
quotes, short and long rows — using an indexOf/slice-based single pass instead
of the reference's per-character loop. `main.ts` is the house driver, kept
as-is: it reads `/input/cases.json` and writes `/output/answers.json`.

Practice set: 6/6 answers byte-exact vs the reference and the kit's
expected output; 6,088 differential fuzz cases, 0 mismatches. Speed in fresh
processes (median of 5 runs, net of a do-nothing control): 0.298 s vs the
house baseline's 1.206 s — about 4.05x faster.

Run: `node main.ts` (Node 22; `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR`
override `/input` and `/output` outside the grader container).

License: MIT.
