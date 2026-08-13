export interface TurnOwnerRef {
  current: AbortController | null;
}

/** 只允许仍持有 abortRef 的那一轮释放全局流式状态。 */
export function releaseTurnIfCurrent(
  ownerRef: TurnOwnerRef,
  controller: AbortController,
  release: () => void,
): boolean {
  if (ownerRef.current !== controller) return false;
  ownerRef.current = null;
  release();
  return true;
}
