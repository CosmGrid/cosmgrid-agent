// i18n 初始化（react-i18next + browser-languagedetector）
// 双语：zh-CN（默认） / en-US
// 持久化：localStorage key = "i18nextLng"（browser-languagedetector 内置）
//
// v0.7.5 关键修复：把 init 从模块顶层移到 initI18n() 函数，由 main.tsx 显式 await。
// 原因：模块顶层调 init() 会启动一个 init promise，main.tsx 立即 React render
// 时 init 还没就绪——t() 找不到 key。改成 main.tsx await init() 再 render。
//
// v0.7.4 修复：用 createInstance 不用默认单例（默认单例 + use plugins 组合下 t() 找不到 key）。
// v0.7.3 修复：i18next 26 期望嵌套 resources（不是平铺 dot-key）。
// v0.7.1 修复：Vite JSON 是 named exports，import * as 拿嵌套对象。

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { invoke } from "@tauri-apps/api/core";

import * as zhCNModule from "./locales/zh-CN.json";
import * as enUSModule from "./locales/en-US.json";

/** 从 Vite 命名空间对象去掉 `default` 字段（值是整个 JSON 重复），保留嵌套结构 */
function stripDefault(modules: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(modules)) {
    if (k === "default" || k === "__proto__") continue;
    out[k] = v;
  }
  return out;
}

const zhCNResources = stripDefault(zhCNModule as unknown as Record<string, unknown>);
const enUSResources = stripDefault(enUSModule as unknown as Record<string, unknown>);

// 用 createInstance 创建独立实例，不用 i18next 默认单例
const i18n = i18next.createInstance();

export const SUPPORTED_LANGUAGES = ["zh-CN", "en-US"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  "zh-CN": "简体中文",
  "en-US": "English",
};

/**
 * 初始化 i18n —— 必须在 React render 之前 await。
 * 调用方：main.tsx
 * ```
 * import { initI18n } from "./i18n";
 * await initI18n();
 * ReactDOM.createRoot(...).render(<App/>);
 * ```
 */
/** 把当前语言同步给 Rust，重建 macOS 原生菜单栏（File/Edit/Help/关于/退出…）。
 *  非 Tauri 环境（浏览器/测试）invoke 会 reject，静默忽略。 */
function syncNativeMenuLanguage(lang: string): void {
  void invoke("set_menu_language", { lang }).catch(() => {});
}

export async function initI18n(): Promise<void> {
  console.log(
    "[i18n] locale files loaded — zh-CN top-level:",
    Object.keys(zhCNResources).length,
    "en-US top-level:",
    Object.keys(enUSResources).length,
  );

  await i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources: {
        "zh-CN": { translation: zhCNResources },
        "en-US": { translation: enUSResources },
      },
      fallbackLng: "zh-CN",
      supportedLngs: [...SUPPORTED_LANGUAGES],
      // **关键修复**：不设 nonExplicitSupportedLngs
      // 实测：设了之后 LanguageDetector 检测到 "en-US" 时 i18n 严格按 en-US 查 resources，
      // 查不到 en-US 翻译时不 fallback 到 fallbackLng，直接返回 key 字符串。
      // 不设这个 option 时，找不到翻译会自动 fallback，行为符合预期。
      interpolation: {
        escapeValue: false,
      },
      detection: {
        order: ["localStorage", "navigator"],
        lookupLocalStorage: "i18nextLng",
        caches: ["localStorage"],
      },
      // react-i18next v17 默认开 React Suspense——在 tauri dev / SSR 下不工作
      // （永远 fallback），t() 直接返回 key 字符串。关掉走 legacy 模式。
      react: { useSuspense: false },
    });

  // 原生菜单栏跟随 app 语言：启动按当前语言设一次，之后每次切语言自动重建。
  syncNativeMenuLanguage(i18n.language);
  i18n.on("languageChanged", syncNativeMenuLanguage);

  console.log(
    "[i18n] init OK. language:",
    i18n.language,
    "t(app.brandSubtitle) =",
    JSON.stringify(i18n.t("app.brandSubtitle")),
    "t(templates.title) =",
    JSON.stringify(i18n.t("templates.title")),
  );
}
