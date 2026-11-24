---
title: Code style
description: How the code is written and formatted, and the checks that keep it that way.
---

Most of this page is enforced by tools; the rest is what reviews look for.
Run `pnpm lint:fix` before committing and `pnpm verify` before opening a pull
request.

## Formatting

ESLint formats TypeScript and Vue files (`eslint.config.js`, section "Code
style"). Every rule is autofixable, so `pnpm lint:fix` rewrites a file to the
house style:

- two-space indentation, in scripts and in templates;
- no semicolons;
- single quotes in TypeScript, double quotes for template attributes;
- trailing commas on multi-line lists and objects;
- `x => x` arrows, without parentheses around a single parameter;
- one blank line at most, a final newline, no trailing spaces;
- in Vue files: `<script>`, then `<template>`, then `<style>`; empty elements
  self-close (`<Icon />`), HTML void elements do not (`<input>`).

The rules stop there on purpose. Line length, where attributes wrap and
column alignment (`case 'running':     return ...`) are the author's call:
keep lines readable, and align when it shows a pattern.

`.editorconfig` gives editors the same defaults. Go code is formatted by
`gofmt` (`pnpm check:go`).

## Language

- Code, comments, identifiers and commit messages are in English.
- Text shown to people goes through the i18n files
  (`apps/dashboard/src/i18n/locales`), in English and French with the same
  keys (a test checks it). Accented characters outside those files fail CI
  (`scripts/check-i18n.sh`).
- No em dashes anywhere (`scripts/check-no-em-dash.sh`): use a colon, a comma
  or parentheses.

## Dead code

`pnpm knip` fails on files nothing imports, exports nothing uses and
dependencies no package needs. Delete code instead of commenting it out;
git keeps the history. A function kept only for tests is a smell: test the
public function instead.

## Naming

- Vue components: `PascalCase.vue`, one per file.
- Other modules: `kebab-case.ts`. Backend services that own a resource end in
  `.service.ts`.
- tRPC routers are named after the resource (`storage`, `container`), and
  their procedures after the action (`list`, `create`, `apply`).
- i18n keys follow the screen: `monitor.perf.title`, `files.display.showRoot`.

## Comments

Comments explain why, or what the code cannot say: a constraint, a race that
was closed, a choice that looks wrong but is not. Do not restate the code. A
module starts with a short comment saying what it is for when its name is not
enough.

## Backend

- Logs go through `apps/backend/src/utils/log` (one JSON format); `console`
  is a lint error outside the tests.
- Inputs are validated with zod at the router boundary.
- Anything that changes the server goes through a plan (`app-plan`,
  `user-plan`, ...) so the interface can show it before it runs.
- New Prisma columns go at the end of their model, and any state written to
  disk must stay readable by the previous release (rollback).

## Dashboard

- Components come from `components/ui/<name>` (see
  [Design system](/home-server-interface/development/design-system/)), icons
  from `@lucide/vue`.
- Logic that can be tested without a browser lives in `src/lib/*.ts` and is
  tested in `tests/*.test.ts` (`node:test`).

## Commits

Conventional commits with a scope: `feat(monitor): pause and resume the live
refresh`, `fix(files): ...`, `ci: ...`, `chore: ...`. Each user-facing change
adds a line under `## [Unreleased]` in `CHANGELOG.md`.
