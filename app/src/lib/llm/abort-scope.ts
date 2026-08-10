export interface AbortScope {
  signal: AbortSignal;
  dispose: () => void;
}

/**
 * 为一次辅助异步调用组合“用户停止”和超时，并显式释放监听器与计时器。
 * 不能只临时拼两个事件监听器：父 signal 已经取消时会漏掉事件，正常完成时也会残留监听器。
 */
export function createAbortScope(
  parent?: AbortSignal,
  timeoutMs = 30_000,
): AbortScope {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => {
    controller.abort(new DOMException("Operation timed out", "TimeoutError"));
  }, timeoutMs);
  const abortFromParent = () => controller.abort(parent?.reason);
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    globalThis.clearTimeout(timeoutId);
    parent?.removeEventListener("abort", abortFromParent);
    controller.signal.removeEventListener("abort", dispose);
  };

  controller.signal.addEventListener("abort", dispose, { once: true });
  if (parent?.aborted) {
    abortFromParent();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }

  return { signal: controller.signal, dispose };
}
