# png-squeeze

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Bangzo1708/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Bangzo1708/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG optimizer that squeezes screenshots into the smallest possible PNG. It re-encodes each input with a tuned pipeline — optimal filter selection, zlib level and strategy search, palette reduction where lossless, and removal of non-essential metadata — and writes the smallest byte-identical-pixels result.

Practice score: 701.280 vs baseline 420.399.

## Run it

```sh
node main.ts
```

`main.ts` (Node 22, standard library only) reads the screenshots from the input directory and writes the squeezed PNGs to the output directory. The output is deterministic: same input, same bytes, every run.

## Entry

- Competition: [png-squeeze-01-run-20261127](https://make.fun/bounty/png-squeeze-01-run-20261127) — "Squeeze screenshots into the smallest PNG"
- Owner: Bangzo1708
- Referral: https://make.fun/r/dkj7ja9h (referral_code: dkj7ja9h)

---

<sub>Entered on [make.fun](https://make.fun/?ref=dkj7ja9h&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
