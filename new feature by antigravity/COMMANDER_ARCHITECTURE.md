# Central Commander & Employee Hierarchy Architecture

Designed and implemented by **Antigravity**, the **Central Commander ("Commando") Architecture** introduces hierarchical leadership and autonomous delegation to LogBridge. Instead of human operators managing multiple worker agents individually, a single **Central Commander** receives the high-level objective, formulates the master plan, and commands subordinate employee agents to execute the work.

---

## 1. Architectural Hierarchy

```
                          ┌────────────────────────┐
                          │   Central Commander    │
                          │     (Leader / God)     │
                          └───────────┬────────────┘
                                      │
           ┌──────────────────────────┼──────────────────────────┐
           │ Strategic Analysis       │ UI / Experience Tokens   │ Construction Order
           │ Orders Research Unit     │ Orders Design Unit       │ after Review
           ▼                          ▼                          ▼
┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│     Employee 1       │   │      Employee 2      │   │      Employee 3      │
│  Domain Researcher   │   │  UI / UX Designer    │   │  Frontend / Backend  │
└──────────────────────┘   └──────────────────────┘   └──────────────────────┘
 (Specs & Market Data)      (Design Tokens & Layout)    (Production Code Build)
```

---

## 2. The Commander's Operational Lifecycle

When a human operator or user issues a high-level goal (e.g. *"Build a digital storefront for Subway"*), the Commander executes a structured 5-phase lifecycle:

### Phase 1: Strategic Analysis & Master Blueprint
- The Commander parses the objective and identifies what domain specialists are required.
- Co-authors the master architecture specification on the shared project blackboard (`~/workspace/hive/board.md`).
- Records the strategic breakdown into its private memory (`agents/<commander-id>/memory.md`).

### Phase 2: Kanban Ledger Provisioning
- Automatically breaks the project into distinct work items.
- Creates new task cards on the 4-column Kanban board (`~/workspace/hive/tasks.json`) and assigns each card to the appropriate employee unit.

### Phase 3: Outbox Delegation via FIPA-Lite Speech Acts
- The Commander dispatches operational orders to each employee's mailbox using structured FIPA-Lite JSON messages (`act: "request"`):
  ```json
  {
    "from": "agt_commander",
    "to": "agt_employee_1",
    "act": "request",
    "subject": "OPERATIONAL ORDER: Formulate Menu & Nutrition Matrix",
    "body": "Compile all signature recipes, macros, and pricing models..."
  }
  ```

### Phase 4: Employee Execution & Reporting
- Subordinate agents read their personal `inbox/`, execute their specialized tasks, and report deliverables back to the Commander with `act: "inform"` or `act: "done"`.
- Each employee transitions their Kanban card to `in_progress` and then `done`.

### Phase 5: Commander QA Inspection & Sign-Off
- The Commander inspects the delivered assets (data, design tokens, or source code).
- Dispatches construction orders to the lead developer unit.
- Conducts final acceptance testing and replies with `act: "agree"` to confirm mission completion.

---

## 3. Strict Non-Coding Constraint & Automatic `AGENTS.md` Injection

A common failure in multi-agent systems is the "Worker Bee Commander"—where a lead agent attempts to write code directly instead of coordinating its subordinates. 

Antigravity solves this in [`apps/server/src/ptyGateway.ts`](file:///Users/ayush/Project/LogBridge/apps/server/src/ptyGateway.ts) by automatically generating and injecting an **`AGENTS.md` Operational Directive** into the Commander's workspace before terminal initialization:

```markdown
# SYSTEM DIRECTIVE: CENTRAL OPERATIONS COMMANDER

You are the Central Operations Commander.

CRITICAL OPERATIONAL CONSTRAINT:
- DO NOT WRITE SOURCE CODE DIRECTLY.
- You are the Commander, NOT a worker bee.
- Your mission is to analyze requests, formulate architecture on ~/workspace/hive/board.md, 
  log tasks on ~/workspace/hive/tasks.json, and delegate missions to your subordinate employees.

YOUR SUBORDINATE EMPLOYEES:
- employee-1 (Role: Domain Researcher)
- employee-2 (Role: UI / UX Designer)
- employee-3 (Role: Lead Developer)
```

Whenever OpenCode or Claude Code starts in the Commander's terminal, it reads `AGENTS.md` and strictly acts as a high-level orchestrator, delegating tasks to its team.
