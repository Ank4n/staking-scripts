# Fungible migration on Paseo

## Pre-requisites

- Install yarn: `npm install --global yarn`
- Install dependencies: `yarn install`
- Dry run: `yarn run migrate:currency-fungible -e "wss://paseo-rpc.n.dwellir.com" -d true`

## Fungible Migration (Paseo)
- Put the seed phrase for the wallet you wanna use under the env variable `DOT_BOT_MNEMONIC`.
- Transfer 5000 Paseo to this account (without any derivation path).
- Run the migration script: `yarn run migrate:currency-fungible -e "wss://paseo-rpc.n.dwellir.com" --dry false`


## To collect the funds back
- Migration would split funds in multiple accounts derived from the main account. To collect all funds back to the main account use:
`yarn run collect -e "wss://paseo-rpc.n.dwellir.com"`

## Nominator Exposure Report
Check which validators a nominator was exposed to across recent eras (via `ErasStakersPaged`):
```bash
# Check last 84 eras (default)
yarn run nominator:exposure -e "wss://polkadot-asset-hub-rpc.polkadot.io" -a "<nominator_ss58>"

# Check last N eras
yarn run nominator:exposure -e "wss://polkadot-asset-hub-rpc.polkadot.io" -a "<>" --eras 4
```

## Investigate VoterList
Find nominators/validators missing from VoterList (for debugging `wrong external count` try-state errors):
```bash
# Latest state
yarn run investigate:voterlist -e "wss://polkadot-asset-hub-rpc.polkadot.io"

# At specific block
yarn run investigate:voterlist -e "wss://polkadot-asset-hub-rpc.polkadot.io" -b 10846883
```
