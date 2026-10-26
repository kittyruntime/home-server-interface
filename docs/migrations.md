# SQLite cutover inventory

Generated from the 115 non-draft, non-prerelease GitHub releases through v1.68.0. `inventory.py` builds a temporary SQLite database for each distinct published Prisma schema with Prisma 7 and records its canonical `sqlite_master` fingerprint. The 20 representative fingerprints were also compared with databases built by the published Prisma 6 generation (6.19.3 for 14 states, 6.9.0 for the six oldest states); all 20 matched. `states.json` and `conversions.json` record the release-to-state mapping and the SHA-256 of each of the 19 historical SQL conversions. CI regenerates both files and refuses a difference. Published release validation uses populated installed databases and rollback tests.

The v1.68.0 baseline fingerprint is `630655afec24010fcb96246e79cc64f000b9e6bf7b4d8e506662a3cfa4c51917`. The existing partial Prisma migration was never run by any published installer (`migrate deploy` and `migrate resolve` are absent in all 115 published `scripts/install.sh` files); its original SQL is archived unchanged. A manually populated `_prisma_migrations` table needs explicit review and is refused by preflight.

The installer stops services and takes an update snapshot of the database, WAL and configuration. It then checks the SQLite fingerprint, integrity and Prisma ledger before any database write. Historical updates stage Compose files separately, add their targets to the same update snapshot, convert the versioned data and schema, verify the exact baseline, mark it applied, then run `prisma migrate deploy`. Fresh installs deploy directly; an exact v1.68.0 database without a ledger is baselined directly. The generated Prisma 7 client ships in the signed release archive. Compose activation, seed and health checks happen under the update rollback marker, so failure restores the old release, DB/WAL/ledger and recorded Compose files. Unknown or partial states stop with a diagnostic and the database fingerprint when available.

| SQLite SHA-256 | Objects | Published releases | Script variants |
| --- | ---: | --- | ---: |
| `630655afec24010fcb96246e79cc64f000b9e6bf7b4d8e506662a3cfa4c51917` | 34 | v1.68.0, v1.67.0, v1.66.0, v1.65.0 | 1 |
| `207863ea1ae2748c79c68dc7631e69ed30fa873b5c5d2bd25e40adc9771a95b1` | 33 | v1.64.2, v1.64.1, v1.64.0, v1.63.0, v1.62.1, v1.62.0, v1.61.0 | 1 |
| `5bbf125e724c6ea06e37231f031e8364b4e93cc1791272d4beb055d91c6c626b` | 32 | v1.60.0, v1.59.0, v1.58.0 | 2 |
| `1b19ed10f6e7cbf919aa957b8fe04ef14ee1bcf616b6f146012d4d7da324db26` | 30 | v1.57.0, v1.56.0, v1.55.1, v1.55.0, v1.54.0 | 2 |
| `3e1798df1946f86c0e407b56af956853654fba4361755303b2be69d9a09b4517` | 25 | v1.53.1, v1.53.0 | 1 |
| `820a70e08e70843403c7415e269ba23771e2db76327a74033c542f26e5a1dfde` | 31 | v1.52.0, v1.51.0 | 1 |
| `ec3885727c69333d02be5121e6cd2a5c264e3a790db1e36b38ac6c56621be0b2` | 30 | v1.50.3, v1.50.2, v1.50.1, v1.50.0, v1.49.0, v1.48.1, v1.48.0, v1.47.0 | 1 |
| `55dd299a5f80a779ab426f11e8e21529e7e36242c8c095cce950e950e1e5e5ad` | 29 | v1.46.0, v1.45.0, v1.44.1, v1.44.0, v1.43.0 | 1 |
| `149a384874fb3eba5ba9b44bf34aec449f35dd417b2005e106864f4e2c75a4e0` | 27 | v1.42.0 | 1 |
| `bd7f44cea49b2169d5543afee8f3b0f9c487ee1228c0b610e641ecdef6f404d9` | 25 | v1.41.0, v1.40.1, v1.40.0, v1.39.0, v1.38.0, v1.37.0, v1.36.0, v1.35.0 | 1 |
| `dfd9eee2221623679e7e95150589b30f0fb3041c18c90ba34183cc7e73463ef1` | 28 | v1.34.1, v1.34.0, v1.33.1, v1.33.0 | 1 |
| `e526488b1a2d718470a303dc84ba26534bf24a2ef386ff886c89531a9c178b64` | 28 | v1.32.0, v1.31.1, v1.31.0, v1.30.0, v1.29.2, v1.29.1 | 1 |
| `a1c5e5e56fa8d568a2946e512e3e85e9cb7dc3fe7308a54c038dc091da3e6ddf` | 28 | v1.29.0 | 1 |
| `23730dc8b76b49e00bb02480406be8eda3316fe46e36ba7f5ab7cf4879cc8b9d` | 25 | v1.28.6, v1.28.5, v1.28.4, v1.28.3, v1.28.2, v1.28.1, v1.28.0, v1.27.2, v1.27.1, v1.27.0, v1.26.0, v1.25.0 | 1 |
| `a3cfc846a3fbebfd7ce368a28d2e354e5714b5d37fb9832e67c083f66879ec45` | 23 | v1.24.0, v1.23.2, v1.23.1, v1.23.0, v1.22.0, v1.21.0, v1.20.0 | 1 |
| `99898fd11fd3882c6e27bbdf6c97082defd28c5a60141983e01d8132b66c7b43` | 22 | v1.19.1, v1.19.0, v1.18.2 | 1 |
| `8e49b95f5522f37ec689a625e4cc33a6281a20db8dc730044b30aa0f2c8e66be` | 21 | v1.17.1, v1.16.0, v1.15.1, v1.15.0, v1.14.0, v1.12.3, v1.12.2, v1.12.1, v1.12.0, v1.11.5 | 1 |
| `4e7742dc12371b38a41eb15e3965bd915b646d2f163d463d536c9bc051415e0f` | 21 | v1.11.3, v1.11.2, v1.11.1, v1.11.0, v1.10.2, v1.10.1, v1.10.0, v1.9.0, v1.8.2, v1.8.1, v1.8.0, v1.7.1, v1.7.0 | 1 |
| `1693b534decade705e5cb1bcc6707de2c1bfbbd828b8eae54522b88c27691d40` | 21 | v1.6.1, v1.6.0, v1.5.0, v1.4.0, v1.3.0, v1.2.0, v1.1.0, v1.0.0, v0.2.0, v0.1.2, v0.1.1, v0.1.0 | 1 |
| `6060e09e5079ec116cd806e530334ec6df444a230a023b58f8b8ec444e05137f` | 15 | v0.0.2, v0.0.1 | 1 |

## If an update fails

The installer restores the previous release and its update snapshot automatically after a failed upgrade. The dashboard shows the failed step and its cause. The terminal reports the database backup path (`hsi.db.bak-*`). Keep that backup and send the error message and any database fingerprint to support. If the automatic rollback fails, run the command printed by the installer; on an installed release this is usually `sudo hsi-worker update rollback --snapshot <path>`. A reinstall of the same version does not create an update snapshot. Its database backup can be used for manual recovery.

## Next migration

The preflight in this release accepts exactly the `0_baseline_v1680` ledger and its baseline schema. A later release that adds migrations must update the accepted ledger and fingerprints before shipping.
