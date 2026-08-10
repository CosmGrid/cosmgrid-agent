import { useEffect, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import type { Attachment } from "@/lib/llm/attachments";
import type { ChatMessage, PendingSend } from "@/pages/chat/types";

export function useStreamingTimer({
  isStreaming,
  setStreamElapsedMs,
}: {
  isStreaming: boolean;
  setStreamElapsedMs: Dispatch<SetStateAction<number>>;
}) {
  useEffect(() => {
    if (!isStreaming) {
      setStreamElapsedMs(0);
      return;
    }
    const start = Date.now();
    setStreamElapsedMs(0);
    const id = setInterval(() => setStreamElapsedMs(Date.now() - start), 200);
    return () => clearInterval(id);
  }, [isStreaming, setStreamElapsedMs]);
}

export function useAutoScrollOnMessages({
  messages,
  scrollRef,
  stickToBottomRef,
}: {
  messages: ChatMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  stickToBottomRef: MutableRefObject<boolean>;
}) {
  useEffect(() => {
    if (scrollRef.current && stickToBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, scrollRef, stickToBottomRef]);
}

export function usePendingSendDrain({
  drainingRef,
  drainVersionRef,
  isStreaming,
  onError,
  pendingQueue,
  sendRef,
  setPendingQueue,
}: {
  drainingRef: MutableRefObject<boolean>;
  /** 停止时递增；旧发送完成后不得清掉新发送的 draining 状态。 */
  drainVersionRef: MutableRefObject<number>;
  isStreaming: boolean;
  onError: (error: unknown) => void;
  pendingQueue: PendingSend[];
  sendRef: MutableRefObject<(text: string, attachments?: Attachment[]) => Promise<void>>;
  setPendingQueue: Dispatch<SetStateAction<PendingSend[]>>;
}) {
  useEffect(() => {
    if (drainingRef.current || isStreaming || pendingQueue.length === 0) return;
    const next = pendingQueue[0]!;
    const drainVersion = drainVersionRef.current;
    drainingRef.current = true;
    setPendingQueue((q) => q.slice(1));
    void sendRef.current(next.text, next.attachments)
      .catch((error: unknown) => {
        if (drainVersionRef.current === drainVersion) onError(error);
      })
      .finally(() => {
        if (drainVersionRef.current === drainVersion) drainingRef.current = false;
      });
  }, [drainingRef, drainVersionRef, isStreaming, onError, pendingQueue, sendRef, setPendingQueue]);
}
