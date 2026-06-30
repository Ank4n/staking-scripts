// Dump the full election snapshot (multiBlockElection pallet) at a given block to
// a JSON file, so phragmén experiments can run locally/offline without re-querying
// the chain. Captures everything the election solver needs as input, plus the
// on-chain knobs you may want to tweak (desiredTargets, minimumScore).
//
// Output JSON shape:
// {
//   meta: { chain, specVersion, block, blockHash, round, decimals, token },
//   desiredTargets: number,                 // on-chain target count for this round
//   minimumScore: { minimalStake, sumStake, sumStakeSquared } (decimal strings, planck),
//   candidates: string[],                    // target snapshot (all pages, concatenated)
//   voters: [ [voterId, stakePlanck(string), [targetId, ...]], ... ],   // all voter pages
//   // solver-ready, index-based form (sp-npos-elections friendly):
//   solver: {
//     candidates: string[],                  // == candidates above (index = candidate id)
//     voters: [ [voterIdx(number), stakePlanck(string), [candidateIdx, ...]], ... ]
//   }
// }
//
// Usage:
//   yarn run dump:snapshot -e wss://polkadot-asset-hub-rpc.polkadot.io -b 17631723 -o snapshot-238.json

import '@polkadot/api-augment';
import '@polkadot/types-augment';
import { ApiPromise, WsProvider } from '@polkadot/api';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import * as fs from 'fs';

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
		description: 'block number or hash to read the snapshot at (defaults to latest)'
	})
	.option('round', {
		alias: 'r',
		type: 'number',
		description: 'election round to read (defaults to multiBlockElection.round at the block)'
	})
	.option('out', {
		alias: 'o',
		type: 'string',
		default: 'snapshot.json',
		description: 'output JSON file path'
	}).argv;

async function main() {
	const options = await optionsPromise;
	const provider = new WsProvider(options.endpoint);
	const api = await ApiPromise.create({ provider });

	const chain = (await api.rpc.system.chain()).toHuman() as string;
	const specVersion = (await api.rpc.state.getRuntimeVersion()).specVersion.toNumber();

	let blockHash: string | undefined;
	if (options.block) {
		blockHash = options.block.startsWith('0x')
			? options.block
			: (await api.rpc.chain.getBlockHash(parseInt(options.block))).toString();
	} else {
		blockHash = (await api.rpc.chain.getFinalizedHead()).toString();
	}
	const apiAt = await api.at(blockHash);
	const blockNumber = (await api.rpc.chain.getHeader(blockHash)).number.toNumber();

	const decimals = api.registry.chainDecimals[0] ?? 10;
	const token = (api.registry.chainTokens[0] as string) ?? 'UNIT';

	const round =
		options.round !== undefined
			? options.round
			: Number((await apiAt.query.multiBlockElection.round()).toString());

	console.log(`Chain: ${chain} (spec v${specVersion})`);
	console.log(`Block: ${blockNumber} (${blockHash})`);
	console.log(`Round: ${round}`);

	// --- desiredTargets (map keyed by round) ---
	const desiredTargets = Number(
		(await apiAt.query.multiBlockElection.desiredTargets(round)).toString()
	);
	console.log(`desiredTargets: ${desiredTargets}`);

	// --- minimumScore (plain) ---
	const minScoreRaw = (await apiAt.query.multiBlockElectionVerifier.minimumScore()).toJSON() as any;
	const minimumScore = {
		minimalStake: BigInt(minScoreRaw?.minimalStake ?? 0).toString(),
		sumStake: BigInt(minScoreRaw?.sumStake ?? 0).toString(),
		sumStakeSquared: BigInt(minScoreRaw?.sumStakeSquared ?? 0).toString()
	};
	console.log(`minimumScore.minimalStake (planck): ${minimumScore.minimalStake}`);

	// --- target snapshot (all pages) ---
	const targetPages = await apiAt.query.multiBlockElection.pagedTargetSnapshot.entries();
	const candidates: string[] = [];
	const candidateSeen = new Set<string>();
	// pages are unordered from .entries(); sort by page index for determinism
	targetPages.sort((a, b) => Number(a[0].args[1]) - Number(b[0].args[1]));
	for (const [, v] of targetPages) {
		for (const acc of v.toJSON() as string[]) {
			if (!candidateSeen.has(acc)) {
				candidateSeen.add(acc);
				candidates.push(acc);
			}
		}
	}
	console.log(`candidates: ${candidates.length} (from ${targetPages.length} page(s))`);

	if (candidates.length === 0) {
		console.log(
			'\n⚠️  Target snapshot empty at this block — snapshot only exists during a live election round.'
		);
		process.exit(1);
	}

	const candidateIndex = new Map<string, number>();
	candidates.forEach((c, i) => candidateIndex.set(c, i));

	// --- voter snapshot (all pages) ---
	const voterPages = await apiAt.query.multiBlockElection.pagedVoterSnapshot.entries();
	voterPages.sort((a, b) => Number(a[0].args[1]) - Number(b[0].args[1]));

	const voters: [string, string, string[]][] = [];
	const solverVoters: [number, string, number[]][] = [];
	let totalVoters = 0;

	for (const [, v] of voterPages) {
		const page = v.toJSON() as [string, number | string, string[]][];
		for (const [voterId, stakeRaw, targets] of page) {
			const stake = BigInt(stakeRaw as any).toString();
			voters.push([voterId, stake, targets]);

			// solver form: drop any target not in the candidate set (defensive; shouldn't happen)
			const idxTargets: number[] = [];
			for (const t of targets) {
				const idx = candidateIndex.get(t);
				if (idx !== undefined) idxTargets.push(idx);
			}
			solverVoters.push([totalVoters, stake, idxTargets]);
			totalVoters++;
		}
	}
	console.log(`voters: ${voters.length} (from ${voterPages.length} page(s))`);

	const output = {
		meta: {
			chain,
			specVersion,
			block: blockNumber,
			blockHash,
			round,
			decimals,
			token
		},
		desiredTargets,
		minimumScore,
		candidates,
		voters,
		solver: {
			candidates,
			voters: solverVoters
		}
	};

	fs.writeFileSync(options.out, JSON.stringify(output, null, 0));
	const bytes = fs.statSync(options.out).size;
	console.log(`\nWrote ${options.out} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);

	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
