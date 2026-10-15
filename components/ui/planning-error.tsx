"use client";

import { useEffect, useState } from "react";

function RetryCountdown({ seconds }: { seconds: number }) {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    const deadline = Date.now() + seconds * 1000;
    const update = () => setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    const timer = window.setInterval(update, 250);
    document.addEventListener("visibilitychange", update);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [seconds]);
  return <div className="error-box" role="status" aria-live={remaining ? "off" : "polite"}>
    {remaining > 0 ? `操作有些频繁，请在 ${remaining} 秒后重试。` : "现在可以重试了，请点击按钮重新提交。"}
  </div>;
}

export function PlanningError({ message }: { message: string }) {
  const match = message.match(/^操作有些频繁，请在\s*(\d+)\s*秒后重试。?$/);
  return match ? <RetryCountdown key={message} seconds={Number(match[1])} /> : <div className="error-box" role="alert">{message}</div>;
}
