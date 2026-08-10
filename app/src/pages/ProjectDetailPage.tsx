// ProjectDetailPage - 重构为 "Cosmic Cyber" 视觉风格
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Cpu,
  Loader2,
  MessageSquare,
  Plus,
  Trash2,
  XCircle,
  Terminal,
  ShieldCheck,
  ShieldAlert,
  BrainCircuit,
  Workflow
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  projects as dbProjects,
  workspaceConfigs as dbWorkspaceConfigs,
  projectStages as dbStages,
  projectTemplateRoles as dbTemplateRoles,
  checkpoints as dbCheckpoints,
  handoffPackets as dbHandoffs,
  conversations as dbConversations,
  models as dbModels,
  apiCredentials as dbCredentials,
  type Project,
  type ProjectStage,
  type ProjectTemplateRole,
  type Checkpoint,
  type HandoffPacket,
  type Model,
  type ApiCredential,
  projectMemories as dbMemories,
  memoryKindLabel,
  type ProjectMemory,
} from "@/lib/db";
import { getApiKey } from "@/lib/keystore";
import { searchAcrossProjectsHybrid } from "@/lib/memory/retrieval";
import { CreateCheckpointDialog, CheckpointDetailDialog } from "@/components/project-detail/CheckpointDialogs";
import { GenerateHandoffDialog, HandoffDetailDialog } from "@/components/project-detail/HandoffDialogs";
import { AddMemoryDialog } from "@/components/project-detail/MemoryDialogs";
import { formatTime, roleLabel } from "@/components/project-detail/project-detail-utils";
import { StageChat } from "@/pages/project-detail/StageChat";
import cosmgridLogo from "@/assets/cosmgrid-logo.svg";

// ============ 静态映射 ============

const STAGE_STATUS_COLOR: Record<string, { color: string; bg: string }> = {
  pending: { color: "text-muted-foreground", bg: "bg-muted/10" },
  running: { color: "text-primary", bg: "bg-primary/10" },
  active: { color: "text-primary", bg: "bg-primary/10" },
  completed: { color: "text-emerald-400", bg: "bg-emerald-400/10" },
  failed: { color: "text-red-400", bg: "bg-red-400/10" },
  interrupted: { color: "text-amber-400", bg: "bg-amber-400/10" },
};

function stageStatusLabel(status: string, t: (k: string) => string): string {
  const key = ["ready", "running", "active", "completed", "failed", "interrupted", "pending"].includes(status) ? status : "pending";
  return t(`projectDetail.stageStatus.${key}`);
}

const PROJECT_STATUS_COLOR: Record<string, { color: string; bg: string }> = {
  pending: { color: "text-blue-400", bg: "bg-blue-400/10" },
  active: { color: "text-emerald-400", bg: "bg-emerald-400/10" },
  paused: { color: "text-amber-400", bg: "bg-amber-400/10" },
  completed: { color: "text-indigo-400", bg: "bg-indigo-400/10" },
  failed: { color: "text-red-400", bg: "bg-red-400/10" },
};

function projectStatusLabel(status: string, t: (k: string) => string): string {
  const key = ["pending", "active", "paused", "completed", "failed"].includes(status) ? status : "pending";
  return t(`projectDetail.projectStatus.${key}`);
}

function formatCost(v: number): string {
  return `¥${v.toFixed(4)}`;
}

// ============ 项目详情页主组件 ============

export interface ProjectDetailPageProps {
  projectId: string;
  onBack: () => void;
}

export function ProjectDetailPage({ projectId, onBack }: ProjectDetailPageProps) {
  const { t } = useTranslation();
  const { confirm } = useConfirm();
  const [project, setProject] = useState<Project | null>(null);
  const [stages, setStages] = useState<ProjectStage[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [credentials, setCredentials] = useState<ApiCredential[]>([]);
  const [templateRoles, setTemplateRoles] = useState<ProjectTemplateRole[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [, setHandoffs] = useState<HandoffPacket[]>([]);
  const [memories, setMemories] = useState<ProjectMemory[]>([]);
  const [openStageId, setOpenStageId] = useState<string | null>(null);
  const [createCpOpen, setCreateCpOpen] = useState(false);
  const [viewCp, setViewCp] = useState<Checkpoint | null>(null);
  const [genCp, setGenCp] = useState<Checkpoint | null>(null);
  const [viewHandoff, setViewHandoff] = useState<HandoffPacket | null>(null);
  const [addMemoryOpen, setAddMemoryOpen] = useState(false);
  const [relatedMemories, setRelatedMemories] = useState<ProjectMemory[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // v0.7 阶段4b：项目级命令黑名单（换行/逗号分隔）
  const [blockedInput, setBlockedInput] = useState("");
  const [blockedSaved, setBlockedSaved] = useState(false);

  async function load() {
    try {
      const [p, s, m, c, cp, hf, mem, blocked] = await Promise.all([
        dbProjects.getById(projectId),
        dbStages.listByProject(projectId),
        dbModels.listEnabled(),
        dbCredentials.list(),
        dbCheckpoints.listByProject(projectId),
        dbHandoffs.listByProject(projectId),
        dbMemories.listByProject(projectId),
        dbWorkspaceConfigs.getBlockedCommands(projectId),
      ]);
      if (!p) { setLoadError(t("projectDetail.notFound")); return; }
      setProject(p); setStages(s); setModels(m); setCredentials(c); setCheckpoints(cp); setHandoffs(hf); setMemories(mem);
      setBlockedInput(blocked.join("\n"));
      if (p.templateId) setTemplateRoles(await dbTemplateRoles.listByTemplate(p.templateId));
      const query = [p.name, p.description].filter(Boolean).join(" ");
      if (query) {
        setRelatedMemories(await searchAcrossProjectsHybrid(query, {
          excludeProjectId: projectId,
          limit: 3,
          minImportance: 60,
          perProjectLimit: 1,
        }).catch(() => []));
      } else {
        setRelatedMemories([]);
      }
      setLoadError(null);
    } catch (err) { setLoadError(err instanceof Error ? err.message : t("projectDetail.loadError")); }
  }

  useEffect(() => { void load(); }, [projectId]);

  async function saveBlockedCommands() {
    const list = blockedInput.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    await dbWorkspaceConfigs.setBlockedCommands(projectId, list);
    setBlockedSaved(true);
    setTimeout(() => setBlockedSaved(false), 2000);
  }

  const modelMap = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);
  const credentialMap = useMemo(() => new Map(credentials.map((c) => [c.providerId, c])), [credentials]);

  async function startStage(stage: ProjectStage) {
    if (!project) return;
    await dbStages.update(stage.id, { status: "running" });
    await dbProjects.update(project.id, { currentStage: stage.workRole, status: "active" });
    await load(); setOpenStageId(stage.id);
  }

  async function completeStage(stage: ProjectStage) {
    await dbStages.update(stage.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    await load();
  }

  async function deleteCheckpoint(id: string) {
    if (!(await confirm({ description: t("projectDetail.deleteCheckpoint"), destructive: true }))) return;
    await dbCheckpoints.delete(id);
    await load();
  }

  async function deleteMemory(id: string) {
    if (!(await confirm({ description: t("projectDetail.deleteMemory"), destructive: true }))) return;
    await dbMemories.delete(id);
    await load();
  }

  const totalCost = stages.reduce((s, st) => s + st.cost, 0);
  const totalTokens = stages.reduce((s, st) => s + st.inputTokens + st.outputTokens, 0);

  if (loadError) return (
    <div className="p-8"><Alert variant="destructive" className="glass rounded-[2rem] border-red-500/30"><AlertDescription>{loadError}</AlertDescription></Alert></div>
  );

  if (!project) return <div className="h-full flex items-center justify-center animate-pulse"><Loader2 className="w-8 h-8 text-primary animate-spin" /></div>;

  const projectStatusKey = ["pending", "active", "paused", "completed", "failed"].includes(project.status) ? project.status : "pending";
  const projectStatus = {
    label: projectStatusLabel(projectStatusKey, t),
    ...(PROJECT_STATUS_COLOR[projectStatusKey] ?? PROJECT_STATUS_COLOR.pending!),
  };

  return (
    <div className="h-full w-full overflow-y-auto p-8 bg-background/30 backdrop-blur-sm custom-scrollbar">
      <div className="space-y-12 pb-20">
        {/* Header Section */}
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-8 animate-in fade-in slide-in-from-top-4 duration-700">
          <div className="space-y-4 flex-1">
            <Button variant="ghost" size="sm" onClick={onBack} className="-ml-3 rounded-xl hover:bg-white/10 text-muted-foreground">
              <ArrowLeft className="w-4 h-4 mr-2" /> {t("projectDetail.returnToHub")}
            </Button>
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <h1 className="text-4xl font-black tracking-tighter">{project.name}</h1>
                <div className={cn("px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-current/20", projectStatus.color, projectStatus.bg)}>
                  {projectStatus.label}
                </div>
              </div>
              <p className="text-muted-foreground text-sm font-medium opacity-60">{project.description || t("projectDetail.descFallback")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-6 pt-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-black text-muted-foreground/40 uppercase tracking-widest">{t("projectDetail.activeSequence")}</span>
                <span className="text-xs font-bold text-primary">{roleLabel(project.currentStage, t) || t("projectDetail.initialization")}</span>
              </div>
              <div className="w-px h-8 bg-white/5" />
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-black text-muted-foreground/40 uppercase tracking-widest">{t("projectDetail.accumulatedCost")}</span>
                <span className="text-xs font-bold font-mono text-emerald-400">{formatCost(totalCost)}</span>
              </div>
              <div className="w-px h-8 bg-white/5" />
              <div className="flex flex-col gap-0.5">
                <span className="text-[9px] font-black text-muted-foreground/40 uppercase tracking-widest">{t("projectDetail.neuralLoad")}</span>
                <span className="text-xs font-bold font-mono">{totalTokens.toLocaleString()} <span className="text-[9px] opacity-40">TKN</span></span>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="icon" className="h-12 w-12 rounded-2xl glass border-white/10 hover:bg-white/10">
              <ShieldCheck className="w-5 h-5" />
            </Button>
            {project.status !== "completed" && (
              <Button
                onClick={() => dbProjects.update(project.id, { status: "completed", currentStage: "completed" }).then(load)}
                className="h-12 px-6 rounded-2xl bg-primary shadow-xl shadow-primary/20 font-bold gap-2"
              >
                <CheckCircle2 className="w-4 h-4" /> {t("projectDetail.deployFinish")}
              </Button>
            )}
          </div>
        </header>

        {/* 核心工作流板块 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* 左侧：时间线 (Span 2) */}
          <div className="lg:col-span-2 space-y-6">
            <div className="flex items-center justify-between px-2">
              <h2 className="text-xs font-black uppercase tracking-[0.3em] text-muted-foreground/40 flex items-center gap-2">
                <Workflow className="w-4 h-4" /> {t("projectDetail.operationalTimeline")}
              </h2>
            </div>
            <div className="space-y-4">
              {stages.map((st, idx) => {
                const m = modelMap.get(st.modelId);
                const isOpen = openStageId === st.id;
                const cred = m ? credentialMap.get(m.providerId) : undefined;
                const stageKey = ["pending", "running", "active", "completed", "failed", "interrupted"].includes(st.status) ? st.status : "pending";
                const status = {
                  label: stageStatusLabel(stageKey, t),
                  ...(STAGE_STATUS_COLOR[stageKey] ?? STAGE_STATUS_COLOR.pending!),
                };
                const isRunning = st.status === "running" || st.status === "active";

                return (
                  <Card key={st.id} className={cn(
                    "group glass border-white/5 rounded-[2rem] overflow-hidden transition-all duration-500",
                    isOpen ? "border-primary/40 shadow-2xl shadow-primary/5 ring-1 ring-primary/20" : "hover:border-white/20 shadow-sm"
                  )}>
                    <div className="p-6 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-5 min-w-0">
                        <div className={cn(
                          "w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-500",
                          isRunning ? "bg-primary shadow-[0_0_20px_rgba(var(--primary),0.3)]" : "bg-white/5 border border-white/5"
                        )}>
                          {st.status === "completed" ? <CheckCircle2 className="w-6 h-6 text-emerald-400" /> :
                           isRunning ? <div className="relative"><img src={cosmgridLogo} className="w-6 h-6 invert brightness-0" /><div className="absolute inset-0 border-2 border-white rounded-full animate-ping opacity-20" /></div> :
                           <div className="text-[10px] font-black text-muted-foreground/30">0{idx+1}</div>}
                        </div>
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <h3 className="text-lg font-bold tracking-tight">{roleLabel(st.workRole, t) || st.workRole}</h3>
                            <div className={cn("px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-tighter border border-current/20", status.color, status.bg)}>
                              {status.label}
                            </div>
                          </div>
                          <div className="flex items-center gap-3 text-[10px] font-bold text-muted-foreground/40 uppercase tracking-widest">
                            <span className="flex items-center gap-1"><Cpu className="w-3 h-3" /> {m?.displayName || t("projectDetail.systemModel")}</span>
                            <span>•</span>
                            <span className="flex items-center gap-1"><Terminal className="w-3 h-3" /> {st.outputTokens} tkn</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {st.status === "pending" ? (
                          <Button onClick={() => startStage(st)} className="rounded-xl h-10 px-5 bg-primary/20 hover:bg-primary text-primary hover:text-primary-foreground transition-all font-bold text-xs uppercase">
                            {t("projectDetail.startSequence")}
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setOpenStageId(isOpen ? null : st.id)}
                            className={cn("h-10 px-4 rounded-xl gap-2 font-bold text-xs uppercase", isOpen ? "bg-primary text-primary-foreground" : "hover:bg-white/10")}
                          >
                            <MessageSquare className="w-4 h-4" />
                            {isOpen ? t("projectDetail.closeLogs") : t("projectDetail.viewDialog")}
                          </Button>
                        )}
                        {isRunning && (
                          <Button size="icon" onClick={() => completeStage(st)} className="h-10 w-10 rounded-xl bg-emerald-500/20 text-emerald-500 hover:bg-emerald-500 hover:text-white transition-all">
                            <CheckCircle2 className="w-5 h-5" />
                          </Button>
                        )}
                      </div>
                    </div>
                    {isOpen && m && cred && (
                      <StageConversationLoader
                        stage={st} model={m} credential={cred} models={models} credentials={credentials} templateRoles={templateRoles}
                      />
                    )}
                  </Card>
                );
              })}
            </div>
          </div>

          {/* 右侧：检查点与记忆 (Span 1) */}
          <div className="space-y-10">
            {/* 检查点板块 */}
            <div className="space-y-4">
               <div className="flex items-center justify-between px-2">
                  <h2 className="text-xs font-black uppercase tracking-[0.3em] text-muted-foreground/40 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4" /> {t("projectDetail.coreCheckpoints")}
                  </h2>
                  <Button size="sm" variant="ghost" onClick={() => setCreateCpOpen(true)} className="h-7 w-7 p-0 rounded-lg bg-primary/10 text-primary hover:bg-primary hover:text-white">
                    <Plus className="w-4 h-4" />
                  </Button>
               </div>
               <div className="space-y-3">
                  {checkpoints.length === 0 ? (
                    <div className="glass border-dashed rounded-[2rem] p-8 text-center opacity-30">
                       <p className="text-[10px] font-black uppercase tracking-widest">{t("projectDetail.noRecords")}</p>
                    </div>
                  ) : checkpoints.map(cp => (
                    <Card key={cp.id} className="glass border-white/5 rounded-[1.5rem] p-5 space-y-4 hover:border-primary/30 transition-all">
                       <div className="flex justify-between items-start">
                          <h4 className="text-sm font-bold leading-tight line-clamp-2">{cp.title}</h4>
                          <button onClick={() => void deleteCheckpoint(cp.id)} className="text-muted-foreground/30 hover:text-red-500 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                       </div>
                       <div className="flex items-center gap-2 text-[9px] font-bold text-muted-foreground/40 uppercase tracking-tighter">
                          <Clock className="w-3 h-3" /> {formatTime(cp.createdAt)}
                       </div>
                       <div className="flex gap-2">
                          <Button variant="outline" size="sm" onClick={() => setViewCp(cp)} className="flex-1 h-8 rounded-lg text-[10px] uppercase font-bold border-white/10 hover:bg-white/5">{t("projectDetail.details")}</Button>
                          <Button size="sm" onClick={() => setGenCp(cp)} className="flex-1 h-8 rounded-lg text-[10px] uppercase font-bold bg-primary shadow-lg shadow-primary/10">{t("projectDetail.handoff")}</Button>
                       </div>
                    </Card>
                  ))}
               </div>
            </div>

            {/* 记忆板块 */}
            <div className="space-y-4">
               <div className="flex items-center justify-between px-2">
                  <h2 className="text-xs font-black uppercase tracking-[0.3em] text-muted-foreground/40 flex items-center gap-2">
                    <BrainCircuit className="w-4 h-4" /> {t("projectDetail.neuralMemory")}
                  </h2>
                  <Button size="sm" variant="ghost" onClick={() => setAddMemoryOpen(true)} className="h-7 w-7 p-0 rounded-lg bg-accent/10 text-accent hover:bg-accent hover:text-white">
                    <Plus className="w-4 h-4" />
                  </Button>
               </div>
               <div className="space-y-3">
                  {memories.length === 0 ? (
                    <div className="glass border-dashed rounded-[2rem] p-8 text-center opacity-30">
                       <p className="text-[10px] font-black uppercase tracking-widest">{t("projectDetail.emptyBuffer")}</p>
                    </div>
                  ) : memories.map(m => (
                    <Card key={m.id} className="glass border-white/5 rounded-[1.5rem] p-5 space-y-2 group transition-all">
                       <div className="flex items-center justify-between">
                          <div className={cn("px-2 py-0.5 rounded text-[8px] font-black uppercase",
                            m.kind === 'decision' ? 'bg-indigo-500/10 text-indigo-400' : 'bg-accent/10 text-accent'
                          )}>
                             {memoryKindLabel(m.kind, t)}
                          </div>
                          <button onClick={() => void deleteMemory(m.id)} className="opacity-0 group-hover:opacity-100 transition-opacity">
                            <XCircle className="w-3 h-3 text-red-500/50 hover:text-red-500" />
                          </button>
                       </div>
                       <h4 className="text-sm font-bold">{m.title}</h4>
                       <p className="text-[11px] text-muted-foreground/70 line-clamp-3 leading-relaxed">{m.content}</p>
                    </Card>
                  ))}
               </div>
               {relatedMemories.length > 0 && (
                 <div className="space-y-3 pt-2">
                   <div className="flex items-center justify-between px-1">
                     <h3 className="text-[10px] font-black uppercase tracking-[0.25em] text-muted-foreground/45 flex items-center gap-2">
                       <Workflow className="w-3.5 h-3.5" /> {t("projectDetail.relatedMemories.title")}
                     </h3>
                     <span className="text-[9px] text-muted-foreground/45">{t("projectDetail.relatedMemories.hint")}</span>
                   </div>
                   {relatedMemories.map((m) => (
                     <Card key={`related-${m.id}`} className="border border-white/8 bg-white/[0.03] rounded-[1.25rem] p-4 space-y-2">
                       <div className="flex items-center justify-between gap-3">
                         <div className={cn("px-2 py-0.5 rounded text-[8px] font-black uppercase",
                           m.kind === "decision" ? "bg-indigo-500/10 text-indigo-400" : "bg-accent/10 text-accent"
                         )}>
                           {memoryKindLabel(m.kind, t)}
                         </div>
                         <div className="text-[9px] font-bold text-amber-300/80">
                           {t("projectDetail.relatedMemories.fromProject", { name: m.projectName || t("projectDetail.relatedMemories.unknownProject") })}
                         </div>
                       </div>
                       <h4 className="text-sm font-bold">{m.title}</h4>
                       <p className="text-[11px] text-muted-foreground/70 line-clamp-3 leading-relaxed">{m.content}</p>
                     </Card>
                   ))}
                 </div>
               )}
            </div>
          </div>
        </div>

        {/* v0.7 阶段4b：项目工具安全 — 自定义命令黑名单 */}
        {project.workspacePath && (
          <Card className="glass border-white/15 dark:border-white/5 rounded-[2rem] p-8 space-y-4 shadow-xl">
            <div className="flex items-center gap-3 pb-2 border-b border-white/10">
              <ShieldAlert className="w-5 h-5 text-amber-500" />
              <h2 className="text-lg font-bold dark:text-white">{t("projectDetail.tools.safetyTitle")}</h2>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">{t("projectDetail.tools.safetyDesc")}</p>
            <textarea
              value={blockedInput}
              onChange={(e) => setBlockedInput(e.target.value)}
              placeholder={t("projectDetail.tools.blockedPlaceholder")}
              className="w-full bg-white/5 dark:bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-xs font-mono outline-none focus:border-amber-500/40 resize-none h-24 dark:text-white"
            />
            <div className="flex items-center gap-3">
              <Button size="sm" variant="outline" className="rounded-xl" onClick={() => void saveBlockedCommands()}>
                {t("projectDetail.tools.save")}
              </Button>
              {blockedSaved && <span className="text-xs font-bold text-emerald-500">{t("projectDetail.tools.saved")}</span>}
            </div>
          </Card>
        )}
      </div>

      {/* 对话框挂载 (使用同样的 Cosmic 风格重写对话框内容) */}
      <CreateCheckpointDialog
        open={createCpOpen} onOpenChange={setCreateCpOpen} projectId={projectId} stages={stages} models={models} credentials={credentials} onCreated={load}
      />
      <CheckpointDetailDialog checkpoint={viewCp} open={viewCp !== null} onOpenChange={(v) => !v && setViewCp(null)} />
      <GenerateHandoffDialog open={genCp !== null} onOpenChange={(v) => !v && setGenCp(null)} checkpoint={genCp} onCreated={load} />
      <HandoffDetailDialog packet={viewHandoff} open={viewHandoff !== null} onOpenChange={(v) => !v && setViewHandoff(null)} />
      <AddMemoryDialog open={addMemoryOpen} onOpenChange={setAddMemoryOpen} projectId={projectId} onCreated={load} />
    </div>
  );
}

// ============ 子组件：对话框与加载器 (保持原有逻辑，注入视觉类名) ============

function StageConversationLoader({ stage, model, credential, models, credentials, templateRoles }: any) {
  const { t } = useTranslation();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [fallback, setFallback] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const convs = await dbConversations.list();
        const title = `${stage.projectId}:${stage.id}`;
        let conv = convs.find((c) => c.projectId === stage.projectId && c.title === title);
        if (!conv) conv = await dbConversations.create({ title, defaultModelId: stage.modelId, projectId: stage.projectId });
        setConversationId(conv.id);
        const key = await getApiKey(credential.id);
        if (!key) { setError(t("projectDetail.chat.apiKeyMissing")); return; }
        setApiKey(key);
        const role = templateRoles.find((r: any) => r.workRole === stage.workRole);
        if (role?.fallbackModelId && role.fallbackModelId !== stage.modelId) {
          const fbModel = models.find((m: any) => m.id === role.fallbackModelId);
          if (fbModel) {
            const fbCred = credentials.find((c: any) => c.providerId === fbModel.providerId);
            if (fbCred) {
              const fbKey = await getApiKey(fbCred.id);
              if (fbKey) setFallback({ model: fbModel, credential: fbCred, apiKey: fbKey });
            }
          }
        }
      } catch (err) { setError(err instanceof Error ? err.message : t("projectDetail.chat.initFailed")); }
    })();
  }, [stage.id]);

  if (error) return <div className="p-4 text-xs font-bold text-red-500 bg-red-500/5">{error}</div>;
  if (!conversationId || !apiKey) return <div className="p-10 flex items-center justify-center gap-3"><Loader2 className="w-5 h-5 text-primary animate-spin" /><span className="text-xs font-black uppercase tracking-widest opacity-30">{t("projectDetail.chat.syncing")}</span></div>;

  return <StageChat stage={stage} model={model} credential={credential} apiKey={apiKey} conversationId={conversationId} fallback={fallback} />;
}
