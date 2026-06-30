// Report the system-wide min/max commission bounds and every validator's
// current commission, then count how many validators are out of bounds and
// would need to be updated.
//
// The staking pallet enforces a minimum commission via `staking.minCommission`
// (a Perbill). A maximum validator commission may also be enforced on some
// runtimes via `staking.maxValidatorCommission` (storage) — we probe for it at
// runtime and fall back to "no max" (100%) if the chain doesn't have it.
//
// A validator "needs updating" if its commission is below the min or above the
// max — on the next `validate`/`setCommission`-style call the runtime would
// reject or clamp it, so these are the ones to fix.
//
// NOTE: staking lives on Asset Hub, not the relay chain — point -e at an
// Asset Hub RPC (e.g. westend/polkadot/kusama-asset-hub-rpc.polkadot.io).
//
// Optionally (--apply) it can fix the below-min validators by sending the
// permissionless `staking.forceApplyMinCommission` for each, fanning the work
// across N derived accounts (//0 .. //N-1) funded from a root account given by
// the DOT_BOT_MNEMONIC env var. Each signer paces itself by DELAY (6s), so with
// 4 signers ~4 calls clear every 6s.
//
// Usage:
//   # report only:
//   yarn run validator:commission -e "wss://polkadot-asset-hub-rpc.polkadot.io"
//   yarn run validator:commission -e "<asset-hub>" --list
//
//   # show balances of the root + derived signing accounts, then exit:
//   DOT_BOT_MNEMONIC="<root mnemonic>" yarn run validator:commission -e "<asset-hub>" --balances -a 4
//
//   # dry-run the apply (prints plan, sends nothing — this is the default):
//   DOT_BOT_MNEMONIC="<root mnemonic>" yarn run validator:commission -e "<asset-hub>" --apply -a 4
//
//   # actually send the transactions:
//   DOT_BOT_MNEMONIC="<root mnemonic>" yarn run validator:commission -e "<asset-hub>" --apply --no-dry -a 4

import '@polkadot/api-augment';
import '@polkadot/types-augment';
import { ApiPromise, Keyring, WsProvider } from '@polkadot/api';
import { BN } from '@polkadot/util';
import type { KeyringPair } from '@polkadot/keyring/types';
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
		description: 'list every out-of-bounds validator and its commission'
	})
	.option('apply', {
		type: 'boolean',
		default: false,
		description:
			'send staking.forceApplyMinCommission for every below-min validator, using N derived accounts in parallel (needs DOT_BOT_MNEMONIC env)'
	})
	.option('accounts', {
		alias: 'a',
		type: 'number',
		default: 4,
		description: 'number of derived sub-accounts to fan the apply work across (//0 .. //N-1)'
	})
	.option('dry', {
		alias: 'd',
		type: 'boolean',
		default: true,
		description: 'with --apply, dry run only (no transactions sent). Pass --no-dry to actually send.'
	})
	.option('balances', {
		alias: 'b',
		type: 'boolean',
		default: false,
		description: 'only show the balance of the main (root) account and the N derived accounts, then exit'
	}).argv;

// Delay (ms) between consecutive calls from the same signer. With 4 signers
// running in parallel, ~4 calls clear per DELAY window (so ~4 calls / 6s).
const DELAY = 6000;
// Funding floor (in plancks) each signer is topped up to before sending.
// forceApplyMinCommission fees are tiny; 1 DOT covers many calls.
//   DOT ED = 10,000,000,000 ; Westend ED = 10,000,000,000
const TOPUP_BALANCE = new BN('10000000000'); // 1 DOT-scale plancks
const MNEMONIC = process.env.DOT_BOT_MNEMONIC;

// Perbill is parts-per-billion. Convert to a percentage for display.
const PERBILL = 1_000_000_000;
const toPct = (perbill: number) => (perbill / PERBILL) * 100;
const fmtPct = (perbill: number) => `${toPct(perbill).toFixed(2)}%`;

async function main() {
	const options = await optionsPromise;
	const provider = new WsProvider(options.endpoint);
	const api = await ApiPromise.create({ provider });

	const chain = (await api.rpc.system.chain()).toHuman();
	const version = (await api.rpc.state.getRuntimeVersion()).specVersion.toNumber();
	console.log(`Connected to: ${chain} (runtime v${version})`);

	const decimals = api.registry.chainDecimals[0];
	const symbol = api.registry.chainTokens[0];

	// --- Balances-only mode: show main + derived account balances and exit. ---
	if (options.balances) {
		await showBalances(api, options.accounts, decimals, symbol);
		console.log();
		process.exit(0);
	}

	// --- Min commission (always present on the staking pallet) ---
	const minCommission = (await api.query.staking.minCommission()).toNumber();

	// --- Max commission: the maximum commission validators can set, stored as a
	//     Perbill at staking.maxCommission. Fall back to 100% if a runtime lacks it.
	let maxCommission = PERBILL; // 100% — effectively "no maximum"
	let maxSource = 'none (defaulting to 100%)';
	const stakingQuery = api.query.staking as any;
	if (stakingQuery.maxCommission) {
		maxCommission = (await stakingQuery.maxCommission()).toNumber();
		maxSource = 'staking.maxCommission';
	}

	console.log(`\n${'='.repeat(60)}`);
	console.log('SYSTEM COMMISSION BOUNDS');
	console.log(`${'='.repeat(60)}`);
	console.log(`  min commission: ${fmtPct(minCommission)} (staking.minCommission)`);
	console.log(`  max commission: ${fmtPct(maxCommission)} (${maxSource})`);

	// --- Fetch all validators and their commission prefs ---
	const validatorEntries = await api.query.staking.validators.entries();
	const all = validatorEntries.map(([key, prefs]) => ({
		validator: key.args[0].toString(),
		commission: prefs.commission.toNumber()
	}));
	console.log(`\nFound ${all.length} validators.`);

	const belowMin = all.filter((v) => v.commission < minCommission);
	const aboveMax = all.filter((v) => v.commission > maxCommission);
	const outOfBounds = all.filter((v) => v.commission < minCommission || v.commission > maxCommission);

	console.log(`\n${'='.repeat(60)}`);
	console.log('VALIDATORS NEEDING UPDATE');
	console.log(`${'='.repeat(60)}`);
	const total = all.length;
	const pct = (n: number) => (total > 0 ? ((n / total) * 100).toFixed(1) : '0.0');
	console.log(`  below min (${fmtPct(minCommission)}): ${belowMin.length} (${pct(belowMin.length)}%)`);
	console.log(`  above max (${fmtPct(maxCommission)}): ${aboveMax.length} (${pct(aboveMax.length)}%)`);
	console.log(`  ${'-'.repeat(40)}`);
	console.log(`  total out of bounds: ${outOfBounds.length} / ${total} (${pct(outOfBounds.length)}%)`);

	if (options.list) {
		const printGroup = (title: string, group: { validator: string; commission: number }[]) => {
			console.log(`\n[${title}] (${group.length})`);
			for (const { validator, commission } of group.sort((a, b) => a.commission - b.commission)) {
				console.log(`  ${validator}  ${fmtPct(commission)}`);
			}
		};
		console.log(`\n${'='.repeat(60)}`);
		console.log('PER-VALIDATOR BREAKDOWN (out of bounds)');
		console.log(`${'='.repeat(60)}`);
		printGroup(`below min ${fmtPct(minCommission)}`, belowMin);
		printGroup(`above max ${fmtPct(maxCommission)}`, aboveMax);
	}

	// --- Apply phase ---
	// staking.forceApplyMinCommission is permissionless and only fixes the
	// below-min case (it bumps a validator's commission up to the current min).
	// Above-max validators can only be fixed by the validator lowering their own
	// commission, so they are out of scope here.
	if (options.apply) {
		if (aboveMax.length > 0) {
			console.log(
				`\nNote: ${aboveMax.length} validator(s) are above max — forceApplyMinCommission cannot fix those (only the validator can lower commission). Skipping them.`
			);
		}

		if (belowMin.length === 0) {
			console.log('\nNothing to apply: no validators are below the min commission.');
			console.log();
			process.exit(0);
		}

		const stashes = belowMin.map((v) => v.validator);
		await applyMinCommission(api, stashes, options.dry, options.accounts);
	}

	console.log();
	process.exit(0);
}

// Derive the admin (root) account and `count` sub-accounts (//0 .. //count-1)
// from DOT_BOT_MNEMONIC. Exits if the mnemonic env var is missing.
function deriveAccounts(count: number): { admin: KeyringPair; signers: KeyringPair[] } {
	if (!MNEMONIC) {
		console.error('\nDOT_BOT_MNEMONIC env var is not set — cannot derive signing accounts. EXITING.');
		process.exit(1);
	}
	const keyring = new Keyring({ type: 'sr25519' });
	const admin = keyring.createFromUri(`${MNEMONIC}`);
	const signers: KeyringPair[] = [];
	for (let i = 0; i < count; i++) {
		signers.push(keyring.addFromUri(`${MNEMONIC}//${i}`));
	}
	return { admin, signers };
}

// Print the free balance of the admin (root) account and each derived signer.
async function showBalances(api: ApiPromise, count: number, decimals: number, symbol: string) {
	const { admin, signers } = deriveAccounts(count);
	const unit = new BN(10).pow(new BN(decimals));
	const fmt = (bn: BN) => `${bn.div(unit).toString()}.${bn.mod(unit).toString().padStart(decimals, '0')} ${symbol}`;

	console.log(`\n${'='.repeat(60)}`);
	console.log('ACCOUNT BALANCES');
	console.log(`${'='.repeat(60)}`);

	const { data: adminData } = await api.query.system.account(admin.address);
	console.log(`  admin (root): ${admin.address}`);
	console.log(`    free: ${fmt(adminData.free.toBn())}`);

	for (let i = 0; i < signers.length; i++) {
		const { data } = await api.query.system.account(signers[i].address);
		console.log(`  signer //${i}: ${signers[i].address}`);
		console.log(`    free: ${fmt(data.free.toBn())}`);
	}
}

// Force-apply the min commission to a list of validator stashes, fanning the
// work across `count` derived accounts (//0 .. //count-1) that all sign in
// parallel. Each account drives its own slice with locally-managed nonces.
async function applyMinCommission(api: ApiPromise, stashes: string[], dry: boolean, count: number) {
	const { admin, signers } = deriveAccounts(count);

	console.log(`\n${'='.repeat(60)}`);
	console.log(`APPLY MIN COMMISSION  (${dry ? 'DRY RUN' : 'LIVE'})`);
	console.log(`${'='.repeat(60)}`);
	console.log(`  ${stashes.length} validator(s) below min to fix`);
	console.log(`  admin (root): ${admin.address}`);
	signers.forEach((s, i) => console.log(`  signer //${i}: ${s.address}`));

	if (dry) {
		console.log('\nDry run — would top up signers (if needed) and dispatch the calls above.');
		console.log('Re-run with --no-dry to actually send.');
		return;
	}

	// 1. Top up each signer to TOPUP_BALANCE from the admin account. Skip any
	//    signer already funded. Sent sequentially from admin so nonces are simple.
	console.log('\nFunding signers...');
	for (let i = 0; i < signers.length; i++) {
		const signer = signers[i];
		const { data } = await api.query.system.account(signer.address);
		const free = data.free.toBn();
		if (free.gte(TOPUP_BALANCE)) {
			console.log(`  signer //${i} already funded (${free.toString()}), skipping.`);
			continue;
		}
		const topup = TOPUP_BALANCE.sub(free);
		console.log(`  topping up signer //${i} with ${topup.toString()}...`);
		await new Promise<void>((resolve, reject) => {
			api.tx.balances
				.transferKeepAlive(signer.address, topup)
				.signAndSend(admin, ({ status, dispatchError }) => {
					if (dispatchError) return reject(new Error(dispatchError.toString()));
					if (status.isInBlock || status.isFinalized) resolve();
				})
				.catch(reject);
		});
	}

	// 2. Round-robin the stashes into one slice per signer, run all concurrently.
	const slices: string[][] = Array.from({ length: count }, () => []);
	stashes.forEach((s, idx) => slices[idx % count].push(s));

	console.log('\nDispatching forceApplyMinCommission calls in parallel...');
	const results = await Promise.all(
		signers.map((signer, i) => dispatchSlice(api, signer, i, slices[i]))
	);

	const ok = results.reduce((a, r) => a + r.ok, 0);
	const failed = results.reduce((a, r) => a + r.failed, 0);
	console.log(`\nDone. Succeeded: ${ok} | Failed: ${failed} | Total: ${stashes.length}`);
}

// Send forceApplyMinCommission for each stash in a slice from a single signer,
// managing the nonce locally, with a DELAY pause after each call. With `count`
// signers running concurrently, ~`count` calls clear per DELAY window.
async function dispatchSlice(
	api: ApiPromise,
	signer: KeyringPair,
	signerIndex: number,
	stashes: string[]
): Promise<{ ok: number; failed: number }> {
	let ok = 0;
	let failed = 0;
	let nonce = (await api.rpc.system.accountNextIndex(signer.address)).toNumber();

	for (const stash of stashes) {
		try {
			await new Promise<void>((resolve, reject) => {
				api.tx.staking
					.forceApplyMinCommission(stash)
					.signAndSend(signer, { nonce }, ({ status, dispatchError }) => {
						if (dispatchError) return reject(new Error(dispatchError.toString()));
						if (status.isInBlock || status.isFinalized) resolve();
					})
					.catch(reject);
			});
			ok++;
			console.log(`  [//${signerIndex}] applied min to ${stash} (nonce ${nonce})`);
		} catch (error) {
			failed++;
			console.error(`  [//${signerIndex}] FAILED for ${stash} (nonce ${nonce}): ${error}`);
		}
		nonce++;
		// Pace this signer; with `count` signers in parallel, ~count calls / DELAY.
		await new Promise((f) => setTimeout(f, DELAY));
	}
	return { ok, failed };
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
