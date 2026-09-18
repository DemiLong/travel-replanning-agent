import { z } from "zod";
import { CoordinateSchema } from "@/types/world";
import { AmapPlacesService } from "@/services/world/amap-places-service";
import { WorldServiceError } from "@/services/world/amap-client";
const Input = z.object({ keywords: z.string().trim().min(1).max(100), city: z.string().max(80), location: CoordinateSchema.optional() });
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > 4000) return Response.json({error:"请求过大"},{status:413});
    const input = Input.parse(JSON.parse(raw));
    const service = new AmapPlacesService();
    return Response.json(input.location ? await service.around(input.keywords,input.location) : await service.search(input.keywords,input.city), {headers:{"Cache-Control":"no-store"}});
  } catch(error) {
    return Response.json({status:"unavailable",error:error instanceof WorldServiceError ? error.message : "地点查询参数无效。"}, {status:error instanceof WorldServiceError ? 503 : 400});
  }
}
