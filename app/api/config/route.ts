export function GET() {
  const semanticParserEnabled = Boolean(
    process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_MODEL,
  );
  return Response.json(
    {
      externalServicesEnabled: semanticParserEnabled && Boolean(process.env.AMAP_API_KEY),
      persistence: "browser",
      planner: semanticParserEnabled ? "deepseek-grounded-candidates" : "not-configured",
      worldProvider: process.env.AMAP_API_KEY ? "amap" : "not-configured",
      semanticParser: semanticParserEnabled
        ? "deepseek-structured-outputs"
        : "not-configured",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
