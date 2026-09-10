import { createClient } from "@supabase/supabase-js";
export async function authenticatePlanner(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    if (
      process.env.NODE_ENV !== "production" &&
      process.env.ALLOW_LOCAL_LIVE === "true"
    )
      return;
    throw new Error(
      "Live planning requires a configured guest session. Use Demo mode.",
    );
  }
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) throw new Error("Start a guest session before live planning.");
  const client = createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user)
    throw new Error("Your guest session expired. Reload and try again.");
  const limited = await client.rpc("claim_replan_request");
  if (limited.error)
    throw new Error(
      "Live planning is temporarily limited. Please wait a minute or use Demo mode.",
    );
}
