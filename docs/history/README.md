# History

Investigation logs. These are **not specs** — they are chronological, they contain conclusions that
were later corrected, and they record the state of the project on the day they were written.

They are kept because every rule in `../spec/` was learnt by something breaking, and when a rule looks
arbitrary this is where the evidence is. Findings are numbered `F1` upward and cited from the specs
as `[F61]`. A finding cited by a test must have an entry here; that is what makes the citation
checkable.

| File | What it is |
|---|---|
| `fix-plan-v2-verified-2026-09-08.md` | The 0.6.x investigation: every numbered finding, across 22 rounds of driving browserctl with fresh-context agents on live sites, each with its repro and how it was verified. Sections 19-20 are the most useful if you want the *method* rather than the list. |
| `plan-browserctl-v2-agent-intelligence.md` | The original v2 plan. Some of it shipped, some was measured and dropped; the fix-plan's §8 records which. |
| `review-findings-2026-07-03.md` | An earlier code review. |
| `rename-plan.md` | The rename to `browserctl`, completed. |
| *(the Gmail case study, kept locally)* | A Gemini 3.8 Flash session driving Gmail, written by that agent about itself — a worked example of the self-report problem, since the bridge call log for the same session contradicts it. Not published: it quotes a real person's address and phone number from the mail it was reading. The measured numbers and the analysis are §23 of the fix-plan, which carries neither. |
| `claude-for-chrome-open-design-2026-06-30.md` | The original design: what this project set out to be, next to the closed "Claude in Chrome" surface it was measured against. Phase numbering there is historical. |

## Reading these safely

- **A claim here may have been superseded.** The fix-plan corrects itself in place several times — the
  first fix for F70 was wrong, F61's fix was too greedy and caused F65. Where a log and a spec
  disagree, the spec wins.
- **Numbers are as-measured on that day**, against sites that have since changed.
- Nothing here is a to-do list. Open work lives in `../backlog-capability-gaps.md` and
  `../backlog-chrome-devtools-parity.md`.
- This work started from two third-party improvement plans (not published here). They were inputs,
  not decisions: what was taken from them is §4 of the fix-plan, and §8 lists what was rejected and
  why.
