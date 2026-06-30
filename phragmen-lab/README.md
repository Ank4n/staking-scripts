# phragmen-lab

A local, offline playground for the Polkadot **multi-block election** (EPMB). It replays
an election round from a dumped snapshot and runs the same sequential-phragmén +
balancing + scoring the runtime uses (minus the chain's post-solve _trimming_ — see
[Fidelity / caveats](#fidelity--caveats)), so you can ask _what-if_ questions — "would
electing fewer validators make this solution pass?", "what if `minimumScore` were
lower?" — in seconds, without touching a node.

It links the real solver crate (`sp-npos-elections`, the same one the runtime and the
staking-miner use), so the scores it computes are directly comparable to what the chain
computes and validates against.

---

## Why this exists

On Asset Hub, staking elections run over many blocks (EPMB). A signed solution is
**rejected** if its `ElectionScore` is not `strict_better` than the on-chain
`minimumScore`. When that happens there's nothing useful left on chain (the verifier
never stores per-validator backings for a solution that fails the score gate), so you
can't just read the answer back.

Instead this tool reconstructs the election from its **input** — the voter and target
snapshots the round actually ran over — and re-derives the score locally. From there,
the inputs (`desiredTargets`, `minimumScore`, balancing config) become plain knobs you
can change and re-run.

---

## How scoring / rejection works

`ElectionScore` has three fields (all in planck):

| field               | meaning                                                        | better is |
| ------------------- | ------------------------------------------------------------- | --------- |
| `minimal_stake`     | backing of the **weakest** elected validator                  | higher    |
| `sum_stake`         | total stake distributed across winners (≈ total active stake) | higher    |
| `sum_stake_squared` | Σ(backing²) — measures evenness of the distribution           | lower     |

The gate is `score.strict_better(minimumScore)`, which is **lexicographic** in order of
significance: `minimal_stake` ↑, then `sum_stake` ↑, then `sum_stake_squared` ↓.

In practice an exact tie on `minimal_stake` never happens, so the gate reduces to:

> **`minimal_stake > minimumScore.minimal_stake`**

i.e. the whole pass/fail decision is usually driven by the weakest winner's backing.
(Source: `pallet-election-provider-multi-block` verifier `ensure_score_quality` →
`FeasibilityError::ScoreTooLow`.)

This tool prints all three components but decides pass/fail with the real lexicographic
rule.

---

## Prerequisites

- Rust toolchain (`cargo`, `rustc`). Any recent stable works.
- A snapshot JSON dumped from the chain (see below).

---

## Step 1 — dump a snapshot (from the repo root, not here)

The dumper is a TypeScript script in the parent project. It must be run while the
election round you care about is **live** on chain (the snapshot only exists during the
Snapshot/Signed/SignedValidation phases of a round — it's cleared afterwards).

```bash
# from the pool-scripts repo root
yarn run dump:snapshot \
  -e wss://polkadot-asset-hub-rpc.polkadot.io \
  -b 17631723 \
  -o phragmen-lab/snapshot-238.json
```

Flags: `-e` endpoint (Asset Hub), `-b` block number or hash, `-o` output path,
`-r` round override (defaults to the round at that block).

The output (~13 MB) contains the candidate list, every voter as
`(account, stake, [targets])`, plus the on-chain `desiredTargets` and `minimumScore`.
It is fully self-contained — no node needed after this.

> Tip: write it _into_ `phragmen-lab/` (as above) so it lives next to the tool. Snapshot
> files are git-ignored by default; commit one only if you want to preserve a specific
> round.

## Step 2 — build

```bash
cd phragmen-lab
cargo build --release
```

The first build pulls the substrate crates and takes a minute or two; afterwards it's
instant.

## Step 3 — run

```bash
# score the round at its on-chain desiredTargets and check the gate
./target/release/phragmen-lab --snapshot snapshot-238.json
```

---

## Usage / flags

```
--snapshot <PATH>          (required) snapshot JSON from `yarn run dump:snapshot`
--desired-targets <N>      elect N validators (default: snapshot's on-chain desiredTargets)
--min-score-stake <TOKENS> override the minimal_stake floor, in WHOLE tokens (e.g. 700000)
--iterations <N>           balancing iterations (default 10, matches runtime)
--tolerance <N>            balancing tolerance (default 0, matches runtime)
--sweep <FROM> <TO>        sweep desired-targets from FROM down to TO (step 10), tabular output
```

### Examples

Score a specific target count:

```bash
./target/release/phragmen-lab --snapshot snapshot-238.json --desired-targets 550
```

Sweep a range to find where the solution starts passing:

```bash
./target/release/phragmen-lab --snapshot snapshot-238.json --sweep 600 500
```

Test a hypothetical lower `minimumScore` floor (e.g. would governance lowering it help?):

```bash
./target/release/phragmen-lab --snapshot snapshot-238.json --min-score-stake 650000
```

Match a different balancing depth:

```bash
./target/release/phragmen-lab --snapshot snapshot-238.json --iterations 20
```

---

## Reading the output

Single run shows the computed score, a per-component comparison against the threshold,
and the final lexicographic verdict:

```
=== Result (desired_targets = 550) ===
  minimal_stake     : 1,149,499.0770 DOT
  sum_stake         : 809,839,480.9661 DOT
  sum_stake_squared : 122186709403440325083244402324560389

  vs minimumScore (lexicographic strict_better):
    minimal_stake     >= (ok) 789,555.2765 DOT
    sum_stake         >= (ok) 565,583,855.1978 DOT
    sum_stake_squared <  (ok) 187148285683372481445131595645808873 (lower is better)

  FULL SCORE: PASS ✅ (strict_better than minimumScore)
```

Sweep prints one row per target count with a `strict_better?` column — the cheapest way
to find the crossing point.

---

## Worked example: round 238

Round 238's signed solution was rejected. Running the lab on its snapshot:

| desired_targets | minimal_stake | full score passes? |
| --------------- | ------------- | ------------------ |
| 600 (on-chain)  | 675,220 DOT   | ❌ no              |
| 590             | 765,382 DOT   | ❌ no              |
| 580             | 770,013 DOT   | ❌ no (just short) |
| **570**         | 893,348 DOT   | ✅ **yes**        |
| 550             | 1,149,499 DOT | ✅ yes (~46% over) |
| 500             | 1,320,000 DOT | ✅ yes            |

The floor is `789,555 DOT`. The rejection is entirely a `minimal_stake` problem — the
other two components pass at every target count. Electing fewer validators redistributes
stake onto the survivors, lifting the weakest winner's backing above the floor. The
crossing sits between 580 (fail) and 570 (pass); 550 clears it comfortably.

Notice `sum_stake` barely moves across the whole range (~811M → ~805M) while
`minimal_stake` nearly doubles — the fix is about _distribution_, not the size of the
staking pie.

---

## Fidelity / caveats

- The solver is `sp-npos-elections` 42.0.0 (deps pin `sp-arithmetic` 28.0.1) — the same
  crate family the runtime uses. The pipeline is
  `seq_phragmen` → `assignment_ratio_to_staked_normalized` → `to_supports` →
  `evaluate_support`, with `BalancingConfig { iterations: 10, tolerance: 0 }`. This
  mirrors the runtime miner (`election-provider-multi-block/src/unsigned/miner.rs`):
  EPMB flattens all voter pages and runs `seq_phragmen` **once** over every voter (it is
  *not* a per-page solve), exactly as the lab does. The accuracy type is `Perbill` and
  the chain feeds raw planck as the `VoteWeight` (Polkadot/Westend use
  `SaturatingCurrencyToVote`, which does no scaling); the lab saturates that planck →
  `u64` the same way the chain does.

- **The score the lab computes is the chain's _pre-trim_ score** — an upper bound on the
  real `minimal_stake`. The runtime, after solving, applies several trimming passes
  before scoring: a global `MaxBackersPerWinner` truncation (`sorted_truncate_from`), a
  per-page backer trim, and a length/weight trim. Trimming drops the weakest backers and
  can therefore only **lower** a winner's backing — so the on-chain `minimal_stake` may
  come out somewhat below what the lab reports. The lab does **not** model trimming. For
  finding the `desired_targets` pass/fail crossing this is fine (it shifts the crossing
  conservatively), but don't read the absolute `minimal_stake` as bit-exact.

- Validated against round 238: the lab reproduces the on-chain `sum_stake` and
  `sum_stake_squared` closely; `minimal_stake` lands within ~1% (balancing is
  iteration-sensitive, and the chain's trimming further lowers it). Conclusions about
  pass/fail crossings are robust to that wobble.

- The gate the lab checks is `score.strict_better(minimumScore)`. On chain a solution
  must *also* be `strict_better` than any already-**queued** solution
  (`ensure_score_quality` checks both); the lab only models the `minimumScore` floor,
  since that's the governance knob you tweak in what-ifs.

- `reduce()` is deliberately omitted: it is support-preserving, so it does not change the
  score. (The chain calls it for solution size, not score.)

- If you need bit-exact reproduction of a particular submission, match the
  `--iterations`/`--tolerance` to the config the miner used for that solution.
- The candidate identifier used internally is the candidate's **index** in the snapshot
  (not the SS58 string), purely for solver speed. The snapshot keeps the SS58 list if you
  need to map indices back to accounts.

---

## Files

- `Cargo.toml` — pins the solver crates.
- `src/main.rs` — the harness (snapshot parsing, solver invocation, scoring, gate check).
- `snapshot-*.json` — dumped election inputs (git-ignored; produce with
  `yarn run dump:snapshot`).
