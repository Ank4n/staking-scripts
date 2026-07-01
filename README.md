# pool-scripts

A collection of operational and forensic scripts for Polkadot / Kusama / Westend
and their **Asset Hub** chains, built on [`@polkadot/api`](https://github.com/polkadot-js/api)
and run via `ts-node`. Each script lives in `src/` and is exposed as a
`yarn run <name>` entry.

Coverage spans staking/nomination diagnostics, currency & virtual-staker
migration helpers, and generic block-history forensics.

> ⚠️ **Staking lives on Asset Hub, not the relay chain.**
> After the Asset Hub Migration, the `staking`, `nominationPools`, `voterList`
> (bags-list) and multi-block-election pallets moved off the relay chain. Point
> any staking/nomination/validator/election query at an **Asset Hub** endpoint:
> - Polkadot: `wss://polkadot-asset-hub-rpc.polkadot.io`
> - Kusama: `wss://kusama-asset-hub-rpc.polkadot.io`
> - Westend: `wss://westend-asset-hub-rpc.polkadot.io`
>
> For historical (archived) state, use a Dwellir archive node, e.g.
> `wss://asset-hub-polkadot-rpc.n.dwellir.com`.

## Prerequisites

- Install yarn: `npm install --global yarn`
- Install dependencies: `yarn install`

Every script takes a `--endpoint` / `-e` wss option. Migration/transacting
scripts also default to **dry-run** (`--dry true`) and expect an unsafe-RPC node.

## Conventions

- `-e` / `--endpoint`: the wss endpoint. Defaults vary per script; staking
  scripts should be pointed at an Asset Hub endpoint (see caveat above).
- `-d` / `--dry`: transacting scripts default to `true` (no transactions sent).
  Pass `--dry false` to actually submit.
- The mnemonic for the transacting account is read from `DOT_BOT_MNEMONIC`.

---

## Migration & funds

### Fungible currency migration
Migrates balances by fanning funds out across derived accounts.

```bash
# Dry run
yarn run migrate:currency-fungible -e "wss://paseo-rpc.n.dwellir.com" -d true

# Real run — fund the account (~5000 tokens, no derivation path) and set DOT_BOT_MNEMONIC first
yarn run migrate:currency-fungible -e "wss://paseo-rpc.n.dwellir.com" --dry false
```
Options: `-s`/`--start_from` (resume from an index), `-f`/`--first_seed`.

### Collect funds back
The migration splits funds across accounts derived from the main account. To
sweep them all back:

```bash
yarn run collect -e "wss://paseo-rpc.n.dwellir.com"
```

### Virtual stakers migration
Migrates virtual (pool/agent) stakers. Requires an unsafe-RPC node.

```bash
yarn run migrate:virtual-stakers -e "<wss>" -d true
```
Options: `-s`/`--start_from`, `-f`/`--first_seed`.

---

## Staking / nomination diagnostics

### Validator self-stake distribution
Buckets validators by their own bonded (self) stake.

```bash
yarn run validator:self-stake -e "wss://polkadot-asset-hub-rpc.polkadot.io"
# also list each validator per bucket:
yarn run validator:self-stake -e "wss://polkadot-asset-hub-rpc.polkadot.io" --list
```

### Nominator exposure report
Which validators a nominator was exposed to across recent eras (via
`ErasStakersPaged`).

```bash
# Last 84 eras (default)
yarn run nominator:exposure -e "wss://polkadot-asset-hub-rpc.polkadot.io" -a "<nominator_ss58>"

# Last N eras
yarn run nominator:exposure -e "wss://polkadot-asset-hub-rpc.polkadot.io" -a "<nominator_ss58>" --eras 4
```

### Investigate VoterList
Finds nominators/validators missing from `VoterList` — useful for debugging
`wrong external count` try-state failures
(`VoterList.count() == Nominators.count() + Validators.count()`).

```bash
# Latest state
yarn run investigate:voterlist -e "wss://polkadot-asset-hub-rpc.polkadot.io"

# At a specific block (number or hash)
yarn run investigate:voterlist -e "wss://polkadot-asset-hub-rpc.polkadot.io" -b 10846883
```

### Provider/consumer health
Checks account provider/consumer reference counters.

```bash
yarn run health:provider-consumer -e "<wss>"
```

---

## Block-history forensics

### Generic block bisection
Binary-search for the **first block where a predicate flips `false → true`**.
The match condition is pluggable — pick a built-in with `--condition`, or add
your own to the `CONDITIONS` registry in `src/bisect-block.ts`.

```bash
# List built-in conditions
yarn run bisect --list-conditions

# Find when a Plain storage item became empty (0x00) or absent
yarn run bisect -c storage-empty \
  --arg pallet=MultiBlockElectionSigned --arg item=Invulnerables \
  --lo 10267894

# Locate a runtime upgrade (first block with specVersion >= N)
yarn run bisect -c spec-at-least --arg spec=2003000 --lo 1 --hi 17000000
```
Options: `-e`/`--endpoint` (defaults to a Dwellir archive), `-c`/`--condition`,
`--arg key=value` (repeatable, per-condition params), `--lo` (required; condition
expected **false** here), `--hi` (defaults to head; condition expected **true**).

Built-in conditions: `storage-empty`, `storage-equals`, `spec-at-least`, and
`inv-empty` (a convenience alias for `multiBlockElectionSigned.invulnerables`).

> The search assumes a **single monotonic transition** in `[lo, hi]`. For a
> value that toggles, it returns *a* transition — bracket `lo`/`hi` around the
> region you care about.

### Invulnerables-empty finder
A purpose-built version of the above that locates the block where
`multiBlockElectionSigned.invulnerables` became empty on Polkadot Asset Hub,
reading raw storage so it is independent of the block's metadata.

```bash
yarn run find:inv-empty
yarn run find:inv-empty -e "wss://asset-hub-polkadot-rpc.n.dwellir.com" --lo 10267894
```
