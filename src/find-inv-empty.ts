// Binary search for the first PAH block at which
// `multiBlockElectionSigned.invulnerables` became EMPTY.
//
// Context: on Polkadot Asset Hub the multi-block-election signed pallet keeps a
// `Vec<AccountId>` of "invulnerable" submitters under a Plain storage item. The
// entry is always present (default = empty vec), so we look at the RAW storage
// bytes at each block:
//   - `0x00`  => SCALE-encoded Vec with length 0  => EMPTY
//   - `0x..`  => length prefix > 0                => NON-EMPTY
//
// We read the raw value with state_getStorage(key, blockHash) so we don't
// depend on the block's metadata still decorating the item.
//
// The lower bound is a block where it is known to be non-empty; the upper bound
// is head (known empty). Binary search finds the first empty block.
//
// Usage:
//   yarn run find:inv-empty
//   yarn run find:inv-empty -e "wss://asset-hub-polkadot-rpc.n.dwellir.com" --lo 10267894

import '@polkadot/api-augment';
import '@polkadot/types-augment';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { xxhashAsHex } from '@polkadot/util-crypto';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const optionsPromise = yargs(hideBin(process.argv))
	.option('endpoint', {
		alias: 'e',
		type: 'string',
		// Dwellir archive node (retains historical state).
		default: 'wss://asset-hub-polkadot-rpc.n.dwellir.com',
		description: 'archive wss endpoint (PAH — staking/election live on Asset Hub)'
	})
	.option('lo', {
		type: 'number',
		// User-supplied anchor: invulnerables still existed at this block.
		default: 10267894,
		description: 'lower bound block, known NON-EMPTY'
	})
	.option('hi', {
		type: 'number',
		description: 'upper bound block, known EMPTY (defaults to current head)'
	}).argv;

// Raw storage key: twox128("MultiBlockElectionSigned") ++ twox128("Invulnerables")
const KEY =
	xxhashAsHex('MultiBlockElectionSigned', 128) +
	xxhashAsHex('Invulnerables', 128).slice(2);

async function main() {
	const options = await optionsPromise;
	const provider = new WsProvider(options.endpoint);
	const api = await ApiPromise.create({ provider });

	const chain = (await api.rpc.system.chain()).toHuman();
	console.log(`Connected to ${chain}`);
	console.log(`Storage key: ${KEY}`);

	// Returns { empty, hex, len, hash } for a given block number.
	async function readAt(blockNumber: number) {
		const hash = await api.rpc.chain.getBlockHash(blockNumber);
		const raw: any = await api.rpc.state.getStorage(KEY, hash);
		// state_getStorage returns Option<StorageData>. None => item absent.
		let hex = '<none>';
		let empty: boolean;
		let len: number | null = null;
		if (raw && raw.isSome) {
			hex = raw.unwrap().toHex();
			// SCALE compact length prefix. `0x00` => empty vec.
			empty = hex === '0x00';
			// Best-effort element count: decode compact prefix (first byte only
			// suffices while len < 64, which is always true for invulnerables).
			const firstByte = parseInt(hex.slice(2, 4), 16);
			len = firstByte >> 2; // single-byte compact
		} else {
			// Absent entry counts as empty for our purposes.
			hex = '<none>';
			empty = true;
		}
		return { blockNumber, hash: hash.toHex(), hex, empty, len };
	}

	let lo = options.lo; // expected NON-EMPTY
	let hi = options.hi ?? (await api.rpc.chain.getHeader()).number.toNumber(); // expected EMPTY

	const atLo = await readAt(lo);
	const atHi = await readAt(hi);
	console.log(
		`\nlo=${lo}: empty=${atLo.empty} len=${atLo.len} raw=${atLo.hex}`
	);
	console.log(`hi=${hi}: empty=${atHi.empty} len=${atHi.len} raw=${atHi.hex}\n`);

	if (atLo.empty) {
		console.error('❌ lo is already EMPTY — pick a lower/earlier block.');
		process.exit(1);
	}
	if (!atHi.empty) {
		console.error('❌ hi is NOT empty — pick a higher/later block (or head moved).');
		process.exit(1);
	}

	// Invariant: readAt(lo).empty === false, readAt(hi).empty === true.
	// Find the first block in (lo, hi] that is empty.
	let steps = 0;
	while (hi - lo > 1) {
		const mid = Math.floor((lo + hi) / 2);
		const r = await readAt(mid);
		steps++;
		console.log(
			`  step ${steps}: mid=${mid} empty=${r.empty} len=${r.len} raw=${r.hex} [lo=${lo}, hi=${hi}]`
		);
		if (r.empty) hi = mid;
		else lo = mid;
	}

	const firstEmpty = await readAt(hi);
	const lastNonEmpty = await readAt(lo);
	console.log(`\n${'='.repeat(60)}`);
	console.log(`Last NON-EMPTY block: ${lo}`);
	console.log(`   len=${lastNonEmpty.len} raw=${lastNonEmpty.hex}`);
	console.log(`   hash=${lastNonEmpty.hash}`);
	console.log(`First EMPTY block:    ${hi}`);
	console.log(`   raw=${firstEmpty.hex}`);
	console.log(`   hash=${firstEmpty.hash}`);
	console.log(`${'='.repeat(60)}`);
	console.log(`\nInvulnerables became empty at block ${hi} (transition ${lo} -> ${hi}).`);

	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
