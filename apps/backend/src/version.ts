// Injected by esbuild (--define) from the root package.json; tests and the dev
// server run from source, where it is not defined.
declare const __HSI_VERSION__: string

export const HSI_VERSION: string = typeof __HSI_VERSION__ === "string" ? __HSI_VERSION__ : "dev"
