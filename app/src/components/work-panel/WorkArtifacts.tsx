// 阶段 B：右侧工作面板的产出物视图。
// 独立组件——不把已经很肥的 ChatPage 越堆越大。只收 artifacts props，数据派生在 work-artifacts.ts。
// 主角是产出物（文件/HTML/终端），模型名完全不出现。token 账单区块在 ChatPage 原位保留，互不干扰。
// 阶段 G：加 html kind 渲染（iframe 沙箱 + referrerPolicy 防外链）；edit 工件用 DiffView 渲染行级 -/+ 对比。
import { memo, useState } from "react";
import { FileText, Terminal as TerminalIcon, Code2, ChevronDown, CheckCircle2, XCircle, Ban } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { WorkArtifact } from "@/lib/work-artifacts";
import { DiffView } from "./DiffView";
import { MAX_DETAIL_LINES, HTML_SRC_LIMIT } from "./constants";

function StatusDot({ status }: { status: WorkArtifact["status"] }) {
  if (status === "success") return <CheckCircle2 className="w-3 h-3 text-emerald-400/80 shrink-0" />;
  if (status === "denied") return <Ban className="w-3 h-3 text-amber-400/80 shrink-0" />;
  return <XCircle className="w-3 h-3 text-red-400/80 shrink-0" />;
}

const ArtifactItem = memo(function ArtifactItem({ artifact }: { artifact: WorkArtifact }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // 阶段 G：3 种 kind 图标（file/terminal/html）+ edit 工件走 DiffView
  const Icon = artifact.kind === "terminal" ? TerminalIcon
    : artifact.kind === "html" ? Code2
    : FileText;
  const body = artifact.detail;
  const lines = body.split("\n");
  const truncated = lines.length > MAX_DETAIL_LINES;
  const shown = truncated ? lines.slice(0, MAX_DETAIL_LINES).join("\n") : body;
  const empty = body.trim() === "";
  // 阶段 G：html 工件超过 HTML_SRC_LIMIT 不直接塞 iframe（防 srcDoc 卡顿），降级为 source 模式
  // 阶段 J 修（铁律 4：静默吞错）：isHtmlTooLarge 降级路径加 dev warning，让 QA 能发现
  const isHtmlTooLarge = artifact.kind === "html" && body.length > HTML_SRC_LIMIT;
  if (isHtmlTooLarge && import.meta.env.DEV) {
    console.warn(`[WorkArtifacts] HTML too large (${body.length} bytes), falling back to source view: ${artifact.title}`);
  }
  // 阶段 G：edit 工件有 diffOld → 展开区用 DiffView，不显示 pre
  const isEditWithDiff = artifact.kind === "file" && artifact.action === "edit" && !!artifact.diffOld;

  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
      <button
        type="button"
        // detail 为空（如 denied 的 bash 没输出）就不可展开，避免点开一个空壳
        onClick={() => !empty && setOpen((v) => !v)}
        className={cn("w-full flex items-center gap-2 px-3 py-2 text-left transition-colors", !empty && "hover:bg-white/5")}
      >
        <Icon className="w-3.5 h-3.5 shrink-0 text-primary/70" />
        <span className="text-[11px] font-mono truncate flex-1">{artifact.title}</span>
        <StatusDot status={artifact.status} />
        {!empty && (
          <ChevronDown className={cn("w-3 h-3 shrink-0 opacity-50 transition-transform", open && "rotate-180")} />
        )}
      </button>
      {open && !empty && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          {/* 阶段 G：edit + 有 diffOld → DiffView 渲染（行级 -/+） */}
          {isEditWithDiff && artifact.diffOld ? (
            <DiffView oldText={artifact.diffOld} newText={body} />
          ) : isHtmlTooLarge ? (
            // html 工件超大 → 降级显示 source + 截断提示（不直接 iframe 防卡顿）
            <>
              <pre className="text-[10px] leading-relaxed font-mono text-muted-foreground/70 whitespace-pre-wrap break-words bg-foreground/[0.04] rounded-lg p-2 max-h-64 overflow-auto custom-scrollbar">
                {shown}
              </pre>
              <div className="text-[9px] text-amber-500/70">
                {t("chat.workPanel.htmlTooLarge", { size: body.length })}
              </div>
            </>
          ) : artifact.kind === "html" ? (
            // 阶段 G：html 工件 → iframe 沙箱渲染（review R3：sandbox="" 零权限 + referrerPolicy 防外链）
            // 阶段 J 修（铁律 4.1/4.2）：iframe onError 加 log，防 srcDoc 解析失败 / HTML 不合法静默
            <>
              <iframe
                srcDoc={body}
                sandbox=""
                referrerPolicy="no-referrer"
                title={t("chat.workPanel.htmlSandboxTitle")}
                className="w-full h-64 rounded border border-white/5 custom-scrollbar"
                onLoad={(e) => {
                  // iframe 加载完成后检查内容是否合法；cross-origin 取不到内容，只能尝试访问 document
                  try {
                    const doc = e.currentTarget.contentDocument;
                    if (doc && doc.body && doc.body.childNodes.length === 0) {
                      console.warn(`[WorkArtifacts] iframe 加载后无内容: ${artifact.title}`);
                    }
                  } catch {
                    // cross-origin 阻止访问是预期行为（sandbox="" 零权限），不报警
                  }
                }}
                onError={() => {
                  if (import.meta.env.DEV) {
                    console.error(`[WorkArtifacts] iframe 加载失败: ${artifact.title}`);
                  }
                }}
              />
              <div className="text-[9px] text-muted-foreground/50">
                {t("chat.workPanel.htmlJsDisabledHint")}
              </div>
            </>
          ) : (
            // 默认 file/terminal 走 pre
            <>
              <pre className="text-[10px] leading-relaxed font-mono text-muted-foreground/70 whitespace-pre-wrap break-words bg-foreground/[0.04] rounded-lg p-2 max-h-64 overflow-auto custom-scrollbar">
                {shown}
              </pre>
              {truncated && (
                <div className="mt-1 text-[9px] text-muted-foreground/50">
                  {t("chat.workPanel.truncated", { total: lines.length, shown: MAX_DETAIL_LINES })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});

export const WorkArtifacts = memo(function WorkArtifacts({ artifacts }: { artifacts: WorkArtifact[] }) {
  const { t } = useTranslation();
  // 阶段 G：3 种 kind 分组（file 含 diffOld 时用 DiffView；html 用 iframe 沙箱；terminal 走 pre）
  const files = artifacts.filter((a) => a.kind === "file");
  const htmls = artifacts.filter((a) => a.kind === "html");
  const terminals = artifacts.filter((a) => a.kind === "terminal");

  if (artifacts.length === 0) {
    return (
      <div className="glass rounded-2xl p-4 border border-white/5">
        <div className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50 mb-2">
          {t("chat.workPanel.artifacts")}
        </div>
        <div className="text-[11px] text-muted-foreground/40 text-center py-6 uppercase tracking-widest">
          {t("chat.workPanel.artifactsEmpty")}
        </div>
      </div>
    );
  }

  return (
    <div className="glass rounded-2xl p-4 border border-white/5 space-y-3">
      <div className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">
        {t("chat.workPanel.artifacts")}
      </div>
      {files.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/40">
            {t("chat.workPanel.files")}
          </div>
          {files.map((a) => (
            <ArtifactItem key={a.id} artifact={a} />
          ))}
        </div>
      )}
      {htmls.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/40">
            {t("chat.workPanel.htmls")}
          </div>
          {htmls.map((a) => (
            <ArtifactItem key={a.id} artifact={a} />
          ))}
        </div>
      )}
      {terminals.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/40">
            {t("chat.workPanel.terminals")}
          </div>
          {terminals.map((a) => (
            <ArtifactItem key={a.id} artifact={a} />
          ))}
        </div>
      )}
    </div>
  );
});
