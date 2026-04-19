//! Core domain types for the smart-account contract.
//!
//! These are intentionally kept free of any contract-specific logic so they can
//! be consumed by other contracts and off-chain tooling via the
//! `smart-account-types` crate.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{near, AccountId};

/// Per-step safety policy: how a step in a multi-step plan should resolve
/// before the smart account advances to the next step.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum StepPolicy {
    /// Treat the target receipt's own outcome as truth.
    #[default]
    Direct,
    /// Dispatch to an adapter contract that exposes one honest top-level
    /// success/failure surface for a protocol with messy internal async work.
    Adapter {
        adapter_id: AccountId,
        adapter_method: String,
    },
    /// Post-call assertion mode. After the target resolves successfully, fire
    /// a caller-specified postcheck call and advance the sequence only if the
    /// postcheck returns bytes matching `expected_return` exactly. Mismatch
    /// halts the sequence as `DownstreamFailed`, same as any other resolve
    /// failure.
    Asserted {
        /// Contract hosting the postcheck call. Often the target itself
        /// (asking the target to prove its own state), but any contract works.
        assertion_id: AccountId,
        /// Method on `assertion_id` to call after the target resolves. Called
        /// as a regular FunctionCall receipt (not an enforced read-only view),
        /// so gas and receipts are real and the caller must choose a
        /// trustworthy postcheck surface.
        assertion_method: String,
        /// Raw bytes the postcheck call receives as its JSON body. Use
        /// base64-of-`{}` (`"e30="`) on the wire for no-arg methods.
        assertion_args: Base64VecU8,
        /// Exact bytes the postcheck call must return. Compared byte-for-byte
        /// against `env::promise_result_checked(0, MAX_CALLBACK_RESULT_BYTES)`.
        expected_return: Base64VecU8,
        /// Gas for the `assertion_id.assertion_method` postcheck FunctionCall,
        /// in TGas.
        assertion_gas_tgas: u64,
    },
}

/// Standard argument shape the smart account uses when dispatching an adapter
/// policy call.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdapterDispatchInput {
    pub target_id: AccountId,
    pub method_name: String,
    pub args: Base64VecU8,
    pub attached_deposit_yocto: U128,
    pub gas_tgas: u64,
}

/// How a `PreGate` compares the gate's returned bytes to its configured
/// `min_bytes` / `max_bytes` bounds.
///
/// - `U128Json` / `I128Json`: the bytes are a JSON string of a u128/i128
///   (the NEP-245 `mt_balance_of` and NEP-141 `ft_balance_of` convention).
///   Strip the enclosing quotes, parse as the numeric type, compare
///   numerically against the bounds (which must parse the same way).
/// - `LexBytes`: compare raw bytes lexicographically. Useful for sentinel
///   strings, bitmasks, or any gate whose return is not a number.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ComparisonKind {
    U128Json,
    I128Json,
    LexBytes,
}

/// Pre-dispatch gate on a `Step`. Before the kernel dispatches the step's
/// target `FunctionCall`, it fires `gate_id.gate_method(gate_args)`, reads
/// the returned bytes, and compares them to `[min_bytes, max_bytes]` under
/// `comparison`. Advance-and-dispatch only if in range; halt the sequence
/// otherwise.
///
/// Pairs with (not replaces) `StepPolicy`: pre-gate controls whether the
/// target fires at all, while `StepPolicy` controls how the target's own
/// resolution is interpreted post-dispatch.
///
/// Common use case: limit orders. Before firing a swap, check the live
/// quote is inside the acceptable range; halt if not.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreGate {
    /// Contract hosting the gate view / function. Often a price oracle, a
    /// balance view, or a freshness sentinel.
    pub gate_id: AccountId,
    /// Method on `gate_id` to call before the target. Called as a regular
    /// `FunctionCall` receipt (not an enforced read-only view), so gas is
    /// real and the caller must choose a trustworthy gate surface.
    pub gate_method: String,
    /// Raw bytes passed as the gate call's JSON body. Use base64-of-`{}`
    /// (`"e30="`) on the wire for no-arg gates.
    pub gate_args: Base64VecU8,
    /// Inclusive lower bound. `None` means unbounded below.
    pub min_bytes: Option<Base64VecU8>,
    /// Inclusive upper bound. `None` means unbounded above.
    pub max_bytes: Option<Base64VecU8>,
    /// How to compare `actual` against `[min, max]`.
    pub comparison: ComparisonKind,
    /// Gas for the `gate_id.gate_method` call, in TGas.
    pub gate_gas_tgas: u64,
}

/// Result of evaluating a `PreGate` against the gate call's return bytes.
/// Exposed so kernel code + tests share one decision function.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreGateOutcome {
    InRange,
    BelowMin,
    AboveMax,
    ComparisonError,
}

impl PreGateOutcome {
    pub fn matched(self) -> bool {
        matches!(self, PreGateOutcome::InRange)
    }
    pub fn outcome_tag(self) -> &'static str {
        match self {
            PreGateOutcome::InRange => "in_range",
            PreGateOutcome::BelowMin => "below_min",
            PreGateOutcome::AboveMax => "above_max",
            PreGateOutcome::ComparisonError => "comparison_error",
        }
    }
}

/// Pure decision function. Given the bytes the gate returned and the
/// configured bounds + comparison kind, decide whether the step advances.
///
/// - `actual` is the raw bytes from the gate's `promise_result`.
/// - Returns `PreGateOutcome::InRange` iff both bounds (if present) are
///   satisfied.
/// - Numeric comparisons (`U128Json` / `I128Json`) parse both bounds and
///   `actual` as JSON-string-encoded integers (e.g. `"12345"`). Any parse
///   failure returns `ComparisonError`.
/// - `LexBytes` compares the raw bytes.
pub fn evaluate_pre_gate(
    actual: &[u8],
    min_bytes: Option<&[u8]>,
    max_bytes: Option<&[u8]>,
    comparison: ComparisonKind,
) -> PreGateOutcome {
    match comparison {
        ComparisonKind::U128Json => {
            let actual = match parse_u128_json(actual) {
                Some(v) => v,
                None => return PreGateOutcome::ComparisonError,
            };
            if let Some(min) = min_bytes {
                match parse_u128_json(min) {
                    Some(m) if actual < m => return PreGateOutcome::BelowMin,
                    None => return PreGateOutcome::ComparisonError,
                    _ => {}
                }
            }
            if let Some(max) = max_bytes {
                match parse_u128_json(max) {
                    Some(m) if actual > m => return PreGateOutcome::AboveMax,
                    None => return PreGateOutcome::ComparisonError,
                    _ => {}
                }
            }
            PreGateOutcome::InRange
        }
        ComparisonKind::I128Json => {
            let actual = match parse_i128_json(actual) {
                Some(v) => v,
                None => return PreGateOutcome::ComparisonError,
            };
            if let Some(min) = min_bytes {
                match parse_i128_json(min) {
                    Some(m) if actual < m => return PreGateOutcome::BelowMin,
                    None => return PreGateOutcome::ComparisonError,
                    _ => {}
                }
            }
            if let Some(max) = max_bytes {
                match parse_i128_json(max) {
                    Some(m) if actual > m => return PreGateOutcome::AboveMax,
                    None => return PreGateOutcome::ComparisonError,
                    _ => {}
                }
            }
            PreGateOutcome::InRange
        }
        ComparisonKind::LexBytes => {
            if let Some(min) = min_bytes {
                if actual < min {
                    return PreGateOutcome::BelowMin;
                }
            }
            if let Some(max) = max_bytes {
                if actual > max {
                    return PreGateOutcome::AboveMax;
                }
            }
            PreGateOutcome::InRange
        }
    }
}

/// Parse a u128 out of bytes that look like a JSON-string-encoded integer:
/// either `"12345"` (with quotes) or `12345` (bare). Returns `None` on any
/// parse error or surrounding noise.
pub fn parse_u128_json(bytes: &[u8]) -> Option<u128> {
    let trimmed = trim_json_quotes(bytes);
    let s = core::str::from_utf8(trimmed).ok()?;
    s.trim().parse::<u128>().ok()
}

pub fn parse_i128_json(bytes: &[u8]) -> Option<i128> {
    let trimmed = trim_json_quotes(bytes);
    let s = core::str::from_utf8(trimmed).ok()?;
    s.trim().parse::<i128>().ok()
}

fn trim_json_quotes(bytes: &[u8]) -> &[u8] {
    match bytes {
        [b'"', inner @ .., b'"'] => inner,
        other => other,
    }
}

// -------------------------------------------------------------------
// Value threading — capture a step's return bytes, reference them in
// a later step's args via a small substitution language.
// -------------------------------------------------------------------

/// How a successful step's promise result should be saved into the
/// sequence context for later reference.
///
/// `as_name` names the slot the bytes land in; later steps'
/// `ArgsTemplate` references `"${<as_name>}"` to splice them in.
///
/// `kind` documents how downstream substitution ops should interpret
/// the saved bytes (parallel to `ComparisonKind` — `U128Json`,
/// `I128Json`, or `LexBytes`). It is advisory: the actual op chosen
/// at substitution time decides the parse path.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaveResult {
    pub as_name: String,
    pub kind: ComparisonKind,
}

/// Args template for a step — an alternative to static `args` bytes.
/// If a `Step` has `args_template: Some(...)`, the kernel materializes
/// the real args at dispatch time by running each `Substitution` in
/// order against the surrounding sequence context, then using the
/// produced bytes as the target FunctionCall's args.
///
/// Template syntax: the template is raw bytes (typically JSON). A
/// placeholder of the form `"${<saved_result_name>}"` (WITH the
/// enclosing JSON quotes) is replaced by each substitution's produced
/// bytes. Whether the replacement bytes themselves carry quotes is up
/// to the substitution op — `Raw` splices whatever was saved verbatim;
/// numeric ops emit JSON-string-wrapped u128s for NEP-141/NEP-245
/// compatibility.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArgsTemplate {
    pub template: Base64VecU8,
    pub substitutions: Vec<Substitution>,
}

/// One substitution: find every `"${<reference>}"` placeholder in the
/// template and replace it with the output of `op` applied to the
/// saved result bytes named `reference`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Substitution {
    pub reference: String,
    pub op: SubstitutionOp,
}

/// Transformations we apply to a captured value before splicing it
/// into the template. Intentionally narrow in v1 — `Raw` +
/// `DivU128` + `PercentU128` cover the ladder-swap flagship and
/// most "use prior step's number" cases. More ops (json-path, string
/// manipulation) can land additively.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubstitutionOp {
    /// Splice the captured bytes verbatim (whatever shape they are).
    Raw,
    /// Parse captured bytes as a u128 (quoted or bare JSON), divide
    /// by `denominator`, re-emit as a JSON-string-quoted u128
    /// (the NEP-141/NEP-245 convention).
    DivU128 { denominator: U128 },
    /// Parse captured bytes as a u128, multiply by `bps / 10_000`
    /// (basis points — 5000 = 50%, 10000 = 100%), re-emit as a
    /// JSON-string-quoted u128. Rejects bps > 10_000 at dispatch.
    PercentU128 { bps: u32 },
}

/// Errors `materialize_args` can produce. Kept narrow for v1.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MaterializeError {
    /// A substitution referenced a saved-result name not present in
    /// the sequence context at dispatch time. Usually means a prior
    /// step didn't save, or the template used the wrong name.
    MissingSavedResult(String),
    /// The saved bytes for a reference couldn't be parsed by the
    /// op's expected format (e.g. `DivU128` but the saved wasn't a
    /// u128 JSON).
    UnparseableSavedResult { reference: String, op: &'static str },
    /// Arithmetic overflow while computing a transformed value.
    NumericOverflow { reference: String, op: &'static str },
    /// PercentU128 bps > 10_000 would mean >100% — rejected.
    InvalidBps(u32),
    /// The placeholder `"${<reference>}"` wasn't found in the
    /// template but a substitution for it was declared. Usually a
    /// template typo — reject at materialize time so callers see
    /// the failure.
    PlaceholderNotFound(String),
}

impl core::fmt::Display for MaterializeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            MaterializeError::MissingSavedResult(name) => {
                write!(f, "materialize: missing saved result '{name}'")
            }
            MaterializeError::UnparseableSavedResult { reference, op } => {
                write!(
                    f,
                    "materialize: saved result '{reference}' not parseable for op '{op}'"
                )
            }
            MaterializeError::NumericOverflow { reference, op } => {
                write!(
                    f,
                    "materialize: numeric overflow in op '{op}' on saved result '{reference}'"
                )
            }
            MaterializeError::InvalidBps(bps) => {
                write!(f, "materialize: bps {bps} exceeds 10000 (100%)")
            }
            MaterializeError::PlaceholderNotFound(t) => {
                write!(
                    f,
                    "materialize: placeholder \"${{{t}}}\" not found in template"
                )
            }
        }
    }
}

impl MaterializeError {
    pub fn kind_tag(&self) -> &'static str {
        match self {
            MaterializeError::MissingSavedResult(_) => "missing_saved_result",
            MaterializeError::UnparseableSavedResult { .. } => "unparseable_saved_result",
            MaterializeError::NumericOverflow { .. } => "numeric_overflow",
            MaterializeError::InvalidBps(_) => "invalid_bps",
            MaterializeError::PlaceholderNotFound(_) => "placeholder_not_found",
        }
    }
}

/// Materialize the final args bytes for a step that has an
/// `ArgsTemplate`. Pure function: no `env` calls, no state mutation.
/// The kernel calls this at dispatch time with the sequence's saved
/// results map.
///
/// Returns `Ok(bytes)` on success, `Err(MaterializeError)` otherwise.
/// The kernel treats errors as a halt condition (same as a pre-gate
/// comparison failure or an Asserted mismatch).
pub fn materialize_args(
    template: &[u8],
    substitutions: &[Substitution],
    saved_results: &std::collections::HashMap<String, Vec<u8>>,
) -> Result<Vec<u8>, MaterializeError> {
    // Start with the template as a String (lossy-decoded — non-UTF-8
    // templates are rare for JSON payloads, but if somebody ships
    // raw borsh-over-placeholder we'll still replace correctly as
    // long as placeholders themselves are ASCII).
    let mut out = String::from_utf8_lossy(template).into_owned();

    for sub in substitutions {
        let saved = saved_results
            .get(&sub.reference)
            .ok_or_else(|| MaterializeError::MissingSavedResult(sub.reference.clone()))?;
        let replacement = apply_substitution_op(saved, &sub.op, &sub.reference)?;
        let placeholder = format!("\"${{{}}}\"", sub.reference);
        if !out.contains(&placeholder) {
            return Err(MaterializeError::PlaceholderNotFound(sub.reference.clone()));
        }
        out = out.replace(&placeholder, &replacement);
    }

    Ok(out.into_bytes())
}

/// Apply one substitution op to saved bytes, returning the
/// replacement string (including quotes where appropriate for JSON
/// compatibility).
fn apply_substitution_op(
    saved: &[u8],
    op: &SubstitutionOp,
    reference: &str,
) -> Result<String, MaterializeError> {
    match op {
        SubstitutionOp::Raw => Ok(String::from_utf8_lossy(saved).into_owned()),
        SubstitutionOp::DivU128 { denominator } => {
            let n = parse_u128_json(saved).ok_or_else(|| {
                MaterializeError::UnparseableSavedResult {
                    reference: reference.to_owned(),
                    op: "DivU128",
                }
            })?;
            let d = denominator.0;
            if d == 0 {
                return Err(MaterializeError::InvalidBps(0));
            }
            let result = n / d;
            Ok(format!("\"{}\"", result))
        }
        SubstitutionOp::PercentU128 { bps } => {
            if *bps > 10_000 {
                return Err(MaterializeError::InvalidBps(*bps));
            }
            let n = parse_u128_json(saved).ok_or_else(|| {
                MaterializeError::UnparseableSavedResult {
                    reference: reference.to_owned(),
                    op: "PercentU128",
                }
            })?;
            let result = n
                .checked_mul(*bps as u128)
                .ok_or_else(|| MaterializeError::NumericOverflow {
                    reference: reference.to_owned(),
                    op: "PercentU128",
                })?
                / 10_000u128;
            Ok(format!("\"{}\"", result))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(s: &str) -> Vec<u8> {
        s.as_bytes().to_vec()
    }

    #[test]
    fn u128_json_in_range_inclusive_bounds() {
        let actual = b("\"500\"");
        let min = b("\"100\"");
        let max = b("\"1000\"");
        assert_eq!(
            evaluate_pre_gate(
                &actual,
                Some(&min),
                Some(&max),
                ComparisonKind::U128Json,
            ),
            PreGateOutcome::InRange
        );
    }

    #[test]
    fn u128_json_edge_equality_at_min_and_max() {
        assert_eq!(
            evaluate_pre_gate(
                b"\"100\"",
                Some(b"\"100\""),
                Some(b"\"1000\""),
                ComparisonKind::U128Json,
            ),
            PreGateOutcome::InRange
        );
        assert_eq!(
            evaluate_pre_gate(
                b"\"1000\"",
                Some(b"\"100\""),
                Some(b"\"1000\""),
                ComparisonKind::U128Json,
            ),
            PreGateOutcome::InRange
        );
    }

    #[test]
    fn u128_json_below_min() {
        assert_eq!(
            evaluate_pre_gate(
                b"\"50\"",
                Some(b"\"100\""),
                None,
                ComparisonKind::U128Json,
            ),
            PreGateOutcome::BelowMin
        );
    }

    #[test]
    fn u128_json_above_max() {
        assert_eq!(
            evaluate_pre_gate(
                b"\"2000\"",
                None,
                Some(b"\"1000\""),
                ComparisonKind::U128Json,
            ),
            PreGateOutcome::AboveMax
        );
    }

    #[test]
    fn u128_json_unquoted_also_parses() {
        assert_eq!(
            evaluate_pre_gate(
                b"500",
                Some(b"\"100\""),
                Some(b"1000"),
                ComparisonKind::U128Json,
            ),
            PreGateOutcome::InRange
        );
    }

    #[test]
    fn u128_json_unbounded_on_both_sides_is_in_range() {
        assert_eq!(
            evaluate_pre_gate(
                b"\"999999999999999999999999\"",
                None,
                None,
                ComparisonKind::U128Json,
            ),
            PreGateOutcome::InRange
        );
    }

    #[test]
    fn u128_json_garbage_bytes_are_comparison_error() {
        assert_eq!(
            evaluate_pre_gate(
                b"not a number",
                Some(b"\"0\""),
                None,
                ComparisonKind::U128Json,
            ),
            PreGateOutcome::ComparisonError
        );
    }

    #[test]
    fn i128_json_negative_below_positive_min() {
        assert_eq!(
            evaluate_pre_gate(
                b"\"-1\"",
                Some(b"\"0\""),
                None,
                ComparisonKind::I128Json,
            ),
            PreGateOutcome::BelowMin
        );
    }

    #[test]
    fn i128_json_negative_in_negative_range() {
        assert_eq!(
            evaluate_pre_gate(
                b"\"-5\"",
                Some(b"\"-10\""),
                Some(b"\"-1\""),
                ComparisonKind::I128Json,
            ),
            PreGateOutcome::InRange
        );
    }

    #[test]
    fn lex_bytes_compares_raw_bytes() {
        // "acceptable" sorts between "abort" and "zzz"
        assert_eq!(
            evaluate_pre_gate(
                b"acceptable",
                Some(b"abort"),
                Some(b"zzz"),
                ComparisonKind::LexBytes,
            ),
            PreGateOutcome::InRange
        );
        assert_eq!(
            evaluate_pre_gate(
                b"aaa",
                Some(b"abort"),
                None,
                ComparisonKind::LexBytes,
            ),
            PreGateOutcome::BelowMin
        );
    }

    #[test]
    fn pre_gate_outcome_tags() {
        assert_eq!(PreGateOutcome::InRange.outcome_tag(), "in_range");
        assert_eq!(PreGateOutcome::BelowMin.outcome_tag(), "below_min");
        assert_eq!(PreGateOutcome::AboveMax.outcome_tag(), "above_max");
        assert_eq!(
            PreGateOutcome::ComparisonError.outcome_tag(),
            "comparison_error"
        );
        assert!(PreGateOutcome::InRange.matched());
        assert!(!PreGateOutcome::BelowMin.matched());
    }

    // -------------------------------------------------------------------
    // materialize_args — value-threading substitution engine
    // -------------------------------------------------------------------

    use std::collections::HashMap;

    fn saved(entries: &[(&str, &[u8])]) -> HashMap<String, Vec<u8>> {
        entries
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.to_vec()))
            .collect()
    }

    #[test]
    fn materialize_raw_splices_saved_bytes_verbatim() {
        let template = br#"{"amount_in":"${balance}","token":"usdc"}"#;
        let subs = vec![Substitution {
            reference: "balance".into(),
            op: SubstitutionOp::Raw,
        }];
        let ctx = saved(&[("balance", b"\"1000000\"")]);
        let out = materialize_args(template, &subs, &ctx).unwrap();
        assert_eq!(
            std::str::from_utf8(&out).unwrap(),
            r#"{"amount_in":"1000000","token":"usdc"}"#
        );
    }

    #[test]
    fn materialize_div_u128_halves_saved() {
        let template = br#"{"half":"${balance}"}"#;
        let subs = vec![Substitution {
            reference: "balance".into(),
            op: SubstitutionOp::DivU128 {
                denominator: U128(2),
            },
        }];
        let ctx = saved(&[("balance", b"\"1000\"")]);
        let out = materialize_args(template, &subs, &ctx).unwrap();
        assert_eq!(std::str::from_utf8(&out).unwrap(), r#"{"half":"500"}"#);
    }

    #[test]
    fn materialize_percent_u128_takes_fraction() {
        let template = br#"{"amount":"${balance}"}"#;
        let subs = vec![Substitution {
            reference: "balance".into(),
            op: SubstitutionOp::PercentU128 { bps: 5000 }, // 50%
        }];
        let ctx = saved(&[("balance", b"\"1000\"")]);
        let out = materialize_args(template, &subs, &ctx).unwrap();
        assert_eq!(std::str::from_utf8(&out).unwrap(), r#"{"amount":"500"}"#);
    }

    #[test]
    fn materialize_percent_u128_rejects_over_100() {
        let template = br#"{"amount":"${balance}"}"#;
        let subs = vec![Substitution {
            reference: "balance".into(),
            op: SubstitutionOp::PercentU128 { bps: 15000 },
        }];
        let ctx = saved(&[("balance", b"\"1000\"")]);
        let err = materialize_args(template, &subs, &ctx).unwrap_err();
        assert!(matches!(err, MaterializeError::InvalidBps(15000)));
    }

    #[test]
    fn materialize_missing_saved_result_fails() {
        let template = br#"{"amount":"${balance}"}"#;
        let subs = vec![Substitution {
            reference: "balance".into(),
            op: SubstitutionOp::Raw,
        }];
        let ctx = saved(&[]); // empty context
        let err = materialize_args(template, &subs, &ctx).unwrap_err();
        assert!(matches!(err, MaterializeError::MissingSavedResult(t) if t == "balance"));
    }

    #[test]
    fn materialize_placeholder_missing_from_template_fails() {
        let template = br#"{"amount":"42"}"#;
        let subs = vec![Substitution {
            reference: "balance".into(),
            op: SubstitutionOp::Raw,
        }];
        let ctx = saved(&[("balance", b"\"500\"")]);
        let err = materialize_args(template, &subs, &ctx).unwrap_err();
        assert!(matches!(err, MaterializeError::PlaceholderNotFound(t) if t == "balance"));
    }

    #[test]
    fn materialize_unparseable_u128_fails_for_numeric_op() {
        let template = br#"{"amount":"${balance}"}"#;
        let subs = vec![Substitution {
            reference: "balance".into(),
            op: SubstitutionOp::DivU128 {
                denominator: U128(2),
            },
        }];
        let ctx = saved(&[("balance", b"not a number")]);
        let err = materialize_args(template, &subs, &ctx).unwrap_err();
        assert!(matches!(
            err,
            MaterializeError::UnparseableSavedResult { op: "DivU128", .. }
        ));
    }

    #[test]
    fn materialize_multiple_substitutions_in_order() {
        let template = br#"{"a":"${x}","b":"${y}"}"#;
        let subs = vec![
            Substitution {
                reference: "x".into(),
                op: SubstitutionOp::Raw,
            },
            Substitution {
                reference: "y".into(),
                op: SubstitutionOp::DivU128 {
                    denominator: U128(3),
                },
            },
        ];
        let ctx = saved(&[("x", b"\"123\""), ("y", b"\"300\"")]);
        let out = materialize_args(template, &subs, &ctx).unwrap();
        assert_eq!(std::str::from_utf8(&out).unwrap(), r#"{"a":"123","b":"100"}"#);
    }

    #[test]
    fn materialize_same_placeholder_repeated_replaces_all_instances() {
        let template = br#"{"from":"${pk}","to":"${pk}"}"#;
        let subs = vec![Substitution {
            reference: "pk".into(),
            op: SubstitutionOp::Raw,
        }];
        let ctx = saved(&[("pk", b"\"mike.near\"")]);
        let out = materialize_args(template, &subs, &ctx).unwrap();
        assert_eq!(
            std::str::from_utf8(&out).unwrap(),
            r#"{"from":"mike.near","to":"mike.near"}"#
        );
    }

    #[test]
    fn materialize_large_u128_percent_overflow_is_caught() {
        let large = format!("\"{}\"", u128::MAX);
        let template = br#"{"x":"${big}"}"#;
        let subs = vec![Substitution {
            reference: "big".into(),
            op: SubstitutionOp::PercentU128 { bps: 10000 },
        }];
        let ctx = saved(&[("big", large.as_bytes())]);
        let err = materialize_args(template, &subs, &ctx).unwrap_err();
        assert!(matches!(
            err,
            MaterializeError::NumericOverflow { op: "PercentU128", .. }
        ));
    }

    #[test]
    fn materialize_empty_substitutions_returns_template_verbatim() {
        let template = br#"{"static":"value"}"#;
        let out = materialize_args(template, &[], &saved(&[])).unwrap();
        assert_eq!(&out, template);
    }

    #[test]
    fn materialize_error_kind_tags_are_stable() {
        assert_eq!(
            MaterializeError::MissingSavedResult("x".into()).kind_tag(),
            "missing_saved_result"
        );
        assert_eq!(
            MaterializeError::PlaceholderNotFound("x".into()).kind_tag(),
            "placeholder_not_found"
        );
        assert_eq!(MaterializeError::InvalidBps(20000).kind_tag(), "invalid_bps");
    }
}
