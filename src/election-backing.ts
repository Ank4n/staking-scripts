// Reconstruct the total backing-stake distribution of an election round directly
// from the on-chain election snapshot (multiBlockElection pallet).
//
// Motivation: when a signed solution is rejected (e.g. its score is below
// minimumScore so it never reaches the SignedValidation phase), the verifier
// never computes `queuedSolutionBackings`, so there is no per-validator backing
// stored on chain. We instead rebuild the *raw approval backing* of every
// candidate from the snapshot the election actually ran over:
//
//   backing(validator) = sum of voter.stake over all voters who nominate it
//
// This is the pre-phragmén "approval stake" each candidate carries. Each
// nominator's full bonded weight is attributed to every validator it nominates
// (so the sum of all backings exceeds total bonded stake, by design).
//
// Snapshot storage (paged, only live during an election round):
//   multiBlockElection.pagedTargetSnapshot(round, page) -> Vec<AccountId>
//   multiBlockElection.pagedVoterSnapshot(round, page)  -> Vec<(AccountId, u64 stake, Vec<AccountId> targets)>
//
// Usage:
//   yarn run election:backing -e wss://polkadot-asset-hub-rpc.polkadot.io -b 17631723
//   yarn run election:backing -e wss://polkadot-asset-hub-rpc.polkadot.io -b 17631723 --min 10000 --top 50

import '@polkadot/api-augment';
import '@polkadot/types-augment';
import { ApiPromise, WsProvider } from '@polkadot/api';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const optionsPromise = yargs(hideBin(process.argv))
	.option('endpoint', {
		alias: 'e',
		type: 'string',
		default: 'wss://polkadot-asset-hub-rpc.polkadot.io',
		description: 'the Asset Hub wss endpoint',
		demandOption: true
	})
	.option('block', {
		alias: 'b',
		type: 'string',
		description: 'block number or hash to query the snapshot at (defaults to latest)'
	})
	.option('round', {
		alias: 'r',
		type: 'number',
		description: 'election round to read (defaults to multiBlockElection.round at the block)'
	})
	.option('min', {
		alias: 'm',
		type: 'number',
		default: 0,
		description: 'only include validators whose backing is >= this many whole tokens (e.g. 10000)'
	})
	.option('top', {
		alias: 't',
		type: 'number',
		default: 620,
		description: 'how many top-backed validators to print individually'
	}).argv;

async function main() {
	const options = await optionsPromise;
	const provider = new WsProvider(options.endpoint);
	const api = await ApiPromise.create({ provider });

	const chain = (await api.rpc.system.chain()).toHuman();
	const version = (await api.rpc.state.getRuntimeVersion()).specVersion.toNumber();
	console.log(`Connected to: ${chain} (runtime v${version})`);

	// resolve block
	let blockHash: string | undefined;
	if (options.block) {
		blockHash = options.block.startsWith('0x')
			? options.block
			: (await api.rpc.chain.getBlockHash(parseInt(options.block))).toString();
		console.log(`Querying at block: ${options.block} (${blockHash})`);
	}
	const apiAt = blockHash ? await api.at(blockHash) : api;

	// token decimals for human-readable output
	const decimals = api.registry.chainDecimals[0] ?? 10;
	const tokenSymbol = (api.registry.chainTokens[0] as string) ?? 'UNIT';
	const UNIT = 10n ** BigInt(decimals);
	const withCommas = (n: bigint): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	const fmt = (planck: bigint): string => {
		const whole = planck / UNIT;
		const frac = ((planck % UNIT) * 10000n) / UNIT; // 4 dp
		return `${withCommas(whole)}.${frac.toString().padStart(4, '0')} ${tokenSymbol}`;
	};

	const round =
		options.round !== undefined
			? options.round
			: Number((await apiAt.query.multiBlockElection.round()).toString());
	console.log(`Election round: ${round}`);

	// --- target snapshot: the candidate set (all pages) ---
	const targetPages = await apiAt.query.multiBlockElection.pagedTargetSnapshot.entries();
	const candidates = new Set<string>();
	for (const [, v] of targetPages) {
		for (const acc of v.toJSON() as string[]) candidates.add(acc);
	}
	console.log(`\nTarget snapshot: ${targetPages.length} page(s), ${candidates.size} candidate validators`);

	if (candidates.size === 0) {
		console.log(
			'\n⚠️  Target snapshot is empty at this block. The snapshot only exists during an' +
				' election round (Snapshot/Signed/SignedValidation phases). Pick a block inside' +
				' the round, or pass --round.'
		);
		process.exit(0);
	}

	// --- voter snapshot: build backing = sum of voter stake per nominated candidate ---
	const voterPages = await apiAt.query.multiBlockElection.pagedVoterSnapshot.entries();

	const backing = new Map<string, bigint>(); // candidate -> total approval stake
	for (const c of candidates) backing.set(c, 0n);

	let totalVoters = 0;
	let totalVoterStake = 0n; // sum of each voter's stake counted once (true bonded weight in snapshot)
	let sumOfBackings = 0n; // sum over candidates of their backing (double-counts multi-nominations)

	for (const [, v] of voterPages) {
		const voters = v.toJSON() as [string, number | string, string[]][];
		for (const [, stakeRaw, targets] of voters) {
			totalVoters++;
			// stake is u64; toJSON gives a number for small values, hex string for large.
			const stake = BigInt(stakeRaw as any);
			totalVoterStake += stake;
			for (const t of targets) {
				if (backing.has(t)) {
					backing.set(t, backing.get(t)! + stake);
					sumOfBackings += stake;
				}
			}
		}
	}
	console.log(`Voter snapshot: ${voterPages.length} page(s), ${totalVoters} voters`);

	// --- filter + sort ---
	const minPlanck = BigInt(Math.round(options.min)) * UNIT;
	const ranked = [...backing.entries()]
		.filter(([, s]) => s >= minPlanck)
		.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));

	const totalBackingFiltered = ranked.reduce((acc, [, s]) => acc + s, 0n);

	console.log(`\n=== Backing summary (round ${round}) ===`);
	console.log(`Candidates in target snapshot:        ${candidates.size}`);
	if (options.min > 0) {
		console.log(`Candidates with backing >= ${options.min} ${tokenSymbol}:  ${ranked.length}`);
	}
	console.log(`Distinct voters:                      ${totalVoters}`);
	console.log(`Total voter (bonded) stake:           ${fmt(totalVoterStake)}`);
	console.log(`Sum of all candidate backings:        ${fmt(sumOfBackings)}   (raw approval, multi-nominations counted per target)`);
	if (options.min > 0) {
		console.log(`Sum of backings (>= ${options.min} ${tokenSymbol} only):   ${fmt(totalBackingFiltered)}`);
	}

	console.log(`\n=== Top ${Math.min(options.top, ranked.length)} backed validators ===`);
	ranked.slice(0, options.top).forEach(([acc, s], i) => {
		console.log(`  ${String(i + 1).padStart(3)}. ${acc}  ${fmt(s)}`);
	});

	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
