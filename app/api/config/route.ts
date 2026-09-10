export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(
    {
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      supabaseKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
      liveAvailable: Boolean(
        process.env.OPENAI_API_KEY &&
        process.env.OPENAI_MODEL &&
        ((process.env.NEXT_PUBLIC_SUPABASE_URL &&
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) ||
          (process.env.NODE_ENV !== "production" &&
            process.env.ALLOW_LOCAL_LIVE === "true")),
      ),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
