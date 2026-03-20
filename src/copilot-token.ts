/**
 * Copilot Token lifecycle manager for DroidClaw.
 *
 * Reads the cached token from .copilot_cache/copilot_token.json,
 * checks expiration, and calls copilot_auth.py to refresh when needed.
 *
 * Two-layer protection:
 *   1. Proactive refresh — called before each LLM request
 *   2. Reactive refresh — called on 401 (exposed for retry logic)
 */

import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";

/** Refresh token this many seconds before actual expiration */
const REFRESH_MARGIN_SECONDS = 120;

/** Path to copilot_auth.py (project root) */
const AUTH_SCRIPT = resolve(
  import.meta.dirname ?? dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "copilot_auth.py"
);

/** Path to cached copilot token */
const COPILOT_TOKEN_FILE = resolve(
  import.meta.dirname ?? dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  ".copilot_cache",
  "copilot_token.json"
);

interface CopilotTokenCache {
  token: string;
  expires_at: number;
}

let cachedToken: string | null = null;
let cachedExpiresAt = 0;

/**
 * Read token from the on-disk cache file.
 * Returns null if file doesn't exist or is unparseable.
 */
function readTokenFile(): CopilotTokenCache | null {
  try {
    if (!existsSync(COPILOT_TOKEN_FILE)) return null;
    const data = JSON.parse(readFileSync(COPILOT_TOKEN_FILE, "utf-8"));
    if (data.token && data.expires_at) {
      return { token: data.token, expires_at: data.expires_at };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Call copilot_auth.py to refresh the token.
 * The script handles GitHub token → Copilot token exchange and writes the cache file.
 * Returns the fresh token string.
 */
async function callAuthScript(): Promise<string> {
  console.log("[copilot-token] Refreshing Copilot token via copilot_auth.py...");

  const proc = Bun.spawn(["python", AUTH_SCRIPT, "token"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    throw new Error(
      `copilot_auth.py failed (exit ${exitCode}): ${stderr.trim()}`
    );
  }

  const token = stdout.trim();
  if (!token) {
    throw new Error("copilot_auth.py returned empty token");
  }

  // Re-read the cache file to get expires_at (the script writes it)
  const cached = readTokenFile();
  if (cached) {
    cachedToken = cached.token;
    cachedExpiresAt = cached.expires_at;
  } else {
    // Fallback: assume 30 min from now
    cachedToken = token;
    cachedExpiresAt = Math.floor(Date.now() / 1000) + 1500;
  }

  console.log(
    `[copilot-token] Token refreshed, expires at ${new Date(cachedExpiresAt * 1000).toLocaleTimeString()}`
  );

  return token;
}

/**
 * Check if current token is still valid (with safety margin).
 */
function isTokenValid(): boolean {
  if (!cachedToken) return false;
  const now = Math.floor(Date.now() / 1000);
  return now < cachedExpiresAt - REFRESH_MARGIN_SECONDS;
}

/**
 * Get a valid Copilot token. Refreshes automatically if expired or near-expiry.
 * Call this before each LLM request (proactive refresh).
 */
export async function getCopilotToken(): Promise<string> {
  // First call: try to load from disk cache
  if (!cachedToken) {
    const diskCache = readTokenFile();
    if (diskCache) {
      cachedToken = diskCache.token;
      cachedExpiresAt = diskCache.expires_at;
    }
  }

  // If valid, return immediately
  if (isTokenValid()) {
    return cachedToken!;
  }

  // Expired or near-expiry → refresh
  return callAuthScript();
}

/**
 * Force-refresh the token (reactive, for 401 recovery).
 * Always calls copilot_auth.py regardless of cached state.
 */
export async function forceRefreshCopilotToken(): Promise<string> {
  cachedToken = null;
  cachedExpiresAt = 0;
  return callAuthScript();
}

/**
 * Check if the Copilot token auto-refresh is applicable.
 * Returns true if copilot_auth.py exists AND we're using a GitHub Copilot endpoint.
 */
export function isCopilotAutoRefreshAvailable(): boolean {
  return existsSync(AUTH_SCRIPT);
}
