---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

<!-- Adapted from superpowers v7.0.2 (obra/superpowers, MIT). Self-contained rewrite: execution protocols inlined, no dependencies on other superpowers skills. -->

## Overview

Write implementation plans for an engineer who has not seen this codebase or this spec. Assume they write idiomatic code in the project's language once they know the exact interface and the exact test, and that they will make a reasonable choice wherever the plan leaves one open. What they cannot know is what you decided: which files, which names and signatures, which values from the spec, which tests prove each task. Document those. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** If the plan will be executed in an isolated git worktree, create the worktree before execution begins (e.g. `git worktree add`); never implement on main/master without your human partner's explicit consent.

**Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>.md`
- (User preferences for plan location override this default)

## Scope Check

If the spec covers multiple independent subsystems, suggest breaking it into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Task Right-Sizing

A task is the smallest unit that carries its own test cycle and is worth a
fresh reviewer's gate. When drawing task boundaries: fold setup,
configuration, scaffolding, and documentation steps into the task whose
deliverable needs them; split only where a reviewer could meaningfully
reject one task while approving its neighbor. Each task ends with an
independently testable deliverable.

## Step Granularity

**Each step is one action with a checkable result:**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** Implement this plan task-by-task in order. Work each step as written (test-first steps: write the test, watch it fail, implement minimally, watch it pass), check off each `- [ ]` step as it completes, and commit where the plan says commit. Do not start a task before the previous task's tests pass.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

**Spec:** [path to the spec/design doc this plan implements — the plan
argues from the spec, so the spec travels with it; executors read both]

## Global Constraints

[The spec's project-wide requirements — version floors, dependency limits,
naming and copy rules, platform requirements — one line each, with exact
values copied verbatim from the spec. Every task's requirements implicitly
include this section.]

## Review Focus

[The five input classes or failure modes the spec implies but no task's
tests exercise that are most likely to bite a person using this software
— one line each, naming the input or condition and the behavior a
reasonable person would expect, most likely first. The spec is a vision
document: it says what the software must do, not everything it will
meet, and its silence on an input is not permission for that input to
break the program. Write the list here, once, with the spec in front of
you. Then, for each line, add the test that pins it to the task that
owns the code, in that task's own step style.]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Depends on:** `none` (or `Task M`) — *when multiple tasks have no shared files and no mutual dependency, group them explicitly as parallelizable candidates for Execution Handoff.*

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Interfaces:**
- Consumes: [what this task uses from earlier tasks — exact signatures]
- Produces: [what later tasks rely on — exact function names, parameter
  and return types. A task's implementer sees only their own task; this
  block is how they learn the names and types neighboring tasks use.]

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Implement `function(input: InputType) -> ResultType` in `exact/path/to/file.py`**

One line on the approach when the signature and the test leave a choice
(which library call, which data structure); a code block only for an
algorithm they do not determine.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

## What a Step Contains

A step is done when the implementer can write exactly one reasonable thing
from it. That is the whole requirement: unambiguous, not complete. Each kind
of step carries what makes it unambiguous and nothing more:

- **A test step:** the test's name and its assertions, as code, with the
  spec's exact values in them.
- **A code step:** the exact signature (name, parameters, return type), the
  file it lives in, and the specific values the spec pins. The implementer
  writes the body. A body appears only for an algorithm the signature and
  tests do not determine, or for exact copy the spec fixes.
- **A verification step:** the command to run and the output that means it
  passed.
- **A reference to another task:** that task's Interfaces block says what
  to use; the plan does not repeat that task's code.

A plan is the set of decisions the implementer cannot make alone. A plan
longer than the code it describes has written the code instead. Lines that
decide nothing ("TBD", "handle edge cases", "add appropriate validation",
"write tests for the above", a type or function no task defines) are the
opposite failure, and the self-review catches both.

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. Step scan:** Every step must let the implementer write exactly one reasonable thing, and no step may carry more than that: a line that decides nothing is a gap, a function body the signature and tests already determine is a transcript. Fix both.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

**4. Review Focus:** For each input class or failure mode the spec implies, is there a task whose tests exercise it? The five uncovered ones most likely to bite a person go in the Review Focus section, and each line there gets its test added to the owning task. An empty section means you checked and found none, not that you skipped the check.

**5. Proportion:** Compare the plan's length to the spec's. A plan several times longer than the spec it implements is a transcript of the program, not a plan. If code blocks are most of the document, replace bodies with signatures, test names and assertions, and check that each step is still unambiguous.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

## Independent Plan Review

After Self-Review and before Execution Handoff, always run one fresh-context,
read-only independent review of the plan and its spec. Do this without waiting
for the user to request review and before asking for an execution method.
Prefer a fresh independent read-only reviewer (`pi-worker` with `tier: "heavy"` and `readOnly: true` when available, or a fresh `review-agent` / `general-purpose` reviewer). This plan review is separate from the final
implementation review and does not replace it.

Give the reviewer both document paths, the confirmed decisions and constraints,
and ask for correctness, feasibility, internal consistency, test validity and
unintended side effects. Findings must cite file:line and a concrete failure
scenario; the reviewer does not edit files.

Apply Critical and Suggestion findings to the plan or spec before handoff, or
record why they are intentionally deferred. Record the reviewer and any
unresolved or deferred findings with the plan. If no independent reviewer is
available, disclose that blocker instead of presenting the plan as reviewed.

## Execution Handoff

After saving and self-reviewing the plan and completing Independent Plan
Review, link it for your human partner to read. If they have already explicitly
supplied an execution method, ask them to review the plan and confirm it
captures what they want; wait for that review before implementation, then use
the preserved method. Otherwise, ask them to review the plan and choose an
execution method before implementation.

**When no execution method has already been supplied:**

**"Plan complete and saved to `docs/plans/<filename>.md`. Please review the plan. Which execution approach would you prefer? Please choose both Executor and Mode:**

1. **Executor:**
   - **`pi-worker`** *(when `pi-worker` is available)* — Delegate implementation to isolated `pi-worker` session(s) (`tier: "default"` or a requested tier, read-write), while I stay in the **ruling, orchestration & acceptance** role: answering `needs_input`, verifying tamper-proof disk evidence (`executedCommands`, `eventsPath`, `git diff BASE..HEAD`), and running a fresh independent review before reporting.
   - **`Native`** — Execute inside this harness (Serial: I implement every task myself in this session; Parallel: I dispatch fresh native subagents in isolated workspaces per disjoint task group and integrate the branches).
2. **Mode:**
   - **`Serial`** — Execute tasks strictly in order in one branch/worktree; each task's tests pass before the next begins. Default when tasks share files or build tightly on each other's interfaces.
   - **`Parallel`** *(only when the plan has independent task groups with disjoint file ownership)* — Run disjoint task groups concurrently in isolated `git worktree`s (or isolated native workspaces), verify each branch independently, then merge sequentially into the target branch, run the full test suite, and clean up temporary worktrees. *(Note: if the plan's tasks have sequential dependencies or overlapping files, state explicitly that Parallel is not safe for this plan and recommend Serial.)*

**For this plan I recommend `<Executor> + <Mode>`, because `<one sentence from the plan: task dependencies, file-ownership disjointness, task count, and risk>`. Does the plan capture what you want, and which Executor + Mode should we use?"**

**When an execution method has already been supplied:**

**"Plan complete and saved to `docs/plans/<filename>.md`. Please review the plan. Does it capture what you want?"**

**Execution protocol (self-contained — common to all approaches):**

- **Isolated workspace:** work in a git worktree or feature branch; never implement on main/master without explicit consent.
- **Ledger:** keep a git-ignored progress file for this plan (e.g. `.plans/<plan-basename>/progress.md`), first line `# ledger — plan: <plan path>`. Append `Task <N>: complete (commits <base7>..<head7>)` per finished task; record every deviation as `Ruling: <decision> — <why> — <cost if wrong>`. After context compaction, trust the ledger and `git log` over memory — tasks with a completion line are done, do not redo them.
- **Spec is authority:** read the plan and its Spec; conflicts resolve against the spec.
- **Continuous execution:** do not check in between tasks. Stop only for: irreversible/destructive operations, security-sensitive actions, side effects outside the workspace (merge, push to a shared branch, publish), or a plan so broken that every path forward is a guess.
- **TDD per step:** write the failing test, watch it fail, implement minimally, watch it pass, commit as the plan says. A test that passes before the implementation exists is a finding about the test.
- **Final review:** after all tasks (and after merging all parallel branches if Parallel was used), one fresh-context review of the whole branch (most capable model available, e.g. `pi-worker` with `tier: "heavy"` + `readOnly: true`), deliberately covering the plan's Review Focus. Critical/Important findings → ONE fix pass, each fix RED→GREEN plus a green full suite; Minor → deferred list. No second fix pass.
- **Final message:** list every Ruling and every deferred minor — that is how decisions made on your human partner's behalf reach them.

**If `pi-worker` + Serial chosen:**
- Record `BASE` (`git rev-parse HEAD`) before dispatching `pi_worker_start` (passing target branch/worktree `cwd`, `parentSessionId` when available, `tier: "default"` unless user specifies another tier, read-write mode).
- Dispatch prompt must include: exact paths to the plan and its Spec, Global Constraints, the TDD/commit/ledger rules from the Execution protocol above, and explicit instruction to call `worker_ask_parent` on genuine spec/plan ambiguities rather than guessing.
- While `pi-worker` runs, the main agent freezes writes to the same `cwd` and handles `status: "needs_input"` via `pi_worker_reply` (resolving from context when clear or escalating to the human partner; record every deviation as a `Ruling:`).
- **Main agent acceptance (mandatory — never trust `summary` / `verifiedCommands` alone):**
  1. Cross-check tamper-proof disk evidence: `executedCommands` (real commands & `isError`), `eventsPath` (untruncated tool outputs/failure traces), and `git diff BASE..HEAD` + `git status` against every task in the plan and Spec;
  2. Verify the ledger, every named test, and key modified files by reading them directly;
  3. Run the whole-branch fresh read-only independent review (`pi-worker` with `tier: "heavy"` + `readOnly: true`) covering Review Focus. Critical/Important findings → ONE scoped fix pass (via `pi_worker_reply` or direct targeted edit by main agent) + re-verify disk evidence; Minor → deferred list;
  4. Report verified results, all Rulings, and deferred minors to the user.

**If `pi-worker` + Parallel chosen:**
- **Pre-flight partition check:** Group tasks into waves of mutually independent task groups with **strictly disjoint file ownership** (if some tasks must run first as a shared foundation, run that prerequisite wave serially before fanning out the parallel wave). Never assign two concurrent workers to modify the same file.
- **Worktree setup (managed by main agent):** Record `BASE` (`git rev-parse HEAD`) on the target branch. For each parallel group `k`, create an isolated git worktree and branch from `BASE` (e.g. `git worktree add -b <plan-slug>-g<k> <worktree-dir-k> BASE`).
- **Concurrent dispatch:** Launch all independent groups in the same turn via `pi_worker_start` (`readOnly: false`, `tier: "default"` unless specified), passing each group's own `<worktree-dir-k>` as `cwd` (distinct `cwd` paths avoid cwd write-lock contention and run as true parallel processes). Each prompt carries: exact paths to the plan and Spec, its assigned task group, explicit file-ownership boundaries ("do NOT modify files outside your assigned list"), shared interfaces from prerequisite waves, Global Constraints, TDD/commit rules, and `worker_ask_parent` instructions. Do not let parallel workers write to the same shared ledger file inside their worktrees — the main agent updates the ledger on the target branch after accepting each group.
- **Ruling & per-group acceptance:** Freeze writes to each active worktree while its worker runs; answer `needs_input` per `taskId` via `pi_worker_reply`. As each worker finishes, verify its tamper-proof disk evidence (`executedCommands`, `eventsPath`, `git diff BASE..HEAD` in its worktree, and `git status` clean + file-ownership boundary intact).
- **Sequential integration & cleanup:** Merge accepted group branches into the target branch one by one (resolving any unexpected conflict carefully, recording any deviation as a `Ruling:`), update the ledger, run the full test suite on the integrated target branch, remove temporary worktrees and scratch branches (`git worktree remove` + `git branch -d`), then run the whole-branch fresh read-only review (`tier: "heavy"` + `readOnly: true`) covering Review Focus.

**If `Native` + Serial chosen:**
- Execute the steps yourself in order in the target branch/worktree; run every command and compare its output with the step's `Expected:` line.
- Output mismatch: code wrong → find the root cause, never patch the symptom; plan wrong → make the smallest change that satisfies the spec, ledger the Ruling, continue.
- Task completion contract: every named test exists and ran, you read the outputs, the final run passed, and every deviation has a Ruling line. Missing evidence = not complete.
- Final review: dispatch a fresh reviewer if a subagent tool exists; otherwise do a separate, explicit self-review pass and tell your human partner it was self-review (weaker than a fresh reviewer — they decide whether it is enough before merge).

**If `Native` + Parallel chosen:**
- **Pre-flight partition check:** Partition independent tasks into waves with strictly disjoint file ownership (running shared prerequisite tasks first).
- **Isolated native dispatch:** Dispatch one fresh native implementer subagent per disjoint group using isolated workspace support (e.g. `Workspace: "share"` in Antigravity, or dedicated `git worktree`s if the harness lacks built-in workspace sharing). Each dispatch carries only its assigned task text verbatim, interfaces from prerequisite tasks, explicit file-ownership boundaries, and Global Constraints.
- **Per-group verification, merge & final review:** Verify each group's diff (`git diff BASE..HEAD`) and tests (preferring a fresh reviewer per group when thoroughness justifies it), merge accepted branches sequentially into the target branch, update the ledger, run the full test suite, clean up temporary workspaces/worktrees, and run the whole-branch fresh review covering Review Focus.
