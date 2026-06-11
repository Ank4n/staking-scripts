// Check nominator exposure across recent eras.
//
// Given a nominator account, checks:
// 1. Whether the account is a nominator
// 2. Who it is nominating
// 3. For each validator, scans ErasStakersPaged across all pages and last 84 eras
//    to find where the nominator was included in the exposure.
//
// Usage:
//   yarn run nominator:exposure -e "wss://westend-rpc.polkadot.io" -a "<account_ss58>"
//   yarn run nominator:exposure -e "wss://westend-rpc.polkadot.io" -a "<account>" --eras 28

import '@polkadot/api-augment';
import '@polkadot/types-augment';
import { ApiPromise, WsProvider } from '@polkadot/api';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const optionsPromise = yargs(hideBin(process.argv))
	.option('endpoint', {
		alias: 'e',
		type: 'string',
		default: 'wss://westend-rpc.polkadot.io',
		description: 'the wss endpoint',
		demandOption: true
	})
	.option('account', {
		alias: 'a',
		type: 'string',
		description: 'the nominator account (ss58)',
		demandOption: true
	})
	.option('eras', {
		type: 'number',
		default: 84,
		description: 'number of past eras to check'
	}).argv;

async function main() {
	const options = await optionsPromise;
	const provider = new WsProvider(options.endpoint);
	const api = await ApiPromise.create({ provider });

	const chain = (await api.rpc.system.chain()).toHuman();
	const version = (await api.rpc.state.getRuntimeVersion()).specVersion.toNumber();
	console.log(`Connected to: ${chain} (runtime v${version})`);

	const account = options.account;
	const erasToCheck = options.eras;

	// Check if the account is a nominator
	const nominatorData = await api.query.staking.nominators(account);
	if (nominatorData.isNone) {
		console.log(`\n❌ Account ${account} is NOT a nominator.`);
		process.exit(1);
	}

	const nominations = nominatorData.unwrap();
	const targets = nominations.targets.map((t: any) => t.toString());
	console.log(`\n✅ Account is a nominator (submitted in era ${nominations.submittedIn.toString()})`);
	console.log(`   Nominating ${targets.length} validators:`);
	for (const target of targets) {
		console.log(`     - ${target}`);
	}

	// Get current active era
	const activeEraOpt = await api.query.staking.activeEra();
	if (activeEraOpt.isNone) {
		console.log('\n❌ No active era found.');
		process.exit(1);
	}
	const activeEraIndex = activeEraOpt.unwrap().index.toNumber();
	console.log(`\nActive era: ${activeEraIndex}`);

	const startEra = Math.max(0, activeEraIndex - erasToCheck + 1);
	console.log(`Checking eras ${startEra} to ${activeEraIndex} (${activeEraIndex - startEra + 1} eras)\n`);

	// For each era, for each validator target, check all pages of ErasStakersPaged
	// Result: Map<era, Map<validator, { page, value }>>
	const exposureReport: Map<number, Map<string, { page: number; value: string }>> = new Map();

	for (let era = startEra; era <= activeEraIndex; era++) {
		process.stdout.write(`  Checking era ${era}...`);
		const eraExposures: Map<string, { page: number; value: string }> = new Map();

		for (const validator of targets) {
			// First check overview to get page count
			const overview: any = await api.query.staking.erasStakersOverview(era, validator);
			if (overview.isNone) {
				continue;
			}

			const pageCount = overview.unwrap().pageCount.toNumber();

			for (let page = 0; page < pageCount; page++) {
				const exposurePage: any = await api.query.staking.erasStakersPaged(era, validator, page);
				if (exposurePage.isNone) {
					continue;
				}

				const others = exposurePage.unwrap().others;
				for (const individual of others) {
					if (individual.who.toString() === account) {
						eraExposures.set(validator, {
							page,
							value: individual.value.toString()
						});
						break;
					}
				}
				// If already found for this validator, skip remaining pages
				if (eraExposures.has(validator)) {
					break;
				}
			}
		}

		if (eraExposures.size > 0) {
			exposureReport.set(era, eraExposures);
			process.stdout.write(` exposed to ${eraExposures.size} validator(s)\n`);
		} else {
			process.stdout.write(` not exposed\n`);
		}
	}

	// Print report
	console.log(`\n${'='.repeat(80)}`);
	console.log(`EXPOSURE REPORT for ${account}`);
	console.log(`${'='.repeat(80)}\n`);

	if (exposureReport.size === 0) {
		console.log('No exposure found in any of the checked eras.');
	} else {
		console.log(`Exposed in ${exposureReport.size} out of ${activeEraIndex - startEra + 1} eras.\n`);

		// Summary per era
		console.log('--- Per Era ---');
		for (const [era, validators] of exposureReport) {
			console.log(`\nEra ${era}:`);
			for (const [validator, info] of validators) {
				console.log(`  Validator: ${validator}`);
				console.log(`    Page: ${info.page}, Stake exposed: ${info.value}`);
			}
		}

		// Summary per validator
		console.log('\n--- Per Validator ---');
		const validatorSummary: Map<string, number[]> = new Map();
		for (const [era, validators] of exposureReport) {
			for (const [validator] of validators) {
				if (!validatorSummary.has(validator)) {
					validatorSummary.set(validator, []);
				}
				validatorSummary.get(validator)!.push(era);
			}
		}

		for (const [validator, eras] of validatorSummary) {
			console.log(`\n  ${validator}`);
			console.log(`    Exposed in ${eras.length} eras: ${formatEraRanges(eras)}`);
		}
	}

	console.log(`\n${'='.repeat(80)}`);
	process.exit(0);
}

// Compress consecutive eras into ranges for readability, e.g. [1,2,3,5,7,8] -> "1-3, 5, 7-8"
function formatEraRanges(eras: number[]): string {
	if (eras.length === 0) return '';
	const sorted = [...eras].sort((a, b) => a - b);
	const ranges: string[] = [];
	let start = sorted[0];
	let end = sorted[0];

	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i] === end + 1) {
			end = sorted[i];
		} else {
			ranges.push(start === end ? `${start}` : `${start}-${end}`);
			start = sorted[i];
			end = sorted[i];
		}
	}
	ranges.push(start === end ? `${start}` : `${start}-${end}`);
	return ranges.join(', ');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
