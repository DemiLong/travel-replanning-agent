"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type AuthenticatedJsonOptions = {
  json: unknown;
  signal?: AbortSignal;
};

export type AuthenticatedFetchDependencies = {
  getAccessToken(forceNew: boolean, signal?: AbortSignal, rejectedToken?: string | null): Promise<string | null>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

/**
 * AuthState:
 * - idle: prewarm not started yet
 * - preparing: anonymous session is being established
 * - ready: a usable session exists
 * - unconfigured: no auth layer is present (tests or missing env); proceed without auth
 * - error: prewarm failed; UI can offer a manual retry
 */
export type AuthState = "idle" | "preparing" | "ready" | "unconfigured" | "error";
export type AuthStateSnapshot = { status: AuthState; error: string | null };

let browserClient: SupabaseClient | null | undefined;
let sessionPromise: Promise<string> | null = null;
let renewalPromise: Promise<string> | null = null;
let lastRejectedToken: string | null = null;
let lastReplacementToken: string | null = null;

let authSnapshot: AuthStateSnapshot = { status: "idle", error: null };
const authListeners = new Set<() => void>();

function abortIfNeeded(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function setAuthState(status: AuthState, error: string | null = null) {
  authSnapshot = { status, error };
  authListeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // A broken subscriber must not block the auth state update.
    }
  });
}

export function getAuthStateSnapshot(): AuthStateSnapshot {
  return authSnapshot;
}

export function subscribeAuthState(listener: () => void): () => void {
  authListeners.add(listener);
  return () => {
    authListeners.delete(listener);
  };
}

function isAuthDisabledForTests(): boolean {
  const testEnvironment = globalThis as typeof globalThis & {
    __COVEREDYOU_DISABLE_AUTH_FOR_TESTS__?: boolean;
  };
  return testEnvironment.__COVEREDYOU_DISABLE_AUTH_FOR_TESTS__ === true;
}

function client() {
  if (isAuthDisabledForTests()) {
    browserClient = null;
    return browserClient;
  }
  if (browserClient !== undefined) return browserClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) {
    browserClient = null;
    return browserClient;
  }
  browserClient = createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return browserClient;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isTransientSignInError(error: unknown): boolean {
  // Network/fetch/timeout failures are worth one retry; configuration or
  // authentication errors (e.g. anonymous sign-ins disabled) are not.
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /network|fetch|timeout|timed out|failed to fetch|网络|超时|连接/i.test(message);
}

async function signInAnonymouslyOnce(authClient: SupabaseClient): Promise<string> {
  const { data, error } = await authClient.auth.signInAnonymously();
  if (error || !data.session?.access_token) {
    throw new Error("会话服务暂时不可用，请稍后重试。");
  }
  return data.session.access_token;
}

async function createAnonymousSession(authClient: SupabaseClient): Promise<string> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      try {
        return await signInAnonymouslyOnce(authClient);
      } catch (error) {
        if (isTransientSignInError(error)) {
          await delay(600);
          return signInAnonymouslyOnce(authClient);
        }
        throw error;
      }
    })().finally(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
}

async function accessToken(forceNew: boolean, signal?: AbortSignal, rejectedToken?: string | null): Promise<string | null> {
  abortIfNeeded(signal);
  const authClient = client();
  if (!authClient) return null;
  if (forceNew) {
    if (rejectedToken && rejectedToken === lastRejectedToken && lastReplacementToken) {
      return lastReplacementToken;
    }
    if (!renewalPromise) {
      renewalPromise = (async () => {
        // Best-effort local sign-out; never block the renewal on this call.
        await authClient.auth.signOut({ scope: "local" }).catch(() => undefined);
        const token = await signInAnonymouslyOnce(authClient);
        lastRejectedToken = rejectedToken ?? null;
        lastReplacementToken = token;
        return token;
      })().finally(() => {
        renewalPromise = null;
      });
    }
    const replacement = await renewalPromise;
    abortIfNeeded(signal);
    return replacement;
  }
  const { data, error } = await authClient.auth.getSession();
  abortIfNeeded(signal);
  if (!error && data.session?.access_token) return data.session.access_token;
  return createAnonymousSession(authClient);
}

/**
 * Establish the anonymous session ahead of the first user action.
 * Safe to call more than once; concurrent callers share the same sign-in.
 */
export async function prewarmAnonymousSession(signal?: AbortSignal): Promise<string | null> {
  const authClient = client();
  if (!authClient) {
    // Tests or a missing public config: there is no auth layer to warm up.
    setAuthState("unconfigured");
    return null;
  }
  setAuthState("preparing");
  try {
    const token = await accessToken(false, signal);
    if (token) {
      setAuthState("ready");
      return token;
    }
    setAuthState("unconfigured");
    return null;
  } catch (error) {
    abortIfNeeded(signal);
    const message = error instanceof Error ? error.message : "会话服务暂时不可用，请稍后重试。";
    setAuthState("error", message);
    throw error;
  }
}

/** Drop any cached session state and warm up a fresh anonymous session. */
export async function retryAnonymousSession(signal?: AbortSignal): Promise<string | null> {
  lastRejectedToken = null;
  lastReplacementToken = null;
  return prewarmAnonymousSession(signal);
}

async function sendJson(
  path: string,
  json: unknown,
  signal: AbortSignal | undefined,
  token: string | null,
  requestFetch: typeof fetch,
) {
  abortIfNeeded(signal);
  return requestFetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(json),
    signal,
  });
}

export function createAuthenticatedJsonFetch(dependencies: AuthenticatedFetchDependencies) {
  return async (path: string, options: AuthenticatedJsonOptions) => {
    const firstToken = await dependencies.getAccessToken(false, options.signal);
    const firstResponse = await sendJson(path, options.json, options.signal, firstToken, dependencies.fetch);
    if (firstResponse.status !== 401) return firstResponse;
    // Without an auth layer there is nothing to refresh; keep the body readable.
    if (firstToken === null) return firstResponse;

    abortIfNeeded(options.signal);
    await firstResponse.body?.cancel();
    const replacementToken = await dependencies.getAccessToken(true, options.signal, firstToken);
    abortIfNeeded(options.signal);
    if (!replacementToken) {
      // Could not establish a replacement; re-issue so the caller still
      // receives a readable failure envelope instead of a canceled body.
      return sendJson(path, options.json, options.signal, null, dependencies.fetch);
    }
    return sendJson(path, options.json, options.signal, replacementToken, dependencies.fetch);
  };
}

const defaultAuthenticatedJsonFetch = createAuthenticatedJsonFetch({
  getAccessToken: accessToken,
  fetch: (input, init) => fetch(input, init),
});

export async function authenticatedJsonFetch(path: string, options: AuthenticatedJsonOptions) {
  return defaultAuthenticatedJsonFetch(path, options);
}
