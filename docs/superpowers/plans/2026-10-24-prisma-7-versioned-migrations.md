# Prisma 7 and Versioned SQLite Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace production `db push` with a safe, direct migration from every published SQLite state while upgrading HSI to Prisma 7 in one PR.

**Architecture:** Freeze v1.68.0 as the cutover baseline; identify existing databases from actual SQLite schema and data; run checked-in historical conversions before resolving the baseline; use `migrate deploy` thereafter. The installer runs this under the application user after the #9a snapshot, with its rollback marker covering every write.

**Tech Stack:** TypeScript, Prisma 7, SQLite adapter, Bash installer, Go update worker, pnpm, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-24-prisma-7-versioned-migrations-design.md`

## Global Constraints

- One PR and one release for #9b and #104, with separate runtime, conversion, and installer commits.
- The baseline is the schema shipped in v1.68.0, not a later development state.
- Update directly from every normal published SQLite state; do not infer the state from version alone.
- No production `db push --accept-data-loss`, `migrate reset`, unconditional replay of old scripts, or #105–#110 work.
- Preflight and #9a snapshot precede every DB or ledger write; rollback restores DB, WAL and ledger.

## Review Focus

- A release whose schema text matches another but whose data migration needs differ must select the right conversion.
- A hand-edited index, foreign key or default must fail preflight before `resolve`.
- A partially applied ledger or legacy migration entry must not be silently accepted.
- Open WAL and low free space must not yield an inconsistent backup or conversion.
- Repair after an interrupted fresh install must not baseline a partial database.

---

### Task 1: Historical state inventory

**Files:** Create `packages/database/prisma/cutover/inventory.*`, `packages/database/prisma/cutover/states.json`, and focused tests; document release grouping in `docs/migrations.md`.

- [ ] Extract every published tag's Prisma schema and data scripts, build the resulting SQLite schema, and record the exact releases and state fingerprint.
- [ ] Create populated representative fixtures for each distinct state, including permissions and Compose data.
- [ ] Write failing tests for distinct schema and data predicates, unknown drift and partial ledger.
- [ ] Implement canonical SQLite schema inspection and checked-in manifest; verify all tags map to a state and manifest checksums are reproducible.
- [ ] Commit inventory and fixture coverage.

### Task 2: Prisma 7 runtime

**Files:** Modify `packages/database/package.json`, `apps/backend/package.json`, `runtime/package.json`, lockfiles, `packages/database/prisma/schema/base.prisma`, database client and seed, backend restore client, release assembly, and type tests.

- [ ] Write failing database smoke tests for client construction, seed, restore and absolute URL selection.
- [ ] Upgrade pinned Prisma packages and adapter; add `packages/database/prisma.config.ts` for multi-file schema and migrations.
- [ ] Generate Prisma 7 client explicitly and update every consumer; verify source and release paths and native adapter packaging.
- [ ] Run focused tests, typecheck, build and archive inspection; commit runtime changes.

### Task 3: Baseline and historical conversions

**Files:** Create baseline under `packages/database/prisma/schema/migrations`, archive the legacy partial SQL unchanged, add conversions and tests under `prisma/cutover`.

- [ ] Write failing tests that deploy baseline onto empty SQLite and compare it to a v1.68.0 database.
- [ ] Generate deterministic baseline SQL from v1.68.0, verify no published ledger contains the partial migration, and preserve its original checksum.
- [ ] For each state, write a failing populated conversion test, add the smallest versioned transformation, then verify exact baseline fingerprint, data and checksum.
- [ ] Test rollback/retry after conversion interruption; commit baseline and conversions.

### Task 4: Installer and rollback integration

**Files:** Modify `scripts/install.sh`, release scripts and `scripts/tests/install-layout.test.sh`; add installer fault tests.

- [ ] Write failing shell tests for empty, v1.68.0, historical, migrated, repair, drift and partial states.
- [ ] Run preflight after services stop and #9a snapshot, before the copy backup or SQLite write; reject unknown states with diagnosis.
- [ ] Replace data-migration loop and `db push` with conversion, exact baseline check, conditional `resolve`, `migrate deploy`, status verification and seed.
- [ ] Add fault injection at conversion, resolve, deploy, seed and health; assert #9a restores DB/WAL/ledger and old release, including retry.
- [ ] Verify package contents and full installer shell suite; commit integration.

### Task 5: Release evidence and PR

- [ ] Run `pnpm verify`, archive validation, and the complete Darnold matrix on populated copies.
- [ ] Recompute and review manifest and conversion checksums; review the final diff with Krokdur and Darnold.
- [ ] Open one PR with separate commit rationale, matrix results, rollback evidence, scope exclusion and remaining risks.
- [ ] Request Nico's CI, checksum and review gate; leave fusion/release to Nico.
