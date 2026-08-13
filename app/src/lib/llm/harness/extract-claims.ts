// Harness — 提取模型「声称读取过」的文件路径，用于路径级真实性校验。
//
// 修订（2026-06-25）：原版提取正文所有路径片段（/app、/think、/Cosmgrid-Agent 等），
// 误报严重——模型正文提到路径 ≠ 声称读了该文件。改为**语境提取**：只在
// 「读取/查看/读了/打开」等动词后抓**带扩展名的文件路径**。
// 漏报优先于误报——误报会让用户不信 Harness（狼来了），漏报只是没抓到编。
//
// 伪工具调用 JSON 里的路径（<run_command>{"command":"cat X"}</run_command>）不在这抓——
// 那由 detect-pseudo-tools 负责抓伪工具标签本身，路径 claim 只管"声明读取"。
//
// 修订（2026-07-05，真实事故）：模型说"OKX.AI 接单注册流程（反推自 agent-commerce.js
// 真实代码）"——纯靠 grep 出的关键词脑补出一整套没读过的内容，完全没被这里抓到。两个漏洞：
// ① 动词表没有"反推自/挖到/抓到"这类"逆向分析出"的说法，只认"读取了"这类直接动词；
// ② 路径正则要求至少一段"目录/"前缀，bare 文件名（没有目录前缀的"agent-commerce.js"）
//   永远不可能匹配——现实里模型提到文件名时经常不带目录。都已修。

// 动词 + 带扩展名的文件路径（目录前缀可选，末段必须带扩展名，排除 /app /think 这种无扩展词）
const CLAIM_RE =
  /(?:读取了|读取|读过|读了|查看了|查看过|查看|看过|看了|已读|阅读了|阅读|打开了|打开|加载了|载入了|反推自|反推出|挖到|挖出|抓到|抓取到|扒出|提取自|提取出|拆解出|分析出|(?:I\s+)?(?:read|loaded|opened|viewed|checked|reverse[- ]engineered|extracted\s+from)(?:\s+(?:file|the\s+file))?)\s*[`'"([]?\s*((?:[/A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8})/gi;

/**
 * 从 assistant 文本提取模型「声明读取过」的文件路径（语境提取，非所有路径）。
 * @returns 去重后的路径数组
 */
export function extractFilePaths(text: string): string[] {
  const cleaned = text.replace(/https?:\/\/[^\s"'<>)\]]+/gi, ""); // 先删 URL，避免误抓
  const found = new Set<string>();
  for (const m of cleaned.matchAll(CLAIM_RE)) {
    const p = m[1];
    if (p && !p.startsWith("//")) found.add(p);
  }
  return [...found];
}

// 修订（2026-07-07，真实事故）：上面 extractFilePaths 会先把 URL 整段删掉再抓路径——
// 这个设计对本地文件 claim 是对的（避免 URL 里的路径片段误报成文件），但代价是模型声称
// "抓取过某个网页"这类谎完全不在覆盖范围内：verify-claims 之前只比对 `read` 工具的记录，
// 跟 `web_fetch` 毫无关系。实测一个模型编了"我读到 GitHub 上 README/SKILL.md 说……"，
// 但那次它是靠 web_fetch 失败后硬编的——这个谎本该被抓，但结构上抓不到。
// 补一条同思路的 URL claim 提取：动词 + 紧跟着的 URL，才算"声称抓取过"，跟文件路径一样
// 语境提取、漏报优先于误报（模型没把 URL 写回正文时就漏检，不强行猜）。
const URL_CLAIM_RE =
  /(?:读取了|读取|读过|读到了|读到|读了|查看了|查看过|查看|看过|看了|已读|阅读了|阅读|打开了|打开|访问了|访问|抓取了|抓取到|抓到|拉到了|拉到|(?:I\s+)?(?:read|fetched|opened|visited|loaded)(?:\s+(?:the\s+)?(?:page|url|link))?)\s*[:：]?\s*[`'"([]?\s*(https?:\/\/[^\s"'<>)\]，。！？、]+)/gi;

/**
 * 从 assistant 文本提取模型「声明抓取过」的网页 URL（语境提取，跟 extractFilePaths 同一套思路）。
 * @returns 去重、去掉尾部标点后的 URL 数组
 */
export function extractUrlClaims(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(URL_CLAIM_RE)) {
    const u = m[1]?.replace(/[.,;:!?，。！？]+$/, "");
    if (u) found.add(u);
  }
  return [...found];
}

// 修订（2026-07-07，系统性排查）：`read`/`web_fetch` 补完之后，工具注册表里还有
// `grep`/`glob`/`bash`/`web_search`/`git_read` 五个工具完全没接入校验——不管换哪个模型，
// 只要编的是"我 grep 出来 X"、"我跑了 `pnpm test` 都过了"、"我搜了一下看到 Y"这类话，
// 现在结构上就抓不到，这才是"换什么模型都会编"的真正原因（不是模型问题，是覆盖面问题）。
//
// bash 命令、grep pattern、web_search 查询词跟文件路径/URL 不一样——没有扩展名/协议头
// 这种天然可识别的字符形状，随便一句话都可能"看起来像"命令。只有模型自己明确用反引号/
// 引号把它包起来时才算"声称"，裸词一律不抓（漏报优先于误报——见文件顶部原则）。
const QUOTED_CLAIM_RE =
  /(?:运行了|执行了|跑了|跑过|运行|执行|搜索了|搜了|查询了|查了|搜到了|搜到|(?:I\s+)?(?:ran|executed|run|searched|queried))\s*(?:一下)?\s*[:：]?\s*[`'"]([^`'"\n]{1,200})[`'"]/gi;

/**
 * 从 assistant 文本提取模型「声明运行/搜索过」的字面值（命令/pattern/查询词，反引号或引号
 * 包起来的才算，跟 extractFilePaths/extractUrlClaims 同一套语境提取思路）。
 * @returns 去重、去空白后的字面值数组
 */
export function extractQuotedClaims(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(QUOTED_CLAIM_RE)) {
    const v = m[1]?.trim();
    if (v) found.add(v);
  }
  return [...found];
}
