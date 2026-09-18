import { WorldContextService } from "@/services/world/world-context-service";
import { WorldServiceError } from "@/services/world/amap-client";
export const maxDuration=90;
export async function POST(request:Request){
  try{
    const raw=await request.text();
    if(raw.length>80000)return Response.json({error:"请求内容过大。"},{status:413});
    return Response.json(await new WorldContextService().ground(JSON.parse(raw)),{headers:{"Cache-Control":"no-store"}});
  }catch(error){
    return Response.json({status:"unavailable",error:error instanceof WorldServiceError?error.message:"请先确认真实行程、当前时间及本次变化。"},{status:error instanceof WorldServiceError?503:400});
  }
}
