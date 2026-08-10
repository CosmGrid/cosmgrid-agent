export interface AssistantModelMessage {
  role: "user" | "assistant";
  content: string;
  modelLabel?: string;
}

export type StreamActivityPhase = "idle" | "streaming" | "checking" | "compressing";

export function getActiveAssistantModelLabel(
  messages: readonly AssistantModelMessage[],
  selectedModelLabel: string,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant" && message.modelLabel?.trim()) {
      return message.modelLabel;
    }
  }
  return selectedModelLabel;
}

/** 把毫秒格式化成 "3s" / "1m 5s"，给"思考中/回复中"计时用。 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
}

export function getAssistantActivityLabel(
  phase: StreamActivityPhase,
  replyingLabel: string,
  checkingLabel: string,
): string {
  return phase === "checking" ? checkingLabel : replyingLabel;
}
