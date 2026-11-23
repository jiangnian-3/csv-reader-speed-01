# CSV SIMD-WASM v10 (local experiment)

[![Competition](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![Rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/jiangnian-3/csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![Reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/jiangnian-3/csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

This is not a competition entry. The event rules forbid WASM. There is no submission, packaging, JS fallback, or compilation at Node startup. The WASM file is a normal local build product in `target/`.

From this directory with Rust's `wasm32-unknown-unknown` target already installed:

```sh
PATH="$HOME/.cargo/bin:$PATH" cargo build --offline --locked --release
```

Cargo enables `simd128`, release optimization, fat LTO, and abort-on-panic. `main.ts` uses Node's built-in outer JSON parser and writes one complete JSON array. It defaults to `/input/cases.json` and `/output/answers.json`; `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` select directories for local runs. Create the output directory first.

`run({ text, header })` returns `{columns, rows, errors}`. `run(input, callback)` writes the same answer through a synchronous borrowed byte view; consume or copy it before callback return or reentrant parsing. This is not the v3 parser-event sink. The host creates one module instance. Input and output allocations are owned by individual calls and released via the raw ABI, even if the callback throws. Linear memory is retained by the instance but the contents are not used to cache results.

The Rust parser has one state machine. It uses eight UTF-16 lanes to locate record and field candidates, with scalar state transitions at hits and the end. The byte emitter writes compact JSON, retaining lone surrogates and joining valid pairs even if they span discarded syntax.

## Reproduce local evidence

With the published kit in its sibling workspace location, build first and then run:

```sh
python3 tests/practice.py check ../../results/v10-local-check
python3 tests/practice.py time ../../results/v10-local-time
```

The check command runs the kit's unmodified scorer against the practice input/reference and verifies serial/parallel scores, two byte-identical executions, byte equality with clean v3, twelve edge cases, and 30,000 seeded differential cases. The timing command must run separately, without concurrent checks or build processes. It uses CPU 0 and records complete-process CPU time, wall time and peak RSS with the same input and null control as v3.

The kit CLI snapshots tracked and unignored worktree files before launching its process driver. The generated `.wasm` is intentionally unignored and visible in this local-only snapshot so the full kit scorer can execute the candidate. This is an ephemeral grade-local test snapshot, not a competition bundle; do not submit or upload it. The competition rules prohibit WASM.
