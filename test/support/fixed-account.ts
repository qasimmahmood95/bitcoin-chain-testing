/**
 * Fixed account-level PUBLIC key for the regtest derivation-parity and
 * watch-only scenarios (DR-02/DR-03). Generated once from an ephemeral
 * seed at path m/84'/1'/0'; the seed and private half were never written
 * anywhere (hard limit 2 — public key material only). Nothing can ever
 * sign for these addresses, which is exactly the point: detection must
 * work with zero key material present.
 */
export const FIXED_ACCOUNT_TPUB =
  'tpubDCAsWbjdgoo3CLHqf5vYcSRJ4rFtRLQvJAFT1eV3qZhriNjvCRdyeCgT2ntAdp6ko8yF5pc5LWF7E8LHeH1dt1C1qFMQ8gxdceYt2Mv7gfZ';
