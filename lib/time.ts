export const minutes = (time: string) =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export const time = (value: number) =>
  `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

export class CrossDayTimeError extends Error {
  readonly code = "CROSS_DAY_UNSUPPORTED" as const;

  constructor() {
    super("当前行程暂不支持跨日活动。");
    this.name = "CrossDayTimeError";
  }
}

export function addMinutesWithinDay(startTime: string, durationMinutes: number) {
  const total = minutes(startTime) + durationMinutes;
  if (!Number.isInteger(durationMinutes) || durationMinutes < 0 || total >= 24 * 60)
    throw new CrossDayTimeError();
  return time(total);
}
