# Brume — Dashboard

Vue 3 + TypeScript + Vite frontend for the Brume home server interface.

## Stack

- [Vue 3](https://vuejs.org/) with `<script setup>` SFCs
- [TypeScript](https://www.typescriptlang.org/)
- [Vite](https://vitejs.dev/)
- [Tailwind CSS v4](https://tailwindcss.com/)
- [tRPC](https://trpc.io/) client

## Development

```bash
# From the repo root
pnpm install
pnpm -F @brume/dashboard dev
```

The dev server proxies `/trpc` to the backend at `http://localhost:9001`.
Set `VITE_API_URL` in `.env.local` to point at a different backend.

## Build

```bash
pnpm -F @brume/dashboard build
# Output: apps/dashboard/dist/
```
