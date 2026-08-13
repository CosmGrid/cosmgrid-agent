// v0.9 阶段7 — 文本向量化（语义缓存检索用）
//
// 决策点②：transformers.js（all-mpnet-base-v2，110MB）在 Tauri WebView 兼容性未验证，
// 且体积大。先实现「零依赖关键词哈希 embedding」作默认 provider——语义缓存今天就能真跑；
// 接口留好（EmbeddingProvider），语义缓存继续默认走它，避免重复问题缓存变慢或额外花钱。
// 项目记忆的真实 embedding 已拆到 memory/embedding-provider.ts：可在设置页显式启用远程
// OpenAI / OpenAI-compatible embedding，并手动同步索引。
//
// 关键词哈希 embedding 原理：把文本切成 token（拉丁词 + CJK 单字 + CJK 二/三元组），
// 每个 token 哈希到固定维度的桶里累加，再 L2 归一化。同义改写共享 token → 余弦高；
// 无关文本 token 几乎不重叠 → 余弦低。质量不如神经 embedding，但确定性、离线、零成本。
//
// v0.9.1 改进：CJK 三元组 + 中文停用词过滤——把"只切到二元"升级为"1/2/3 元组 + 过滤"，
// 显著提升中文同义改写的命中率（不引依赖，保底方案）。

export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  /** true 表示可以在聊天检索时顺手补索引；远程 provider 默认不允许，避免热路径烧钱/卡顿。 */
  readonly supportsHotBackfill?: boolean;
  embed(text: string): Promise<number[]>;
}

const DEFAULT_DIM = 256;

/** 简单字符串哈希（FNV-1a 变体），返回非负整数 */
function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const LATIN_WORD = /[a-z0-9]+/g;
const CJK_CHAR = /[一-鿿]/g;

/**
 * 中文停用词（无实际语义、助词/虚词/极常见字）—— 不入 vec 桶，避免高频无意义 token
 * 稀释有信息量 token 的权重。保底方案刻意做得小且自维护，不引 jieba/nodejieba 等分词词典。
 */
const CJK_STOPWORDS: ReadonlySet<string> = new Set([
  "的", "了", "是", "在", "有", "和", "与", "或", "但", "也", "都", "就",
  "要", "会", "能", "可", "我", "你", "他", "她", "它", "们", "这", "那",
  "此", "其", "为", "以", "于", "从", "到", "上", "下", "中", "里", "把",
  "被", "让", "使", "给", "向", "由", "么", "呢", "啊", "吧", "哦", "嗯",
  "呀", "嘛", "哈", "哎", "唉", "之", "所", "并", "且", "而", "如", "若",
  "虽", "然", "则", "乃", "即", "或", "又", "再", "已", "曾", "将", "应",
]);

/** 把文本切成 token：拉丁词 + CJK 单字（去停用词）+ CJK 二/三元组（不过滤停用词） */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  const latin = lower.match(LATIN_WORD);
  if (latin) tokens.push(...latin);

  const cjk = lower.match(CJK_CHAR);
  if (cjk) {
    // CJK 单字：去停用词（"的/了/是/在..."这些虚词入 vec 会稀释实词权重）
    for (const ch of cjk) {
      if (!CJK_STOPWORDS.has(ch)) tokens.push(ch);
    }
    // CJK 二元组：捕捉"排序""函数""上下文"等词级语义。
    // **不过滤停用词**：CJK_STOPWORDS 只有单字，"上下文""上下班""中间件"这类含
    // 单字停用字（"上/下/中"）但整体有意义的 bigram 不能误删。当前实现刻意保留全部 bigram。
    for (let i = 0; i < cjk.length - 1; i++) {
      tokens.push((cjk[i] ?? "") + (cjk[i + 1] ?? ""));
    }
    // CJK 三元组：捕捉"快速排序""数据库索引"等更长词组
    for (let i = 0; i < cjk.length - 2; i++) {
      tokens.push((cjk[i] ?? "") + (cjk[i + 1] ?? "") + (cjk[i + 2] ?? ""));
    }
  }
  return tokens;
}

/** 关键词哈希 embedding：确定性、零依赖、离线 */
export function keywordEmbed(text: string, dim = DEFAULT_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = tokenize(text);
  for (const tok of tokens) {
    vec[hashToken(tok) % dim] += 1;
  }
  // L2 归一化（让余弦相似度只看方向）
  let norm = 0;
  for (const v of vec) norm += v * v;
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < dim; i++) vec[i]! *= inv;
  }
  return vec;
}

/** 默认 provider：关键词哈希 v2（v0.9.1 加入三元组 + 中文停用词过滤）。
 *  name 含 v2 后缀是为了让 semantic-cache lookup 区分新旧算法——vec 不兼容，混用会全 miss。
 *  语义缓存若日后换算法，name 再升级即可。 */
export const keywordEmbeddingProvider: EmbeddingProvider = {
  name: "keyword-hash-v2",
  dim: DEFAULT_DIM,
  supportsHotBackfill: true,
  embed: async (text: string) => keywordEmbed(text, DEFAULT_DIM),
};

const activeProvider: EmbeddingProvider = keywordEmbeddingProvider;

/** 取当前激活的 embedding provider */
export function getEmbeddingProvider(): EmbeddingProvider {
  return activeProvider;
}
