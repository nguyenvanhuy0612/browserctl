# browserctl specs

What these are, and what they are not.

A **spec** here states a rule the system must obey, why it exists, and what breaks when it does not.
Rules are written so a reader can check the code against them, and most carry the test that guards
them. They are the contract; they are not a tutorial and not a history.

| | Read this when |
|---|---|
| `spec/naming.md` | you need to know what an element will be *called*, or why one came back nameless |
| `spec/census.md` | you need to know what a snapshot contains, omits, and admits to omitting |
| `spec/actions.md` | you need to know what "the action worked" means, and how the response says so |
| `spec/errors.md` | you hit an error code, or you are adding one |
| `spec/invariants.md` | you are changing the census, the dispatch table, or a tool description |
| `spec/testing.md` | you want to know which suite would have caught your bug |

Adjacent documents, deliberately not specs:

- **`../../README.md`** — what the project is and how to install it.
- **`../REFERENCE.md`** — the operator's guide: recipes, failure modes, the tool list. Explains *how to
  use* what the specs *define*.
- **`../../PROTOCOL.md`** — the wire format between bridge, extension and client. Shapes, not rules.
- **`../../CHANGELOG.md`** — what changed per release.
- **`../history/`** — the investigation logs the specs were extracted from. Every rule below was learnt
  by something breaking; when a rule looks arbitrary, the log is where the evidence is. Findings are
  numbered `F1` upward and referenced from the specs as `[F61]`.

## How a rule gets here

A rule earns a place in a spec when it is **load-bearing**: something an agent or a maintainer will get
wrong without it, demonstrated by having actually gone wrong. Rules invented from first principles and
never tested against a real page belong in the backlog, not here.

Each rule states the failure it prevents. A rule whose failure mode cannot be named is not a rule, it
is a preference, and preferences go in the code as comments.
