// Investigation script for "wrong external count" try-state check failure
// Checks: VoterList.count() == Nominators.count() + Validators.count()
//
// Usage:
//   yarn run investigate:voterlist -e "wss://kusama-asset-hub-rpc.polkadot.io"
//   yarn run investigate:voterlist -e "wss://polkadot-asset-hub-rpc.polkadot.io"

import '@polkadot/api-augment';
import '@polkadot/types-augment';
import { ApiPromise, WsProvider } from '@polkadot/api';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const optionsPromise = yargs(hideBin(process.argv))
	.option('endpoint', {
		alias: 'e',
		type: 'string',
		default: 'wss://kusama-asset-hub-rpc.polkadot.io',
		description: 'the wss endpoint',
		demandOption: true
	})
	.option('block', {
		alias: 'b',
		type: 'string',
		description: 'block number or hash to query at (optional, defaults to latest)'
	}).argv;

async function main() {
	const options = await optionsPromise;
	const provider = new WsProvider(options.endpoint);
	const api = await ApiPromise.create({ provider });

	const chain = (await api.rpc.system.chain()).toHuman();
	const version = (await api.rpc.state.getRuntimeVersion()).specVersion.toNumber();
	console.log(`Connected to: ${chain} (runtime v${version})`);

	// Get block hash if specified
	let blockHash: string | undefined;
	if (options.block) {
		if (options.block.startsWith('0x')) {
			blockHash = options.block;
		} else {
			blockHash = (await api.rpc.chain.getBlockHash(parseInt(options.block))).toString();
		}
		console.log(`Querying at block: ${options.block} (${blockHash})`);
	}

	// Use apiAt for historical queries if block specified
	const apiAt = blockHash ? await api.at(blockHash) : api;

	// Fetch all keys in parallel
	console.log('\nFetching storage keys...');
	const [voterListKeys, nominatorKeys, validatorKeys] = await Promise.all([
		apiAt.query.voterList.listNodes.keys(),
		apiAt.query.staking.nominators.keys(),
		apiAt.query.staking.validators.keys()
	]);

	// Build account sets
	const voterListAccounts = new Set(voterListKeys.map((k) => k.args[0].toString()));
	const nominatorAccounts = new Set(nominatorKeys.map((k) => k.args[0].toString()));
	const validatorAccounts = new Set(validatorKeys.map((k) => k.args[0].toString()));
	const expectedVoters = new Set([...nominatorAccounts, ...validatorAccounts]);

	// Print counts
	console.log(`\n=== Counts ===`);
	console.log(`VoterList:              ${voterListAccounts.size}`);
	console.log(`Nominators:             ${nominatorAccounts.size}`);
	console.log(`Validators:             ${validatorAccounts.size}`);
	console.log(`Nominators + Validators: ${expectedVoters.size}`);
	console.log(`Difference:             ${voterListAccounts.size - expectedVoters.size}`);

	// Find mismatches
	const missingFromVoterList = [...expectedVoters].filter((a) => !voterListAccounts.has(a));
	const extraInVoterList = [...voterListAccounts].filter((a) => !expectedVoters.has(a));

	if (missingFromVoterList.length === 0 && extraInVoterList.length === 0) {
		console.log('\n✅ All accounts match!');
		process.exit(0);
	}

	console.log(`\n❌ Mismatch detected!`);
	console.log(`  Missing from VoterList: ${missingFromVoterList.length}`);
	console.log(`  Extra in VoterList:     ${extraInVoterList.length}`);

	// Show details for missing accounts
	if (missingFromVoterList.length > 0) {
		console.log(`\n=== Accounts missing from VoterList ===`);
		for (const account of missingFromVoterList) {
			const isNominator = nominatorAccounts.has(account);
			const isValidator = validatorAccounts.has(account);
			const role = isValidator ? 'Validator' : 'Nominator';

			const bonded = await apiAt.query.staking.bonded(account);
			const controller = bonded.isSome ? bonded.unwrap().toString() : 'None';
			const sameController = controller === account;

			let stake = 'N/A';
			if (bonded.isSome) {
				const ledger = await apiAt.query.staking.ledger(bonded.unwrap());
				if (ledger.isSome) {
					stake = ledger.unwrap().active.toString();
				}
			}

			console.log(`\n  ${account}`);
			console.log(`    Role: ${role}, Stake: ${stake}`);
			console.log(`    Controller: ${sameController ? 'same as stash' : controller}`);
		}
	}

	// Show details for extra accounts
	if (extraInVoterList.length > 0) {
		console.log(`\n=== Extra accounts in VoterList (not nominator/validator) ===`);
		for (const account of extraInVoterList.slice(0, 10)) {
			const bonded = await apiAt.query.staking.bonded(account);
			console.log(`\n  ${account}`);
			console.log(`    Bonded: ${bonded.isSome}`);
		}
		if (extraInVoterList.length > 10) {
			console.log(`  ... and ${extraInVoterList.length - 10} more`);
		}
	}

	console.log('\n=== Done ===');
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
