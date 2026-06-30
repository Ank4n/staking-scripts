//! Local phragmén playground.
//!
//! Reads a snapshot dumped by `yarn run dump:snapshot` and runs the *exact*
//! `sp-npos-elections` sequential-phragmén + balancing the runtime uses, then
//! prints the resulting `ElectionScore` and compares it against `minimumScore`.
//!
//! Tweak the knobs without touching the chain:
//!   --desired-targets 550     elect fewer validators
//!   --min-score-stake 700000  override the minimal_stake floor (whole tokens)
//!   --iterations 10           balancing iterations (default matches runtime)
//!
//! Build once:   cargo build --release   (inside phragmen-lab/)
//! Run:          ./target/release/phragmen-lab --snapshot ../snapshot-238.json
//!               ./target/release/phragmen-lab --snapshot ../snapshot-238.json --sweep 600 500

use clap::Parser;
use serde::Deserialize;
use sp_arithmetic::per_things::Perbill;
use sp_npos_elections::{
	evaluate_support, seq_phragmen, to_supports, BalancingConfig, ElectionScore, StakedAssignment,
	VoteWeight,
};

// AccountId for the solver: just the candidate's index in the snapshot. Cheap and
// IdentifierT-compatible. We carry the SS58 strings separately for reporting.
type Cand = u32;

#[derive(Parser, Debug)]
#[command(about = "Run seq_phragmen over a dumped election snapshot and score it")]
struct Args {
	/// Path to the snapshot JSON produced by `yarn run dump:snapshot`.
	#[arg(long)]
	snapshot: String,

	/// Number of validators to elect. Defaults to the snapshot's on-chain desiredTargets.
	#[arg(long)]
	desired_targets: Option<usize>,

	/// Override the minimal_stake floor to compare against, in WHOLE tokens (e.g. 700000).
	/// Defaults to the snapshot's on-chain minimumScore.minimalStake.
	#[arg(long)]
	min_score_stake: Option<f64>,

	/// Balancing iterations. Runtime default is 10.
	#[arg(long, default_value_t = 10)]
	iterations: usize,

	/// Balancing tolerance. Runtime default is 0.
	#[arg(long, default_value_t = 0)]
	tolerance: u128,

	/// Sweep desired-targets from FIRST down to SECOND (inclusive), step 10, and
	/// print a table. e.g. `--sweep 600 500`.
	#[arg(long, num_args = 2, value_names = ["FROM", "TO"])]
	sweep: Option<Vec<usize>>,
}

#[derive(Deserialize)]
struct Snapshot {
	meta: Meta,
	#[serde(rename = "desiredTargets")]
	desired_targets: usize,
	#[serde(rename = "minimumScore")]
	minimum_score: MinScore,
	solver: Solver,
}

#[derive(Deserialize)]
struct Meta {
	round: u32,
	decimals: u32,
	token: String,
}

#[derive(Deserialize)]
struct MinScore {
	#[serde(rename = "minimalStake")]
	minimal_stake: String,
	#[serde(rename = "sumStake")]
	sum_stake: String,
	#[serde(rename = "sumStakeSquared")]
	sum_stake_squared: String,
}

#[derive(Deserialize)]
struct Solver {
	candidates: Vec<String>,
	// [voterIdx, stakePlanck(string), [candidateIdx, ...]]
	voters: Vec<(u32, String, Vec<u32>)>,
}

fn main() {
	let args = Args::parse();
	let raw = std::fs::read_to_string(&args.snapshot).expect("read snapshot file");
	let snap: Snapshot = serde_json::from_str(&raw).expect("parse snapshot json");

	let unit = 10u128.pow(snap.meta.decimals);
	let token = &snap.meta.token;
	let fmt = |planck: u128| -> String {
		let whole = planck / unit;
		let frac = (planck % unit) * 10_000 / unit;
		format!("{}.{:04} {}", with_commas(whole), frac, token)
	};

	// Build the candidate id list (indices) and the voter list once.
	let candidates: Vec<Cand> = (0..snap.solver.candidates.len() as u32).collect();
	let voters: Vec<(Cand, VoteWeight, Vec<Cand>)> = snap
		.solver
		.voters
		.iter()
		.map(|(idx, stake, targets)| {
			let w: VoteWeight = stake.parse::<u128>().expect("voter stake") as VoteWeight;
			(*idx, w, targets.clone())
		})
		.collect();

	// The on-chain gate is `score.strict_better(minimum_score)` — a lexicographic
	// comparison over (minimal_stake ↑, sum_stake ↑, sum_stake_squared ↓), NOT a
	// per-component floor. In practice an exact tie on minimal_stake never happens,
	// so it reduces to `minimal_stake > min.minimal_stake`, but we implement the
	// full lexicographic rule for fidelity.
	let mut min_score = ElectionScore {
		minimal_stake: snap.minimum_score.minimal_stake.parse().unwrap(),
		sum_stake: snap.minimum_score.sum_stake.parse().unwrap(),
		sum_stake_squared: snap.minimum_score.sum_stake_squared.parse().unwrap(),
	};
	// optional override of the minimal_stake component (whole tokens)
	if let Some(tokens) = args.min_score_stake {
		min_score.minimal_stake = (tokens * unit as f64) as u128;
	}

	println!(
		"Snapshot: round {}, {} candidates, {} voters",
		snap.meta.round,
		candidates.len(),
		voters.len()
	);
	println!(
		"minimumScore gate (must be strict_better): minimal_stake={}, sum_stake={}, sum_stake_squared={}\n",
		fmt(min_score.minimal_stake),
		fmt(min_score.sum_stake),
		min_score.sum_stake_squared
	);

	let cfg = BalancingConfig { iterations: args.iterations, tolerance: args.tolerance };

	let run = |to_elect: usize| -> ElectionScore {
		let res = seq_phragmen::<Cand, Perbill>(
			to_elect,
			candidates.clone(),
			voters.clone(),
			Some(cfg.clone()),
		)
		.expect("seq_phragmen");

		// stake lookup for converting ratio-assignments to staked-assignments
		let stake_of = |idx: &Cand| -> VoteWeight {
			voters
				.iter()
				.find(|(v, _, _)| v == idx)
				.map(|(_, w, _)| *w)
				.unwrap_or(0)
		};

		let staked: Vec<StakedAssignment<Cand>> = res
			.assignments
			.into_iter()
			.map(|a| {
				let budget = stake_of(&a.who) as u128;
				a.into_staked(budget)
			})
			.collect();

		let supports = to_supports(&staked);
		evaluate_support(supports.iter().map(|(_, s)| s))
	};

	match args.sweep {
		Some(range) => {
			let (from, to) = (range[0], range[1]);
			println!(
				"{:>8} | {:>22} | {:>22} | {:>34} | strict_better?",
				"targets", "minimal_stake", "sum_stake", "sum_stake_squared"
			);
			println!("{}", "-".repeat(108));
			let mut n = from;
			loop {
				let score = run(n);
				let pass = strict_better(&score, &min_score);
				println!(
					"{:>8} | {:>22} | {:>22} | {:>34} | {}",
					n,
					fmt(score.minimal_stake),
					fmt(score.sum_stake),
					score.sum_stake_squared,
					if pass { "YES" } else { "no" }
				);
				if n <= to || n < 10 {
					break;
				}
				n -= 10;
			}
		}
		None => {
			let to_elect = args.desired_targets.unwrap_or(snap.desired_targets);
			println!("Electing {} validators...\n", to_elect);
			let score = run(to_elect);
			println!("=== Result (desired_targets = {}) ===", to_elect);
			println!("  minimal_stake     : {}", fmt(score.minimal_stake));
			println!("  sum_stake         : {}", fmt(score.sum_stake));
			println!("  sum_stake_squared : {}", score.sum_stake_squared);
			println!();

			// Per-component view of the lexicographic gate.
			let ms = component_word(score.minimal_stake, min_score.minimal_stake, false);
			let ss = component_word(score.sum_stake, min_score.sum_stake, false);
			let sq = component_word(score.sum_stake_squared, min_score.sum_stake_squared, true);
			println!("  vs minimumScore (lexicographic strict_better):");
			println!("    minimal_stake     {} {}", ms, fmt(min_score.minimal_stake));
			println!("    sum_stake         {} {}", ss, fmt(min_score.sum_stake));
			println!("    sum_stake_squared {} {} (lower is better)", sq, min_score.sum_stake_squared);
			println!();
			println!(
				"  FULL SCORE: {}",
				if strict_better(&score, &min_score) {
					"PASS ✅ (strict_better than minimumScore)"
				} else {
					"FAIL ❌ (not strict_better than minimumScore)"
				}
			);
		}
	}
}

/// Mirror of `ElectionScore::strict_better` (threshold = 0): lexicographic over
/// (minimal_stake ↑, sum_stake ↑, sum_stake_squared ↓).
fn strict_better(s: &ElectionScore, min: &ElectionScore) -> bool {
	if s.minimal_stake != min.minimal_stake {
		return s.minimal_stake > min.minimal_stake;
	}
	if s.sum_stake != min.sum_stake {
		return s.sum_stake > min.sum_stake;
	}
	s.sum_stake_squared < min.sum_stake_squared
}

/// "<", "=", ">" describing how `got` compares to `need` (or inverted for ceilings).
fn component_word(got: u128, need: u128, lower_is_better: bool) -> &'static str {
	use std::cmp::Ordering::*;
	let ord = got.cmp(&need);
	match (ord, lower_is_better) {
		(Greater, false) => ">= (ok)",
		(Equal, _) => "== (tie)",
		(Less, false) => "<  (short)",
		(Less, true) => "<  (ok)",
		(Greater, true) => ">  (worse)",
	}
}

fn with_commas(n: u128) -> String {
	let s = n.to_string();
	let bytes = s.as_bytes();
	let mut out = String::new();
	let len = bytes.len();
	for (i, b) in bytes.iter().enumerate() {
		if i > 0 && (len - i) % 3 == 0 {
			out.push(',');
		}
		out.push(*b as char);
	}
	out
}
