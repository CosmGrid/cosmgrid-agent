interface PendingRequest<TRequest, TValue> {
  request: TRequest;
  resolve: (value: TValue) => void;
}

export interface SequentialRequestQueue<TRequest, TValue> {
  request: (request: TRequest) => Promise<TValue>;
  resolveCurrent: (value: TValue) => boolean;
  resolveAll: (value: TValue) => void;
  current: () => TRequest | null;
}

/** 串行展示 Promise 型 UI 请求，避免后一个请求覆盖前一个 resolver。 */
export function createSequentialRequestQueue<TRequest, TValue>(
  onCurrentChange: (request: TRequest | null) => void,
): SequentialRequestQueue<TRequest, TValue> {
  let active: PendingRequest<TRequest, TValue> | null = null;
  const waiting: PendingRequest<TRequest, TValue>[] = [];

  const showNext = () => {
    active = waiting.shift() ?? null;
    onCurrentChange(active?.request ?? null);
  };

  return {
    request(request) {
      return new Promise<TValue>((resolve) => {
        const pending = { request, resolve };
        if (active) {
          waiting.push(pending);
          return;
        }
        active = pending;
        onCurrentChange(request);
      });
    },
    resolveCurrent(value) {
      if (!active) return false;
      const completed = active;
      showNext();
      completed.resolve(value);
      return true;
    },
    resolveAll(value) {
      const pending = active ? [active, ...waiting] : [...waiting];
      active = null;
      waiting.length = 0;
      onCurrentChange(null);
      for (const item of pending) item.resolve(value);
    },
    current() {
      return active?.request ?? null;
    },
  };
}
