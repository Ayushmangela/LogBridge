# Working rules

Short, because a long one goes unread. These are the conventions this repo
has actually paid for — each line exists because breaking it cost something.

## Git

**The repo owner runs every commit and push.** Agents and contributors hand
over a ready-to-paste command and do not run it.

**Never run a git command that changes the working tree, the index, or HEAD**
when someone else may be working in the same checkout:

```
commit  add  stash  checkout  restore  reset  clean  rm  merge  rebase  pull  push
```

`git status`, `diff`, `log`, `show` and `blame` are always fine.

This is not bureaucracy. A `stash` → `commit` → `stash pop` once moved another
stream's uncommitted work; it vanished mid-edit and took real time to diagnose.
`git stash` does not read markdown files and does not respect file ownership.

## Code

**Capture real output. Never write a fixture to match your code.** Parsers,
schedules, CLI flags — go get the actual output first. This rule has caught
three separate parser bugs, including a run that wrote a file and reported
zero tool calls because the parser was written from documentation.

**A test must fail without its fix.** Revert the fix, watch it go red, restore
it. A test that passes either way documents nothing.

**Comments explain *why*, not *what*.** The code already says what.

**Degrade, don't refuse.** When something optional cannot be done — memory
recall, workspace isolation, a permission mode — fall back and log the reason.
A task that fails because a convenience was unavailable is worse than one that
runs without it.

## The contract

`CONTRACT.md` is the single source of truth for anything crossing the wire. If
they disagree, it wins. Bump its version and add a changelog row in the same
commit as the change.

**A field added to a view fed by stored producer data must be optional.** The
gateway validates the whole view and sends *nothing* when validation fails, so
one required field with no value on disk blanks every office until each
producer happens to reconnect. This has happened once already.

## Working in parallel

When two people or agents share this checkout, each stream gets an explicit
file list, and a stream that thinks it needs a file outside its own list stops
and says so rather than editing it.

Note that `apps/runner`'s integration tests import `apps/server`. A
syntactically broken server file blocks the *other* stream's entire test run,
so keep shared files valid between edits.
