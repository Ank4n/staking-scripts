// Bucket all validators by their self-stake.
//
// "Self stake" here is a validator's own bonded amount (the validator's own
// stash stake, i.e. ledger.active for the validator's controller/stash). We
// iterate over the current validator set (staking.validators keys), read each
// validator's ledger, and bucket the self-stake into ranges:
//
//   > 30k
//   10k - 30k
//   9k  - 10k
//   5k  - 9k
//   > 0 and < 5k
//   0
//
// Buckets are expressed in whole tokens (using the chain's token decimals).
//
// NOTE: staking lives on Asset Hub, not the relay chain — point -e at an
// Asset Hub RPC (e.g. westend/polkadot/kusama-asset-hub-rpc.polkadot.io).
//
// Usage:
//   yarn run validator:self-stake -e "wss://westend-asset-hub-rpc.polkadot.io"
//   yarn run validator:self-stake -e "wss://polkadot-asset-hub-rpc.polkadot.io" --list

import '@polkadot/api-augment';
import '@polkadot/types-augment';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { BN } from '@polkadot/util';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const optionsPromise = yargs(hideBin(process.argv))
	.option('endpoint', {
		alias: 'e',
		type: 'string',
		default: 'wss://westend-asset-hub-rpc.polkadot.io',
		description: 'the wss endpoint (Asset Hub — staking is not on the relay chain)',
		demandOption: true
	})
	.option('list', {
		type: 'boolean',
		default: false,
		description: 'also list each validator and its self-stake per bucket'
	}).argv;

// Bucket definitions in whole tokens. Order matters: first matching bucket wins.
// Boundaries chosen to match the requested ranges; lower bound inclusive,
// upper bound exclusive (except the open-ended top bucket).
const BUCKETS: { label: string; test: (tokens: number) => boolean }[] = [
	{ label: '> 30k', test: (t) => t > 30_000 },
	{ label: '10k - 30k', test: (t) => t >= 10_000 && t <= 30_000 },
	{ label: '9k - 10k', test: (t) => t >= 9_000 && t < 10_000 },
	{ label: '5k - 9k', test: (t) => t >= 5_000 && t < 9_000 },
	{ label: '> 0 and < 5k', test: (t) => t > 0 && t < 5_000 },
	{ label: '0', test: (t) => t === 0 }
];

async function main() {
	const options = await optionsPromise;
	const provider = new WsProvider(options.endpoint);
	const api = await ApiPromise.create({ provider });

	const chain = (await api.rpc.system.chain()).toHuman();
	const version = (await api.rpc.state.getRuntimeVersion()).specVersion.toNumber();
	const decimals = api.registry.chainDecimals[0];
	const tokenSymbol = api.registry.chainTokens[0];
	const unit = new BN(10).pow(new BN(decimals));
	console.log(`Connected to: ${chain} (runtime v${version}), token: ${tokenSymbol} (${decimals} decimals)`);

	// Fetch the full validator set.
	const validatorEntries = await api.query.staking.validators.entries();
	const validators = validatorEntries.map(([key]) => key.args[0].toString());
	console.log(`\nFound ${validators.length} validators. Reading self-stake...\n`);

	// Bucket -> list of { validator, tokens }
	const bucketed: Map<string, { validator: string; tokens: number }[]> = new Map();
	for (const b of BUCKETS) bucketed.set(b.label, []);
	const unbucketed: { validator: string; tokens: number }[] = [];

	let processed = 0;
	for (const validator of validators) {
		// A validator's stash is also (usually) its own ledger stash in modern
		// staking. Resolve controller for safety, then read the ledger.
		const controllerOpt = await api.query.staking.bonded(validator);
		let selfStake = new BN(0);

		if (controllerOpt.isSome) {
			const controller = controllerOpt.unwrap().toString();
			const ledgerOpt = await api.query.staking.ledger(controller);
			if (ledgerOpt.isSome) {
				selfStake = ledgerOpt.unwrap().active.toBn();
			}
		}

		// Convert to whole tokens (floor) for bucketing.
		const tokens = selfStake.div(unit).toNumber();

		const matched = BUCKETS.find((b) => b.test(tokens));
		if (matched) {
			bucketed.get(matched.label)!.push({ validator, tokens });
		} else {
			unbucketed.push({ validator, tokens });
		}

		processed++;
		if (processed % 50 === 0) {
			process.stdout.write(`  ...processed ${processed}/${validators.length}\n`);
		}
	}

	// Print summary table.
	console.log(`\n${'='.repeat(60)}`);
	console.log(`VALIDATOR SELF-STAKE DISTRIBUTION (${tokenSymbol})`);
	console.log(`${'='.repeat(60)}`);
	console.log(`${'Bucket'.padEnd(20)} ${'Count'.padStart(8)} ${'%'.padStart(8)}`);
	console.log(`${'-'.repeat(60)}`);

	const total = validators.length;
	for (const b of BUCKETS) {
		const count = bucketed.get(b.label)!.length;
		const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
		console.log(`${b.label.padEnd(20)} ${String(count).padStart(8)} ${(pct + '%').padStart(8)}`);
	}
	console.log(`${'-'.repeat(60)}`);
	console.log(`${'TOTAL'.padEnd(20)} ${String(total).padStart(8)}`);

	if (unbucketed.length > 0) {
		console.log(`\n⚠️  ${unbucketed.length} validator(s) did not match any bucket (unexpected).`);
	}

	if (options.list) {
		console.log(`\n${'='.repeat(60)}`);
		console.log('PER-VALIDATOR BREAKDOWN');
		console.log(`${'='.repeat(60)}`);
		for (const b of BUCKETS) {
			const entries = bucketed.get(b.label)!.sort((x, y) => y.tokens - x.tokens);
			console.log(`\n[${b.label}] (${entries.length})`);
			for (const { validator, tokens } of entries) {
				console.log(`  ${validator}  ${tokens.toLocaleString()} ${tokenSymbol}`);
			}
		}
	}

	console.log();
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
