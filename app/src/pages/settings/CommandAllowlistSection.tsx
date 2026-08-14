// 引擎化改造方案 §6 阶段 1a — 命令白名单设置区段
//
// 全局 scope 的"额外允许命令"UI + 重置按钮 + K10 二次确认。
//
// 设计要点：
//   - 列出当前全局候选程序（每行一个程序名）；未分类程序仍会被安全策略拒绝。
//   - 保存：先弹 K10 二次确认（参考 VSCode security settings 高风险变更二级弹窗），
//     确认后才写入 policyStore + audit。
//   - 重置：弹二次确认 → 调 policyStore.reset(global scope) → K3 cascade 清所有项目级 override。
//     （用户主动"重置为默认"是合理的破坏性动作，但仍要求二次确认避免误点。）
//   - 错误/加载状态用纯文案 + spinner，不引第三方 UI（保持轻）。
//   - 不写"项目级 override" UI：项目级通过 ProjectDetailPage 走专门的 blocked_commands 流程;
//     1a 阶段重点是"全局一处，用户可改"。

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal, Loader2, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  commandAllowlistGlobalScope,
  commandAllowlistPolicy,
  invalidateAllowlistResolveCache,
  parseAllowedProgramsOverride,
  serializeAllowedProgramsOverride,
} from "@/lib/policy/command-allowlist";
import { policyStore, PolicyStoreError } from "@/lib/policy/policy-store";

const COMMAND_ALLOWLIST_BUILTIN_VERSION = commandAllowlistPolicy.builtinVersion;

interface ConfirmState {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
}

export function CommandAllowlistSection() {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  // 拉取全局 override → 用 draft 渲染
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await policyStore.get(
          commandAllowlistPolicy.key,
          commandAllowlistGlobalScope(),
        );
        if (cancelled) return;
        if (raw) {
          try {
            const arr = parseAllowedProgramsOverride(raw);
            setDraft(arr.join("\n"));
          } catch {
            setDraft("");
            setMessage({ kind: "err", text: t("settings.security.commandAllowlist.parseError") });
          }
        } else {
          setDraft("");
        }
      } catch (err) {
        if (!cancelled) {
          setMessage({
            kind: "err",
            text: t("settings.security.commandAllowlist.loadError", {
              msg: err instanceof Error ? err.message : String(err),
            }),
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  // 把 textarea 文本解析成 string[]（去空行、去重、保留原序）
  const parsed = useMemo<string[]>(() => {
    const lines = draft
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // 去重但保留首次出现的顺序
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const l of lines) if (!seen.has(l)) {
      seen.add(l);
      unique.push(l);
    }
    return unique;
  }, [draft]);

  async function onSave() {
    setMessage(null);
    try {
      setSaving(true);
      await policyStore.set(
        commandAllowlistPolicy.key,
        commandAllowlistGlobalScope(),
        serializeAllowedProgramsOverride(parsed),
        "settings:commandAllowlist",
        // review T-F-7（2026-07-13）：必须把 policy 的 builtin_version 一起落库，
        // §5.4 versioning banner 才有依据判断"用户的 override 是按哪个 builtin 时代并入"。
        COMMAND_ALLOWLIST_BUILTIN_VERSION,
      );
      // 写入候选名单后必须失效 resolve 缓存，否则 bash 工具会继续使用旧的候选集合。
      invalidateAllowlistResolveCache();
      setMessage({ kind: "ok", text: t("settings.security.commandAllowlist.saved") });
    } catch (err) {
      const msg =
        err instanceof PolicyStoreError
          ? err.code
          : err instanceof Error
            ? err.message
            : String(err);
      setMessage({ kind: "err", text: t("settings.security.commandAllowlist.saveError", { msg }) });
    } finally {
      setSaving(false);
    }
  }

  async function onReset() {
    setMessage(null);
    try {
      setResetting(true);
      await policyStore.reset(
        commandAllowlistPolicy.key,
        commandAllowlistGlobalScope(),
        "settings:commandAllowlist:reset",
      );
      // 同 onSave：重置清空 override 后也要失效缓存，否则已缓存的合并结果仍含旧 override。
      invalidateAllowlistResolveCache();
      setDraft("");
      setMessage({ kind: "ok", text: t("settings.security.commandAllowlist.resetSuccess") });
    } catch (err) {
      const msg =
        err instanceof PolicyStoreError
          ? err.code
          : err instanceof Error
            ? err.message
            : String(err);
      setMessage({
        kind: "err",
        text: t("settings.security.commandAllowlist.resetError", { msg }),
      });
    } finally {
      setResetting(false);
    }
  }

  function askSaveConfirm() {
    if (parsed.length === 0) {
      setMessage({
        kind: "err",
        text: t("settings.security.commandAllowlist.emptyList"),
      });
      return;
    }
    setConfirm({
      title: t("settings.security.commandAllowlist.editConfirmTitle"),
      body: t("settings.security.commandAllowlist.editConfirmBody", {
        programs: parsed.join(", "),
      }),
      confirmLabel: t("settings.security.commandAllowlist.editConfirmButton"),
      onConfirm: async () => {
        await onSave();
        setConfirm(null);
      },
    });
  }

  function askResetConfirm() {
    setConfirm({
      title: t("settings.security.commandAllowlist.resetConfirmTitle"),
      body: t("settings.security.commandAllowlist.resetConfirmBody"),
      confirmLabel: t("settings.security.commandAllowlist.resetConfirmButton"),
      onConfirm: async () => {
        await onReset();
        setConfirm(null);
      },
    });
  }

  return (
    <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 space-y-8 shadow-xl">
      <div className="flex items-center gap-3 pb-4 border-b border-white/10">
        <Terminal className="w-5 h-5 text-emerald-500" />
        <h2 className="text-xl font-bold dark:text-white">
          {t("settings.security.commandAllowlist.title")}
        </h2>
      </div>

      <div className="space-y-4">
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t("settings.security.commandAllowlist.desc")}
        </p>

        <div className="space-y-2">
          <Label htmlFor="command-allowlist-input">
            {t("settings.security.commandAllowlist.inputLabel")}
          </Label>
          <textarea
            id="command-allowlist-input"
            value={loading ? "" : draft}
            disabled={loading || saving || resetting}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("settings.security.commandAllowlist.inputPlaceholder")}
            rows={5}
            className="w-full rounded-xl border border-white/10 bg-white/5 dark:bg-black/20 p-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500/40 disabled:opacity-50"
          />
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{t("settings.security.commandAllowlist.builtinNote")}</span>
            <span className="opacity-50">·</span>
            <span>{t("settings.security.commandAllowlist.countNote", { count: parsed.length })}</span>
          </div>
        </div>

        {message && (
          <div
            role="status"
            className={
              message.kind === "ok"
                ? "text-xs text-emerald-500 dark:text-emerald-400"
                : "text-xs text-rose-500 dark:text-rose-400"
            }
          >
            {message.text}
          </div>
        )}

        <div className="flex flex-wrap gap-3 pt-2">
          <Button
            variant="default"
            size="sm"
            onClick={askSaveConfirm}
            disabled={loading || saving || resetting}
            className="bg-emerald-500 hover:bg-emerald-600 text-white"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            {t("settings.security.commandAllowlist.save")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={askResetConfirm}
            disabled={loading || saving || resetting}
          >
            {resetting ? (
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
            ) : (
              <RotateCcw className="w-4 h-4 mr-2" />
            )}
            {t("settings.security.commandAllowlist.reset")}
          </Button>
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          cancelLabel={t("settings.security.commandAllowlist.cancel")}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </Card>
  );
}

// 简易确认弹窗（避免引第三方 modal 库 + 避免新建全局 UI 组件污染 working tree）
function ConfirmDialog(props: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState(false);
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <div className="bg-white dark:bg-zinc-900 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4 border border-white/10">
        <h3 className="text-lg font-bold dark:text-white">{props.title}</h3>
        <p className="text-sm text-muted-foreground whitespace-pre-wrap break-all">{props.body}</p>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={props.onCancel} disabled={pending}>
            {props.cancelLabel}
          </Button>
          <Button
            size="sm"
            className="bg-rose-500 hover:bg-rose-600 text-white"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              try {
                await props.onConfirm();
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
            {props.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
