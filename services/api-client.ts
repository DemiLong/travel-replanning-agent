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

let browserClient: SupabaseClient | null | undefined;
let sessionPromise: Promise<string> | null = null;
let renewalPromise: Promise<string> | null = null;
let lastRejectedToken: string | null = null;
let lastReplacementToken: string | null = null;

function abortIfNeeded(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function client() {
  const testEnvironment = globalThis as typeof globalThis & {
    __COVEREDYOU_DISABLE_AUTH_FOR_TESTS__?: boolean;
  };
  if (testEnvironment.__COVEREDYOU_DISABLE_AUTH_FOR_TESTS__ === true) {
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

async function createAnonymousSession(authClient: SupabaseClient) {
  if (!sessionPromise) {
    sessionPromise = authClient.auth.signInAnonymously().then(({ data, error }) => {
      if (error || !data.session?.access_token) {
        throw new Error("会话服务暂时不可用，请稍后重试。");
      }
      return data.session.access_token;
    }).finally(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
}

async function accessToken(forceNew: boolean, signal?: AbortSignal, rejectedToken?: string | null) {
  abortIfNeeded(signal);
  const authClient = client();
  if (!authClient) return null;
  if (forceNew) {
    if (rejectedToken && rejectedToken === lastRejectedToken && lastReplacementToken) {
      return lastReplacementToken;
    }
    if (!renewalPromise) {
      renewalPromise = authClient.auth.signOut({ scope: "local" }).then(async () => {
        const { data, error } = await authClient.auth.signInAnonymously();
        if (error || !data.session?.access_token) {
          throw new Error("会话服务暂时不可用，请稍后重试。");
        }
        lastRejectedToken = rejectedToken ?? null;
        lastReplacementToken = data.session.access_token;
        return data.session.access_token;
      }).finally(() => {
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
    if (firstResponse.status !== 401 || firstToken === null) return firstResponse;

    abortIfNeeded(options.signal);
    await firstResponse.body?.cancel();
    const replacementToken = await dependencies.getAccessToken(true, options.signal, firstToken);
    abortIfNeeded(options.signal);
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
