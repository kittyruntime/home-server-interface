// Public key checking the catalog index published online (#26), ed25519 PEM.
// Its private half is the CATALOG_SIGNING_KEY secret (environment "catalog")
// of the catalog repository, and the same key is its catalog-signing.pub.
export const CATALOG_SIGNING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA8QE+G0fLCwtz15XCxwf6e7oOoV0h2QJrCB13KZ0VDlM=
-----END PUBLIC KEY-----
`

/**
 * SHA-256 of the DER form of the development key, whose private half is in
 * apps/backend/src/tests/fixtures: HSI never trusts it outside tests
 * (HSI_ALLOW_DEV_CATALOG_KEY=1).
 */
export const DEV_CATALOG_KEY_FINGERPRINT = "32bdd9723b5f604941d0e4d3691c8b1499a3606d96dade663d9f8ef1c188ac98"

/** Where HSI reads the catalog: the latest release of the public catalog repository. */
export const CATALOG_URL = "https://github.com/kittyruntime/home-server-interface-apps/releases/latest/download/catalog.json"
