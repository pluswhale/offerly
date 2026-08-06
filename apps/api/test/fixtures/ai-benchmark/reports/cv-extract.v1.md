# AI benchmark report — cv-extract.v1

- Generated: 2026-07-29T17:07:05.138Z
- Mode: replay (recorded responses, no provider calls; token counts excluded)
- Templates under test: cv-extract.v1 (extraction), cv-validate.v1 (validation, conditional), jd-extract.v1 (JD extraction), match-requirements.v1 (requirement verdicts)
- Dataset: test/fixtures/ai-benchmark

## Aggregate

| Metric | Value |
|---|---|
| Fixtures | 4 |
| Schema validity | 4/4 (100.0%) |
| Evidence-verbatim rate | 144/144 (100.0%) |
| Stated-field precision | 100.0% (tp=83, fp=0) |
| Stated-field recall | 100.0% (tp=83, fn=0) |
| UNKNOWN-correctness | 33/33 (100.0%) |
| Invented expected-unknown fields | 0 |
| Verdict accuracy (4 CV×JD pairs) | 18/18 (100.0%) |
| UNKNOWN↔MISSING confusions | 0 |

## Hard floors (CI)

| Floor | Result |
|---|---|
| 100% schema validity | PASS |
| 100% evidence-verbatim rate on stated facts | PASS |
| Zero invented expected-unknown fields | PASS |
| 100% verdict accuracy on recorded CV×JD pairs | PASS |

## Per fixture

| Fixture | Schema valid | Evidence verbatim | Precision | Recall | UNKNOWN correct | Invented | Validation |
|---|---|---|---|---|---|---|---|
| keyword-stuffed | yes | 49/49 | 100.0% | 100.0% | 9/9 | 0 | skipped (nothing flagged) |
| non-english-russian | yes | 23/23 | 100.0% | 100.0% | 9/9 | 0 | skipped (nothing flagged) |
| senior-multirole | yes | 49/49 | 100.0% | 100.0% | 5/5 | 0 | skipped (nothing flagged) |
| sparse-junior | yes | 23/23 | 100.0% | 100.0% | 10/10 | 0 | skipped (nothing flagged) |

## Requirement verdicts (pre-pass + match-requirements.v1)

| Pair | CV | JD | Verdict accuracy | LLM-classified | UNKNOWN↔MISSING confusions |
|---|---|---|---|---|---|
| senior-multirole--senior-backend-fintech | senior-multirole | senior-backend-fintech | 9/9 (100.0%) | 3 | 0 |
| senior-multirole--vague-rockstar | senior-multirole | vague-rockstar | 0/0 (n/a) | 0 | 0 |
| sparse-junior--senior-backend-fintech | sparse-junior | senior-backend-fintech | 9/9 (100.0%) | 6 | 0 |
| sparse-junior--vague-rockstar | sparse-junior | vague-rockstar | 0/0 (n/a) | 0 | 0 |

## Failures and deviations

None.
