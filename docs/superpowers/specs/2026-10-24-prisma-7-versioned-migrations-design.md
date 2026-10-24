# Prisma 7 and versioned SQLite migrations

## Intent

KIT-15 implements GitHub #9 part b and #104 in one PR and one release. HSI must update directly from every normal SQLite state produced by a published release without using production `db push --accept-data-loss`. The v1.68.0 shipped schema is the immutable baseline. The existing #9a update snapshot and rollback remain authoritative.

## Scope

- Upgrade Prisma CLI and client to one Prisma 7 version, configure the multi-file schema and migration directory explicitly, and use a SQLite driver adapter for every client instance.
- Inventory all published SQLite states, including historical data migrations. Group releases only when their actual SQLite schema and required data transformation are equivalent. Publish a manifest of versions, canonical schema fingerprints, conversion paths, and SHA-256 checksums.
- Keep a single baseline of the v1.68.0 schema. Fresh installs deploy it and then seed. Existing installs first match a known state, execute any versioned conversion, verify the baseline, resolve it once, then deploy future migrations.
- Preserve the release update lock, pre-write #9a snapshot, old release and health gate. Failure after a write restores the database, WAL and migration ledger through #9a. Unknown or drifted states stop before any database or ledger write and give an actionable diagnostic.
- Make same-version repair and interrupted fresh installs explicit. A repair may deploy outstanding migrations but must never resolve an unknown baseline or replay a historical conversion.

## Exclusions

Dependency upgrades #105–#110 and a general migration framework after the baseline are outside this PR. `migrate reset`, production `db push`, and blind `resolve` are forbidden.

## Approaches

KIT-13 and KIT-14 selected direct conversion from each published state. Requiring a v1.68.0 hop was considered and rejected by Tim. A transitional `db push` was rejected because it cannot prove data preservation or a stable conversion history. The selected path has more one-time conversion and fixture work but keeps a linear Prisma migration ledger after the cutover.

## Design

1. Use the last published v1.68.0 tag as source of truth for baseline SQL and canonical schema. Archive the pre-existing partial migration without changing its bytes. The inventory determines whether any supported database recorded it; unexpected ledger states are refused.
2. A checked-in manifest identifies actual SQLite states by canonical `sqlite_master` schema and relevant data predicates. Fingerprints ignore only SQLite internal objects and volatile whitespace; indexes, foreign keys and defaults remain in the comparison. The preflight process verifies DB integrity, ledger state, available snapshot space and conversion checksum before a write.
3. Each historical conversion is immutable SQL or a deterministic script with its checksum in the manifest. It runs only for its exact source fingerprint and before baseline resolve. Conversions preserve data and write a separate cutover receipt tied to the release and checksum, which the #9a snapshot restores along with the database. An interrupted conversion is never treated as complete; the installer restores the snapshot and retries from the original state.
4. Prisma 7 configuration lives in `packages/database/prisma.config.ts`, with `DATABASE_URL=file:/absolute/path` for installed databases. Client construction uses a SQLite adapter in database, seed, historical scripts and backend restore. Source and release layouts use the same CLI config semantics.
5. The installer performs preflight after services stop and #9a snapshots the update, then runs conversion, exact baseline comparison, `migrate resolve --applied` if needed, `migrate deploy`, seed, migration status and health check. Every write stage is included in the existing rollback marker. The release archive includes CLI, generated client, adapter, schema, migrations and manifest.

## Validation and release gates

A populated SQLite copy from each distinct published state must preserve user, permission, volume and backup data through direct upgrade. Fresh install, already-migrated update, repair, drift, partial ledger, low disk space and faults during conversion, resolve, deploy, seed and health check require automated coverage. Darnold owns the regression matrix; Krokdur reviews sensitive SQL and state matching; Nico checks CI, checksums and reviews before merge or release.

Source decisions: KIT-13, KIT-14, GitHub #9 and #104.
