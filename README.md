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
