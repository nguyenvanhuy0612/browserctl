# History

Investigation logs. These are **not specs** — they are chronological, they contain conclusions that
were later corrected, and they record the state of the project on the day they were written.

They are kept because every rule in `../spec/` was learnt by something breaking, and when a rule looks
arbitrary this is where the evidence is. Findings are numbered `F1`-`F72` and cited from the specs.

| File | What it is |
|---|---|
| `fix-plan-v2-verified-2026-09-08.md` | The 0.6.x investigation: 72 findings across 21 rounds of driving browserctl with fresh-context agents on live sites, each with its repro and how it was verified. Sections 19-20 are the most useful if you want the *method* rather than the list. |
| `plan-browserctl-v2-agent-intelligence.md` | The original v2 plan. Some of it shipped, some was measured and dropped; the fix-plan's §8 records which. |
| `review-findings-2026-07-03.md` | An earlier code review. |
| `rename-plan.md` | The rename to `browserctl`, completed. |

## Reading these safely

- **A claim here may have been superseded.** The fix-plan corrects itself in place several times — the
  first fix for F70 was wrong, F61's fix was too greedy and caused F65. Where a log and a spec
  disagree, the spec wins.
- **Numbers are as-measured on that day**, against sites that have since changed.
- Nothing here is a to-do list. Open work lives in `../backlog-capability-gaps.md` and
  `../backlog-chrome-devtools-parity.md`.
