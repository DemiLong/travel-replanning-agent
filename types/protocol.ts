export const MAX_RAW_INPUT_LENGTH = 4_000;
export const RAW_INPUT_TOO_LONG_MESSAGE = "输入最多 4000 个字，请删减后再提交。";
export const WORLD_CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
export const REQUEST_DEADLINE_MS = 30_000;
export const MAP_REQUEST_TIMEOUT_MS = 8_000;

export function isRawInputWithinLimit(value: string) {
  return value.length <= MAX_RAW_INPUT_LENGTH;
}

export function rawInputRemaining(value: string) {
  return Math.max(0, MAX_RAW_INPUT_LENGTH - value.length);
}

export function isWorldConfirmationExpired(
  confirmedAt: string,
  nowMs = Date.now(),
) {
  const confirmedAtMs = Date.parse(confirmedAt);
  if (!Number.isFinite(confirmedAtMs)) return true;
  return nowMs - confirmedAtMs > WORLD_CONFIRMATION_TTL_MS;
}
