/**
 * EchoCoding cloud API authentication.
 * HMAC-SHA256 signature — CLI signs requests, proxy verifies.
 *
 * Key management:
 * - Install generates a random secret, saved to ~/.echocoding/secret
 * - Proxy reads secret from EC_HMAC_SECRET env var
 * - Both sides compute HMAC over: method + path + timestamp + bodyHash
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SECRET_FILE = path.join(os.homedir(), '.echocoding', 'secret');

/** Fallback key for managed proxy (used when no local secret exists) */
const MANAGED_KEY = 'ec-managed-v1-' + '7a3f2b1d5e8c490f6d2a1b3e7c9f4d8a';

/**
 * Get or generate the HMAC signing secret.
 * - First checks EC_HMAC_SECRET env var (for proxy server)
 * - Then checks ~/.echocoding/secret file (for CLI)
 * - Falls back to managed key (for fresh installs using managed proxy)
 */
function getSecret(): string {
  // Env var takes priority (proxy server uses this)
  const envSecret = process.env.EC_HMAC_SECRET;
  if (envSecret) return envSecret;

  // Read from local file
  try {
    if (fs.existsSync(SECRET_FILE)) {
      return fs.readFileSync(SECRET_FILE, 'utf-8').trim();
    }
  } catch { /* ignore */ }

  // Use managed key (works with our managed proxy out of the box)
  return MANAGED_KEY;
}

/**
 * Generate and save a new random secret to ~/.echocoding/secret.
 * Called during `echocoding install` for users who want their own proxy.
 */
export function generateSecret(): string {
  const secret = `ec-user-${crypto.randomBytes(24).toString('hex')}`;
  const dir = path.dirname(SECRET_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SECRET_FILE, secret + '\n', { mode: 0o600 });
  return secret;
}

/**
 * Generate auth headers for a cloud API request.
 * Signs: METHOD + PATH + timestamp + SHA256(body)
 */
export function signRequest(body: string, method = 'POST', urlPath = '/'): Record<string, string> {
  const secret = getSecret();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const payload = `${method}:${urlPath}:${timestamp}:${bodyHash}`;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  return {
    'X-Ec-Timestamp': timestamp,
    'X-Ec-Signature': signature,
  };
}

/**
 * Verify auth headers on the proxy side.
 * Returns true if valid, false if invalid or expired.
 */
export function verifyRequest(
  method: string,
  urlPath: string,
  timestamp: string | undefined,
  signature: string | undefined,
  body: string,
): boolean {
  if (!timestamp || !signature) return false;

  // Reject requests outside 2-minute window (both directions)
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(now - ts) > 120) return false;

  const secret = getSecret();
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const payload = `${method}:${urlPath}:${timestamp}:${bodyHash}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  // Constant-time comparison
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}
