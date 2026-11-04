// Public key checking the catalog index published online (#26), ed25519 PEM.
// Its private half is the CATALOG_SIGNING_KEY secret of the catalog repository.
//
// Until the real key replaces it, this is the development key, whose private
// half is in apps/backend/src/tests/fixtures: HSI then never trusts an online
// catalog (only tests can, with HSI_ALLOW_DEV_CATALOG_KEY=1).
export const CATALOG_SIGNING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAt+6n69gjhnt6JU1rWFVXQFsS/Cgcgmn3lQn0x2kf0ZU=
-----END PUBLIC KEY-----
`

/** SHA-256 of the development key's DER form. */
export const DEV_CATALOG_KEY_FINGERPRINT = "32bdd9723b5f604941d0e4d3691c8b1499a3606d96dade663d9f8ef1c188ac98"

/** Where HSI reads the catalog: the latest release of the public catalog repository. */
export const CATALOG_URL = "https://github.com/kittyruntime/home-server-interface-apps/releases/latest/download/catalog.json"
