// Generic block bisection: binary-search for the first block at which a
// user-supplied predicate flips from false -> true.
//
// The chain state is monotonic across the search range for a correct result:
// the predicate must be false at `lo` and true at `hi`, and there must be a
// single transition point in between. (If the underlying value is non-monotonic
// the search still returns *a* transition, but not necessarily "the" one — see
// --verify-monotonic to spot-check.)
//
// A "condition" is a predicate `(ctx) => Promise<boolean>` where ctx gives you:
//   - api:   the ApiPromise (current metadata)
//   - n:     block number
//   - hash:  block hash at n
//   - rawAt(key): read raw storage bytes at this block (metadata-independent)
//   - apiAt():    ApiPromise bound to this block's own runtime metadata
// Return true when the block satisfies the target state (the "after" state).
//
// Add your own condition to the CONDITIONS registry below and select it with
// --condition <name>. Params are passed via --arg key=value (repeatable).
//
// Usage:
//   yarn run bisect --condition inv-empty --lo 10267894
//   yarn run bisect --condition storage-empty \
//     --arg pallet=MultiBlockElectionSigned --arg item=Invulnerables --lo 10267894
//   yarn run bisect --condition spec-at-least --arg spec=2002000 --lo 1 --hi 17000000

import '@polkadot/api-augment';
import '@polkadot/types-augment';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { xxhashAsHex } from '@polkadot/util-crypto';
import type { Hash } from '@polkadot/types/interfaces';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// ---------------------------------------------------------------------------
// Condition context handed to every predicate.
// ---------------------------------------------------------------------------
export interface BisectCtx {
	api: ApiPromise;
	n: number;
	hash: Hash;
	/** Read raw SCALE bytes of a storage entry at this block. '' if absent. */
	rawAt: (storageKeyHex: string) => Promise<string>;
	/** ApiPromise bound to this block's own metadata (cached per block). */
	apiAt: () => Promise<ApiPromise>;
	/** twox128(pallet) ++ twox128(item) — a Plain storage key. */
	plainKey: (pallet: string, item: string) => string;
	/** Params from --arg key=value. */
	args: Record<string, string>;
}

export type Condition = (ctx: BisectCtx) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Condition registry. Add new named predicates here.
// Each returns true for the "after"/target state (what `hi` should satisfy).
// ---------------------------------------------------------------------------
const CONDITIONS: Record<string, { help: string; test: Condition }> = {
	// A Plain Vec/StorageValue storage item is empty (raw bytes '0x00' = Vec len 0)
	// or absent. Configure with --arg pallet=.. --arg item=..
	'storage-empty': {
		help: 'raw storage <pallet>.<item> is empty (0x00) or absent. --arg pallet= --arg item=',
		test: async ({ rawAt, plainKey, args }) => {
			const pallet = args.pallet;
			const item = args.item;
			if (!pallet || !item) throw new Error('storage-empty needs --arg pallet= and --arg item=');
			const hex = await rawAt(plainKey(pallet, item));
			return hex === '' || hex === '0x00';
		}
	},

	// Convenience alias for the specific case we investigated.
	'inv-empty': {
		help: 'multiBlockElectionSigned.invulnerables is empty',
		test: async ({ rawAt, plainKey }) => {
			const hex = await rawAt(plainKey('MultiBlockElectionSigned', 'Invulnerables'));
			return hex === '' || hex === '0x00';
		}
	},

	// Runtime spec_version >= --arg spec=. Useful to locate a runtime upgrade.
	'spec-at-least': {
		help: 'runtime specVersion >= --arg spec=',
		test: async ({ api, hash, args }) => {
			const want = parseInt(args.spec, 10);
			if (!want) throw new Error('spec-at-least needs --arg spec=<number>');
			const spec = (await api.rpc.state.getRuntimeVersion(hash)).specVersion.toNumber();
			return spec >= want;
		}
	},

	// Raw storage value equals a given hex. --arg pallet= --arg item= --arg value=0x..
	'storage-equals': {
		help: 'raw storage <pallet>.<item> === --arg value=0x..',
		test: async ({ rawAt, plainKey, args }) => {
			if (!args.pallet || !args.item || !args.value)
				throw new Error('storage-equals needs --arg pallet= --arg item= --arg value=');
			const hex = await rawAt(plainKey(args.pallet, args.item));
			return hex.toLowerCase() === args.value.toLowerCase();
		}
	}
};

// ---------------------------------------------------------------------------

const optionsPromise = yargs(hideBin(process.argv))
	.option('endpoint', {
		alias: 'e',
		type: 'string',
		default: 'wss://asset-hub-polkadot-rpc.n.dwellir.com',
		description: 'archive wss endpoint'
	})
	.option('condition', {
		alias: 'c',
		type: 'string',
		default: 'inv-empty',
		description: `match condition (${Object.keys(CONDITIONS).join(', ')})`
	})
	.option('arg', {
		type: 'array',
		default: [] as string[],
		description: 'condition params as key=value (repeatable)'
	})
	.option('lo', {
		type: 'number',
		demandOption: true,
		description: 'lower bound block — condition expected FALSE here'
	})
	.option('hi', {
		type: 'number',
		description: 'upper bound block — condition expected TRUE here (default: head)'
	})
	.option('list-conditions', {
		type: 'boolean',
		default: false,
		description: 'print available conditions and exit'
	}).argv;

function parseArgs(raw: (string | number)[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const kv of raw) {
		const s = String(kv);
		const eq = s.indexOf('=');
		if (eq === -1) throw new Error(`--arg must be key=value, got "${s}"`);
		out[s.slice(0, eq)] = s.slice(eq + 1);
	}
	return out;
}

async function main() {
	const options = await optionsPromise;

	if (options['list-conditions']) {
		console.log('Available conditions:');
		for (const [name, def] of Object.entries(CONDITIONS)) {
			console.log(`  ${name.padEnd(16)} ${def.help}`);
		}
		process.exit(0);
	}

	const cond = CONDITIONS[options.condition];
	if (!cond) {
		console.error(`Unknown condition "${options.condition}". Try --list-conditions.`);
		process.exit(1);
	}
	const args = parseArgs(options.arg as (string | number)[]);

	const provider = new WsProvider(options.endpoint);
	const api = await ApiPromise.create({ provider });
	console.log(`Connected to ${(await api.rpc.system.chain()).toHuman()}`);
	console.log(`Condition: ${options.condition}  args=${JSON.stringify(args)}\n`);

	// Per-block apiAt cache so predicates can reuse historical metadata cheaply.
	const apiAtCache = new Map<string, Promise<ApiPromise>>();

	function makeCtx(n: number, hash: Hash): BisectCtx {
		return {
			api,
			n,
			hash,
			args,
			plainKey: (pallet, item) =>
				xxhashAsHex(pallet, 128) + xxhashAsHex(item, 128).slice(2),
			rawAt: async (key) => {
				const raw: any = await api.rpc.state.getStorage(key, hash);
				return raw && raw.isSome ? raw.unwrap().toHex() : '';
			},
			apiAt: () => {
				const h = hash.toHex();
				if (!apiAtCache.has(h)) apiAtCache.set(h, api.at(hash) as unknown as Promise<ApiPromise>);
				return apiAtCache.get(h)!;
			}
		};
	}

	async function evalAt(n: number): Promise<boolean> {
		const hash = await api.rpc.chain.getBlockHash(n);
		return cond.test(makeCtx(n, hash));
	}

	let lo = options.lo;
	let hi = options.hi ?? (await api.rpc.chain.getHeader()).number.toNumber();

	const atLo = await evalAt(lo);
	const atHi = await evalAt(hi);
	console.log(`lo=${lo}: condition=${atLo}`);
	console.log(`hi=${hi}: condition=${atHi}\n`);

	if (atLo) {
		console.error('❌ condition already TRUE at lo — pick an earlier lo.');
		process.exit(1);
	}
	if (!atHi) {
		console.error('❌ condition FALSE at hi — pick a later hi.');
		process.exit(1);
	}

	// Invariant: eval(lo)=false, eval(hi)=true. Find first true in (lo, hi].
	let steps = 0;
	while (hi - lo > 1) {
		const mid = Math.floor((lo + hi) / 2);
		const r = await evalAt(mid);
		steps++;
		console.log(`  step ${steps}: mid=${mid} condition=${r} [lo=${lo}, hi=${hi}]`);
		if (r) hi = mid;
		else lo = mid;
	}

	const loHash = (await api.rpc.chain.getBlockHash(lo)).toHex();
	const hiHash = (await api.rpc.chain.getBlockHash(hi)).toHex();
	console.log(`\n${'='.repeat(64)}`);
	console.log(`Last FALSE block: ${lo}  (${loHash})`);
	console.log(`First TRUE block: ${hi}  (${hiHash})`);
	console.log(`${'='.repeat(64)}`);
	console.log(`\nTransition at block ${hi} (${lo} -> ${hi}).`);

	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
