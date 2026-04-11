/**
 * Bootstrap script for CI: creates a test domain via the Takaro AdminClient
 * and prints the credentials as KEY=VALUE lines to stdout.
 *
 * Usage: node --import=ts-node-maintained/register/esm src/scripts/ci-create-domain.ts
 *
 * Required env vars:
 *   TAKARO_HOST         - e.g. http://localhost:13000
 *   ADMIN_CLIENT_SECRET - the admin client secret used to authenticate
 */

import { AdminClient } from '@takaro/apiclient';
import { randomUUID } from 'crypto';

const host = process.env['TAKARO_HOST'];
const adminClientSecret = process.env['ADMIN_CLIENT_SECRET'];

if (!host) throw new Error('TAKARO_HOST is required');
if (!adminClientSecret) throw new Error('ADMIN_CLIENT_SECRET is required');

const adminClient = new AdminClient({
  url: host,
  auth: {
    clientSecret: adminClientSecret,
  },
  log: false,
});

const response = await adminClient.domain.domainControllerCreate({
  name: `ci-test-${randomUUID()}`.slice(0, 49),
  maxGameservers: 10,
  maxUsers: 5,
});

if (!response.data || !response.data.data) {
  console.error('ERROR: Domain creation API returned unexpected response:', JSON.stringify(response.data));
  process.exit(1);
}

const { createdDomain, rootUser, password } = response.data.data;

if (!createdDomain || !rootUser || !password) {
  // Redact password before logging to avoid leaking credentials
  const { password: _redacted, ...safeData } = response.data.data ?? {};
  console.error('ERROR: Domain creation response missing expected fields:', JSON.stringify(safeData));
  process.exit(1);
}

console.log(`TAKARO_DOMAIN_ID=${createdDomain.id}`);
console.log(`TAKARO_USERNAME=${rootUser.email}`);
console.log(`TAKARO_PASSWORD=${password}`);
console.log(`TAKARO_REGISTRATION_TOKEN=${createdDomain.serverRegistrationToken ?? ''}`);
