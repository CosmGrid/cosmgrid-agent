import { projects } from "@/lib/db";
import { buildProjectMemoryPreamble } from "@/lib/llm/prompts/context-preamble";
import { assemblePlaybookContext } from "@/lib/llm/playbook/context-assembler";
import {
  retrieveCrossProjectMemoriesForPrompt,
  retrieveProjectMemoriesForPrompt,
} from "@/lib/memory/retrieval";
import type { ProjectMemory } from "@/lib/db/memory";

export interface BuildChatMemoryPreamblesArgs {
  projectId: string | null;
  text: string;
  pureMode: boolean;
  stopIfAborted: () => boolean;
}

export interface BuiltChatMemoryPreambles {
  aborted: boolean;
  projectMemoryPreamble: string | null;
  crossProjectPreamble: string | null;
  /** 阶段5 Playbook：本轮注入 prompt 的记忆条目 id（onMemoryUsed / UI 赞踩用） */
  usedMemoryIds: string[];
  /** 本轮注入的条目本体（WorkPanel 赞踩列表直接用，避免二次查库） */
  usedMemories: ProjectMemory[];
}

/** 语义检索 + playbook 加权检索合并后的注入条目上限 */
const MERGED_MEMORY_LIMIT = 10;

/**
 * 粗切关键词（playbook tags 加权用）：按标点/空白切段，取 2-24 字符的前 8 段。
 * 中文长句切不出细粒度词也无害——tags 匹配是 includes 语义，匹配不上只是不加权。
 */
export function extractTaskKeywords(text: string): string[] {
  return text
    .split(/[\s,，。！？!?；;、:：()（）\x5b\x5d【】"'`]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 24)
    .slice(0, 8);
}

export async function buildChatMemoryPreambles(
  args: BuildChatMemoryPreamblesArgs,
): Promise<BuiltChatMemoryPreambles> {
  if (!args.projectId || args.pureMode) {
    return {
      aborted: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      usedMemoryIds: [],
      usedMemories: [],
    };
  }

  try {
    const [{ preamble }, project, memories, playbookItems] = await Promise.all([
      retrieveCrossProjectMemoriesForPrompt(args.projectId, args.text),
      projects.getById(args.projectId),
      retrieveProjectMemoriesForPrompt(args.projectId, args.text),
      // 阶段5 Playbook（2026-07-17 断点③接线）：加权检索（confidence / helpful / harmful /
      // last_used / tags 命中）补充语义检索——两路合并去重，语义 hits 优先
      assemblePlaybookContext({
        projectId: args.projectId,
        taskKeywords: extractTaskKeywords(args.text),
      }).catch(() => [] as ProjectMemory[]),
    ]);
    if (args.stopIfAborted()) {
      return {
        aborted: true,
        projectMemoryPreamble: null,
        crossProjectPreamble: null,
        usedMemoryIds: [],
        usedMemories: [],
      };
    }
    const seen = new Set(memories.map((m) => m.id));
    const merged = [...memories];
    for (const item of playbookItems) {
      if (merged.length >= MERGED_MEMORY_LIMIT) break;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
    return {
      aborted: false,
      projectMemoryPreamble: buildProjectMemoryPreamble(project?.name, merged),
      crossProjectPreamble: preamble,
      usedMemoryIds: merged.map((m) => m.id),
      usedMemories: merged,
    };
  } catch {
    return {
      aborted: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      usedMemoryIds: [],
      usedMemories: [],
    };
  }
}
