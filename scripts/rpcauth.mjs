// Regenerates the fixed test-only rpcauth line pinned in docker-compose.yml
// (same HMAC-SHA256 scheme as Bitcoin Core's share/rpcauth/rpcauth.py).
// The salt is fixed on purpose: determinism over secrecy — this credential
// only ever guards a disposable regtest node holding regtest coins.
//
//   node scripts/rpcauth.mjs

import { createHmac } from 'node:crypto';

const user = 'bct';
const password = 'regtest-test-only-not-a-secret';
const salt = 'c40d5dd1c7bb2d0e70f5070c8f4d63a9';

const hmac = createHmac('sha256', salt).update(password).digest('hex');
console.log(`rpcauth=${user}:${salt}$${hmac}`);
console.log('(escape the $ as $$ when pasting into docker-compose.yml)');
