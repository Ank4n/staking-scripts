// needed as of 7.x series, see CHANGELOG of the api repo.
import '@polkadot/api-augment';
import '@polkadot/types-augment';
import { u8aToHex, hexToNumber, numberToHex } from '@polkadot/util';
import { ApiPromise, Keyring, WsProvider } from '@polkadot/api';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

/// This script migrates staking ledgers from the old staking currency to the new fungible currency.
/// If a lock with id 'staking ' exists, it will be migrated.

// Delay between repeating transactions from the same account.
const DELAY = 1000;
// Setting it to more than one will batch transactions and they have fees.
const BATCH_SIZE = 10;
// how many transacting accounts to use
const ACCOUNTS_TO_USE = 24;
// balance to top up transacting accounts. This should be at least ED.
// KSM ED = 333,333,333 => 0.0003, Top up: 0.003!
// DOT ED = 10,000,000,000
// Westend ED = 10,000,000,000
// PASEO ED = 10,000,000,000
const TOPUP_BALANCE = 2_000_000_000_000; // 200 Paseo

const optionsPromise = yargs(hideBin(process.argv))
	.option('endpoint', {
		alias: 'e',
		type: 'string',
		default: 'wss://westend-rpc.dwellir.com',
		description: 'the wss endpoint. It must allow unsafe RPCs.',
		demandOption: true
	})
	.option('dry', {
		alias: 'd',
		type: 'boolean',
		default: true,
		description: 'if dry run is enabled, no transactions will be sent.'
	})
	.option('start_from', {
		alias: 's',
		type: 'number',
		default: 0,
		description: 'Start iterating from this index.'
	})
	.option('first_seed', {
		alias: 'f',
		type: 'number',
		default: 0,
		description: 'Use this as the first seed for the transacting account.'
	}).argv;

let toMigrate = 0;
let alreadyMigrated = 0;
let totalToProcess = 0;
let processed = 0;
// report progress every 50 iterations.
const progressStep = 50;
let shift_seed = 0;

const MNEMONIC = process.env.DOT_BOT_MNEMONIC;
const LAST_UNSUPPORTED_VERSION = 1005001;

async function main() {
	const options = await optionsPromise;
	const provider = new WsProvider(options.endpoint);
	const api = await ApiPromise.create({ provider });
	const latest = await api.derive.chain.bestNumber();
	const latest_hash = await api.rpc.chain.getBlockHash(latest);
	const apiAt = await api.at(latest_hash);

	// sr25519 keyring
	const keyring = new Keyring({ type: 'sr25519' });
	const admin = keyring.createFromUri(`${MNEMONIC}`);
	const { data: admin_balance } = await api.query.system.account(admin.address);

	console.log(
		`Using address ${
			admin.address
		} with balance ${admin_balance.free.toNumber()} to migrate the staking ledgers.`
	);

	console.log(`\nParams: 
	\nDelay: ${DELAY / 1000} seconds 
	\nSeeding from: ${options.first_seed} 
	\nAccounts to use: ${ACCOUNTS_TO_USE} 
	\nStarting migration from: ${options.start_from} bonded account index
	\nDry run: ${options.dry}
	\nEndpoint: ${options.endpoint}
	\n`);

	console.log(`Connected to node: **${(await api.rpc.system.chain()).toHuman()}**`);
	shift_seed = options.first_seed;

	// Read ED.
	const ED = api.consts.balances.existentialDeposit;
	console.log(`Existential Deposit: ${ED}`);

	// Top up transacting accounts
	if (!options.dry) {
		await topup_signers(api);
	}

	let txs = [];

	const skipBy = options.start_from;

	// reset counters
	totalToProcess = 0;
	processed = 0;
	toMigrate = 0;
	alreadyMigrated = 0;

	// go over all stakers.
	console.log(`Initiating migration...`);
	const keys = await apiAt.query.staking.bonded.keys();
	totalToProcess = keys.length - skipBy;

	console.log(
		`\n${new Date().toISOString()} :: Starting processing migration for ${totalToProcess} staking ledgers`
	);

	async function waitForRuntimeUpgrade(api: ApiPromise) {
		let latestVersion = (await api.query.system.lastRuntimeUpgrade())
			.unwrap()
			.specVersion.toNumber();
		console.log(
			`Latest Runtime Version: ${latestVersion}, comparing with last known unsupported version ${LAST_UNSUPPORTED_VERSION}`
		);

		while (latestVersion == LAST_UNSUPPORTED_VERSION) {
			console.log(
				`\n${new Date().toISOString()} :: Chain not upgraded yet. Rechecking in 1 minute...`
			);

			// sleep for 1 minute
			await new Promise((resolve) => setTimeout(resolve, 60000));
			latestVersion = (await api.query.system.lastRuntimeUpgrade()).unwrap().specVersion.toNumber();
		}

		console.log(`Runtime upgrade to ${latestVersion} detected! Continuing...`);
	}

	await waitForRuntimeUpgrade(api);

	// check if function api.tx.staking.migrateCurrency exists, else exit.
	if (!api.tx.staking.migrateCurrency) {
		console.error(
			`The function api.tx.staking.migrateCurrency does not exist. Please check the runtime version.`
		);
		process.exit(1);
	}

	for (const key of keys.slice(skipBy)) {
		// print progress
		printProgress('...', true);

		const account = keyring.decodeAddress(key.toHuman()?.toString());
		const account_hex = u8aToHex(account);

		// ensure conditions are matched before invoking the tx.
		const needsMigration =
			(await api.query.balances.locks(account_hex)).filter(
				(lock) => lock.id.toHuman() === 'staking '
			).length >= 1;

		const isPoolAccount = (await api.query.staking.virtualStakers(account_hex)).isSome;

		if (needsMigration && !isPoolAccount) {
			if (!options.dry) {
				const migrate = api.tx.staking.migrateCurrency(account);
				txs.push(migrate);
			}
			toMigrate++;
		} else {
			alreadyMigrated++;
		}

		processed++;

		// batch tx if queue is full.
		if (txs.length >= BATCH_SIZE) {
			await batch_send(api, txs);
			// printProgress(
			// 	`Dispatched ${txs.length} transactions. Waiting for ${DELAY / 1000} seconds.`,
			// 	true
			// );
			// wait for 6 seconds
			await new Promise((f) => setTimeout(f, DELAY));
			// clear txns.
			txs = [];
		}
	}

	console.log(`Summary: to migrate: ${toMigrate} | already migrated: ${alreadyMigrated}`);
	process.exit(0);
}

main().catch(console.error);

async function batch_send(api: ApiPromise, txs: any[]) {
	const keyring = new Keyring({ type: 'sr25519' });
	const seed = ((toMigrate / BATCH_SIZE) % ACCOUNTS_TO_USE) + shift_seed;
	const signer = keyring.addFromUri(`${MNEMONIC}//${seed}`);
	// printProgress(`Dispatching ${txs.length} transaction/s using seed ${seed}.`, true);

	// ensure signer has enough balance.
	const { data: signer_balance } = await api.query.system.account(signer.address);
	const free_bal = signer_balance.free.toNumber();

	// If free balance is less than 1.8 DOT, don't try again. Something is wrong.
	// Expected 2 DOT so 1.8 dot still has 0.2 DOT error margin.
	if (free_bal < TOPUP_BALANCE) {
		console.error(`Signer ${signer.address} has insufficient balance: ${free_bal}. EXITING.`);
		process.exit(1);
	}

	try {
		if (txs.length > 1) {
			await api.tx.utility.batch(txs).signAndSend(signer, ({ status }) => {
				if (status.isInBlock) {
					// console.log(`included in ${status.asInBlock}`);
				}
			});
		} else if (txs.length == 1) {
			await txs[0].signAndSend(signer);
		}
	} catch (error) {
		console.error(`Error while dispatching a transaction: ${error}`);
	}
}

async function topup_signers(api: ApiPromise) {
	const keyring = new Keyring({ type: 'sr25519' });
	const admin = keyring.createFromUri(`${MNEMONIC}`);

	for (let i = shift_seed; i < shift_seed + ACCOUNTS_TO_USE; i++) {
		const signer = keyring.addFromUri(`${MNEMONIC}//${i}`);
		const { data: signer_balance } = await api.query.system.account(signer.address);
		const free_bal = signer_balance.free.toNumber();
		console.log(`Balance for signer with seed ${i} is ${free_bal}`);

		if (free_bal < TOPUP_BALANCE) {
			const topup = TOPUP_BALANCE - free_bal;
			console.log(`Topping up signer ${signer.address} (seed: ${i}) with ${topup}`);
			await api.tx.balances.transferKeepAlive(signer.address, topup).signAndSend(admin);
			// wait for 12 seconds before sending another tx.
			await new Promise((f) => setTimeout(f, 12000));
		}
	}
}

function printProgress(additional: string, force = false) {
	if (processed % progressStep == 0 || force) {
		process.stdout.clearLine(0);
		process.stdout.cursorTo(0);
		process.stdout.write(
			`Progress ${Math.round((processed * 10000) / totalToProcess) / 100}%` +
				` | Processed ${processed}/${totalToProcess}` +
				` | Stats: ${toMigrate} to migrate | ${alreadyMigrated} already migrated` +
				` | ${additional}`
		);
	}
}
