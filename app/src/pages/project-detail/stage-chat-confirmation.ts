import type { ToolConfirmRequest } from "@/lib/llm/tools";
import { createSequentialRequestQueue, type SequentialRequestQueue } from "@/pages/chat/sequential-request-queue";

export interface StageChatConfirmationController {
  beginTurn: (signal: AbortSignal) => StageChatConfirmationTurn;
  invalidate: () => void;
  resolveCurrent: (value: boolean) => boolean;
  resolveAll: (value: boolean) => void;
  current: () => ToolConfirmRequest | null;
}

export interface StageChatConfirmationTurn {
  requestConfirm: (request: ToolConfirmRequest) => Promise<boolean>;
  invalidate: () => void;
  finish: () => void;
}

export function createStageChatConfirmationController(
  onCurrentChange: (request: ToolConfirmRequest | null) => void,
): StageChatConfirmationController {
  const queue: SequentialRequestQueue<ToolConfirmRequest, boolean> = createSequentialRequestQueue(onCurrentChange);
  let generation = 0;
  return {
    beginTurn(signal) {
      generation += 1;
      queue.resolveAll(false);
      const turnGeneration = generation;
      const finish = () => {
        if (generation !== turnGeneration) return;
        generation += 1;
        queue.resolveAll(false);
      };
      return {
        requestConfirm(request) {
          if (signal.aborted || turnGeneration !== generation) return Promise.resolve(false);
          return queue.request(request);
        },
        invalidate: finish,
        finish,
      };
    },
    invalidate() {
      generation += 1;
      queue.resolveAll(false);
    },
    resolveCurrent: queue.resolveCurrent,
    resolveAll: queue.resolveAll,
    current: queue.current,
  };
}
