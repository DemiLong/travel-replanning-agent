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
    throw new Error("实时规划需要已配置的访客会话，请使用模拟模式。");
  }
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) throw new Error("开始实时规划前，请先启动访客会话。");
  const client = createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new Error("访客会话已过期，请刷新后再试。");
  const limited = await client.rpc("claim_replan_request");
  if (limited.error)
    throw new Error("实时规划暂时受限，请等待一分钟或使用模拟模式。");
}
