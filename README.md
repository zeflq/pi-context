# pi-context

Three [pi](https://github.com/badlogic/pi-mono) extensions that solve SSH context blindness and automatic context file discovery.

## Extensions

### 1. `ssh-context` — SSH parity (layers 0 & 1)

When you run pi with `--ssh`, the agent operates on the remote machine but pi's resource discovery never runs there. Your remote project's `SYSTEM.md`, `AGENTS.md`, and skills are silently ignored.

This extension replicates pi's full resource loading pipeline on the remote machine over SSH:

**Layer 0 — system prompt files:**
- Loads `SYSTEM.md` from remote `.pi/`, `.claude/`, or `.agents/` (first found), then `~/.pi/agent/` as fallback → replaces base system prompt
- Loads `APPEND_SYSTEM.md` from same locations → appended at the very end

**Layer 1 — project context:**
- Walks up from remote cwd to root collecting `AGENTS.md` / `CLAUDE.md` (case-insensitive) → injected as `# Project Context`; at each level checks the directory directly and inside each config subdir (`.pi/`, `.claude/`, `.agents/`)
- Also checks `~/.pi/agent/AGENTS.md` (or `CLAUDE.md`) as the global user context file, loaded first

No-ops when `--ssh` is not active — pi handles local loading natively.

---

### 2. `ssh-skills` — Remote skill mirroring

Mirrors remote skill directories into a local temp folder so pi can load them natively (debug panel, `/skill:name` commands).

- Fetches skills from `~/.pi/agent/skills/`, `~/.agents/skills/`, `.pi/skills/`, `.claude/skills/`, `.agents/skills/` on the remote
- Writes only `SKILL.md` content locally — sub-files (references, scripts) stay on the remote and are read there by the agent when needed
- Temp dir is cleaned up on session shutdown

No-ops when `--ssh` is not active.

---

### 3. `context-files` — Auto-discovery of context files (layer 2)

Pi's native `AGENTS.md` mechanism loads files flat into the system prompt unconditionally. This works for small projects but bloats the context window as your knowledge base grows.

Instead, drop any `.md` file with a `description` frontmatter field into a config dir and it is automatically available to the agent on demand — no links or index files to maintain.

```
.pi/
├── AGENTS.md          ← always fully loaded (core instructions)
├── review.md          ← auto-discovered → available on demand
├── deploy.md          ← auto-discovered → available on demand
└── architecture/
    └── overview.md    ← auto-discovered (subdirs scanned recursively)
```

**How it works:**

1. `AGENTS.md` is fully loaded into the system prompt by pi natively.
2. The extension scans `.pi/`, `.claude/`, and `.agents/` subdirs of each loaded context file's directory for `.md` files with a `description` frontmatter field.
3. Discovered files are injected as a `<context-files>` XML block — path and description only (no content).
4. The agent calls the `read` tool on any file when the task matches its description. The LLM acts as the relevance filter.

Works both locally and over SSH.

**File contract:**

Every context file must have a `description` frontmatter field. Write it as a trigger condition — "Load when..." — so the agent knows exactly when to read it:

```markdown
---
description: Load when doing a code review. Contains the review checklist and merge criteria.
---

## Code review checklist
...
```

Files without a `description` are ignored. The `skills/` subdirectory is skipped automatically.

**Supported config directories** (tried in order): `.pi`, `.claude`, `.agents`

---

## Setup

```bash
pi install git:github.com/zeflq/pi-context
```

## Usage

Works automatically once installed. No configuration needed.

For SSH usage, combine with pi's `--ssh` flag:

```bash
pi --ssh user@host:~/project
pi --ssh user@host:/absolute/path
```

## Project structure

```
extensions/
  ssh-context.ts      # SSH parity extension (layers 0 & 1)
  ssh-skills.ts       # Remote skill mirroring
  context-files.ts    # Auto-discovery of context files (layer 2)
src/
  fs-ops.ts           # Shared local + SSH filesystem abstraction
  ssh.ts              # Shared SSH flag parsing and state resolution
  markdown.ts         # Shared frontmatter parsing
  loader.ts           # Shared file discovery and loading logic
test/
  loader.test.ts      # Unit tests for loader utilities
  context-files.test.ts  # Integration tests for context-files extension
```
