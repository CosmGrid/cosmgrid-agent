export interface AppInitializationDependencies {
  initSchema: () => Promise<unknown>;
  seedBuiltInTemplates: () => Promise<unknown>;
  seedBuiltinSkills: () => Promise<unknown>;
  warn?: (error: unknown) => void;
}

export type AppInitializationResult =
  | { ok: true }
  | { ok: false; error: unknown };

export async function initializeApp(
  dependencies: AppInitializationDependencies,
): Promise<AppInitializationResult> {
  try {
    await dependencies.initSchema();
    await dependencies.seedBuiltInTemplates();
  } catch (error) {
    return { ok: false, error };
  }

  try {
    await dependencies.seedBuiltinSkills();
  } catch (error) {
    dependencies.warn?.(error);
  }

  return { ok: true };
}
