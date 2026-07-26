# Integration scenarios

Every scenario drives the chain explicitly (mine / invalidate / broadcast —
never wait for anything the test didn't cause) and observes through **two
independent observers**: our block-walking tracker and bitcoind's watch-only
descriptor wallet. Ground truth is always re-readable because regtest state
is fully test-controlled. Finality depth `N` is a parameter (default 6);
every credit boundary is asserted as a triplet at `N-1 / N / N+1`.

*Falsification lever* names the sabotage (`FALSIFY=<id>` harness mode or
`defect/*` branch) that proves the test can fail — the no-vacuous-passes
rule. Defect-branch mapping lives in
[`milestone-plan.md`](milestone-plan.md) §M7.

## Derivation & watch-only descriptors (M2)

| ID | Scenario | Invariant asserted | Custody risk it maps to | Falsification lever |
|---|---|---|---|---|
| DR-01 | Derive receive+change addresses from the published BIP84/BIP86 **account-level public keys** (unit, mainnet vectors) | Byte-exact match with the published vector addresses at first, second, and last published index | Deposits invited to addresses the signer can't spend or the watcher doesn't watch — silent, permanent fund loss | `FALSIFY=DR-01` swaps receive/change branch in the derivation path |
| DR-02 | Same descriptor, range [0,49], derived by the library (regtest) and by `deriveaddresses` | Identical address lists, receive and change chains | Watcher/signer drift: two components derive differently and deposits fall between them | `FALSIFY=DR-02` shifts the library range by one |
| DR-03 | Import ranged descriptors into a `disable_private_keys` wallet; deposit to a derived address; mine 1 | Wallet reports `private_keys_enabled=false`; deposit is detected with **zero key material present** | Private keys creeping into watching infrastructure — breach blast radius becomes total | `FALSIFY=DR-03` skips the import — detection assertion must fire |
| DR-04 | Feed mainnet-encoded material (bc1…, xpub-for-mainnet) to the regtest-configured library and vice versa | Typed rejection; never silently re-encoded to the other network | Cross-network address confusion — funds burned to an address nobody controls on that chain | `FALSIFY=DR-04` disables the network guard |

## Deposit detection & confirmation depth (M3)

| ID | Scenario | Invariant asserted | Custody risk it maps to | Falsification lever |
|---|---|---|---|---|
| CF-01 | Broadcast a deposit to a watched address; mine **nothing** | State is `SEEN_MEMPOOL`, `credited=false`; visible as pending only, in both observers | 0-conf crediting — the classic double-spend acceptance fraud | `FALSIFY=CF-01` marks mempool sightings credited |
| CF-02 | Mine to exactly `N-1`, assert, mine 1 more, assert, mine 1 more | `credited` flips false→true **exactly at `N`** — triplet `N-1 / N / N+1` | Off-by-one premature credit (one confirmation early is one reorg away from loss) | `defect/credit-at-one-conf`; `FALSIFY=CF-02` sets threshold `N-1` |
| CF-03 | (Unit, fast-check) random valid connect-event sequences into the state machine | Tracker state ≡ oracle recomputation from full history; `confirmations = tip − inclusionHeight + 1`; only legal transitions ever taken | State-machine drift under real event streams — corruption that surfaces weeks later as unexplained balances | `FALSIFY=CF-03` perturbs the oracle by one block |
| CF-04 | Process a block window; restart the tracker from its checkpoint; re-poll the same window | Exactly one credit per deposit **ever**; replay changes nothing (both observers agree) | Double-credit on rescan/restart — free money printed by an ops routine | `FALSIFY=CF-04` drops the checkpoint, forcing a full re-count |
| CF-05 | One transaction paying two watched addresses; two deposits to one address | One deposit record per (outpoint), each credited once at `N` | Aggregation bugs: under-credit loses client funds, over-credit loses house funds | `FALSIFY=CF-05` keys records on txid instead of outpoint |

## Reorg handling (M4)

Two reorg flavours, deliberately distinct: after `invalidateblock`, a
disconnected block's transactions **re-enter the mempool** if still valid
(RG-01 — the deposit is demoted, not gone); the deposit only vanishes for
good when the competing chain **double-spends its input** (RG-03, mined via
`generateblock` with a crafted raw tx — under full-RBF a well-funded
conflict would *replace* the deposit instead, and an underpaying one is
refused with `insufficient fee, rejecting replacement`).

| ID | Scenario | Invariant asserted | Custody risk it maps to | Falsification lever |
|---|---|---|---|---|
| RG-01 | **Headline.** Deposit at depth `d < N`; invalidate its containing chain; mine a competing chain without it | Pending state reverts to `SEEN_MEMPOOL`/0-conf; `credited=false` **throughout**; any provisional accounting entry reversed | Crediting money the chain no longer contains — the exact insolvency mechanism reorgs enable | `defect/credit-at-one-conf` + `defect/reorg-uncredit-missed`; `FALSIFY=RG-01` suppresses disconnect events |
| RG-02 | Reorg as RG-01, but the competing chain re-includes the tx at a different height | Confirmations recompute from the **new** inclusion height; credit happens once, only when new-chain depth ≥ `N`; never double-credited across the reorg | Double-credit during reorg reconciliation | `FALSIFY=RG-02` retains the stale inclusion height |
| RG-03 | Competing chain carries a **conflicting spend** of the deposit's input (raw tx via `generateblock`) | Deposit → terminal `CONFLICTED`; never credited; conflict surfaced as an alertable event | Double-spend fraud passing unnoticed — the attack reorgs exist for | `FALSIFY=RG-03` treats conflicted as still-pending |
| RG-04 | Deposit credited at `≥ N`; force a reorg deeper than `N` | Credited balance does **not** silently change; `FINALITY_VIOLATION` alert raised (policy: sticky credit + alarm, per ADR-0002) | Silent insolvency (or an equally silent clawback) after a finality-depth failure | `FALSIFY=RG-04` suppresses the alert |
| RG-05 | Reorg to chain B, then `reconsiderblock` back to A | Final state ≡ the never-reorged run; exactly-once credit despite chain flapping | State corruption under repeated tip churn (unstable peers, eclipse recovery) | `FALSIFY=RG-05` replays connect events without dedup |
| RG-06 | Deposit first seen **on-chain** (no poll while it sat in the mempool), credited at `N`, reorged out so it re-enters the mempool, then re-mined past `N` again | The mempool re-sighting never downgrades the existing record; credit stays latched at its original height; **exactly one** credit event though the deposit reaches depth `N` twice | Double-credit via resurrection — the same deposit paid out twice because a second sighting looked like a first | `defect/rebroadcast-double-credit`; `FALSIFY=RG-06` drops the watcher's state mid-run |

## Transaction construction & fee policy (M5)

| ID | Scenario | Invariant asserted | Custody risk it maps to | Falsification lever |
|---|---|---|---|---|
| TX-01 | Build a spend of watched UTXOs (unit + integration) | `Σ inputs = Σ outputs + fee` **exactly**, in bigint sats; change to the correct next internal-chain index | Fee leak / value destruction; change-address reuse breaking audit trails | `FALSIFY=TX-01` drops one satoshi into fee |
| TX-02 | Concurrent builds over one UTXO set; UTXOs at depths `N-1` and `N` | Only `≥ N`-conf UTXOs selectable; an in-flight-reserved UTXO is never selected twice | Spending unsettled deposits; the custodian double-spending **itself** under load | `FALSIFY=TX-02` disables the reservation |
| TX-03 | Build at a target feerate; dust-sized change; submit via `testmempoolaccept` | Achieved feerate within declared tolerance of target; dust folded into fee, never emitted; node accepts | Unrelayable withdrawals (stuck queue) or systematic fee overpay | `FALSIFY=TX-03` emits the dust output |
| FE-01 | Call the fee policy against real regtest `estimatesmartfee` (which fails: no history) | Failure is typed and expected; policy falls back to the configured floor; builder still produces an acceptable tx | Withdrawal outage the moment the estimator degrades — a live-incident classic | `FALSIFY=FE-01` makes fallback throw instead |
| FE-02 | (Unit, fast-check) arbitrary estimator outputs: absurd-high, absurd-low, zero, error | Chosen feerate always ∈ `[floor, ceiling]` | Hot-wallet drain via one absurd estimate paid as fees | `FALSIFY=FE-02` removes the ceiling clamp |

## Broadcast idempotency & conflicts (M6)

| ID | Scenario | Invariant asserted | Custody risk it maps to | Falsification lever |
|---|---|---|---|---|
| BR-01 | `sendrawtransaction` the identical raw tx ×k (k ≥ 3) while unconfirmed | Node-level semantics pinned (characterization); exactly one mempool entry, one ledger record, UTXO spent once; accounting byte-identical after retry 1..k | Retry-storm double-debit — rebroadcast is routine ops, it must be free | `defect/rebroadcast-double-credit`; `FALSIFY=BR-01` records per broadcast attempt |
| BR-02 | Rebroadcast after the tx is mined (at 1 and at `N` conf) | "Already known/mined" is a terminal success, state unchanged — no error-path corruption, no duplicate record | Crash-looping settlement workers; duplicate settlement on retry-after-confirm | `FALSIFY=BR-02` treats the node error as a fresh failure |
| BR-03 | Broadcast a tx whose input is already spent by a conflicting mempool/chain tx | Typed rejection surfaced; withdrawal reaches a terminal failed state; UTXO accounting intact, no partial debit | Withdrawals stuck "in-flight forever" while support pages the on-call | `FALSIFY=BR-03` swallows the rejection |
