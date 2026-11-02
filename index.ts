import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  getPackageDir,
  ModelSelectorComponent,
  parseArgs,
  ProjectTrustStore,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
  withFileMutationQueue,
  type ExtensionAPI,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

type Model = Parameters<ExtensionAPI["setModel"]>[0];

const lockfile = createRequire(join(getPackageDir(), "package.json"))("proper-lockfile");

function readSettings(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const settings = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return settings;
}

function hasModelSetting(settings: Record<string, unknown>): boolean {
  return Boolean(settings.defaultProvider || settings.defaultModel || settings.defaultThinkingLevel);
}

function nearestAncestorModelSettings(cwd: string): string | undefined {
  if (cwd === homedir()) return undefined;
  for (let dir = dirname(cwd); ; dir = dirname(dir)) {
    const file = join(dir, ".pi", "settings.json");
    if (existsSync(file)) {
      try {
        if (hasModelSetting(readSettings(file))) return file;
      } catch {
        // An invalid ancestor is not a save target; keep looking or save locally.
      }
    }
    if (dir === homedir() || dir === dirname(dir)) return undefined;
  }
}

function rejectLinkedSettings(file: string): void {
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Refusing to replace symlinked settings: ${file}`);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (!ctx.isProjectTrusted() || (event.reason !== "startup" && event.reason !== "new")) return;
    // Preserve resumed sessions and explicit CLI model choices. New sessions have only Pi's initial model/thinking entries.
    const branch = ctx.sessionManager.getBranch();
    const cli = parseArgs(process.argv.slice(2));
    if (branch.some((entry) => entry.type !== "model_change" && entry.type !== "thinking_level_change") ||
        branch.filter((entry) => entry.type === "model_change").length > 1 || cli.model) return;
    try {
      if (hasModelSetting(readSettings(join(ctx.cwd, ".pi", "settings.json")))) return;
      const file = nearestAncestorModelSettings(ctx.cwd);
      if (!file) return;
      const ancestor = dirname(dirname(file));
      const trust = new ProjectTrustStore(getAgentDir());
      if (trust.get(ctx.cwd) === false) return;
      if (trust.get(ancestor) !== true) {
        ctx.ui.notify(`Trust the ancestor directory ${ancestor} with /trust before loading its model.`, "warning");
        return;
      }
      if (lstatSync(file).isSymbolicLink()) throw new Error(`Refusing to load symlinked ancestor settings: ${file}`);
      const { defaultProvider, defaultModel } = readSettings(file);
      if (typeof defaultProvider !== "string" || typeof defaultModel !== "string") return;
      if (ctx.model?.provider === defaultProvider && ctx.model.id === defaultModel) return;
      const model = ctx.modelRegistry.find(defaultProvider, defaultModel);
      const scoped = ctx.scopedModels.find(({ model: candidate }) => candidate.provider === defaultProvider && candidate.id === defaultModel);
      if (!model || (ctx.scopedModels.length && !scoped) || !(await pi.setModel(model))) {
        ctx.ui.notify(`Could not load ancestor model ${defaultProvider}/${defaultModel} from ${file}`, "warning");
      } else {
        const thinking = cli.thinking ?? scoped?.thinkingLevel;
        if (thinking !== undefined) pi.setThinkingLevel(thinking);
      }
    } catch (error) {
      ctx.ui.notify(`Could not load ancestor model: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });

  pi.registerCommand("model-project", {
    description: "Select and save the model for this project using Pi's model picker",
    handler: async (args, ctx) => {
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Trust this project before saving .pi/settings.json.", "error");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/model-project requires Pi's interactive terminal.", "error");
        return;
      }
      const localFile = join(ctx.cwd, ".pi", "settings.json");
      let switched = false;
      try {
        const settings = readSettings(localFile);
        const registry = ctx.modelRegistry;
        // Pi 1.2's exported picker needs these four runtime methods, not the full registry.
        const runtime = {
          getAvailableSnapshot: () => registry.getAvailable(),
          getModel: (provider: string, id: string) => registry.find(provider, id),
          getError: () => registry.getError(),
          refresh: (options) => registry.refresh(options),
        } satisfies Pick<ModelRuntime, "getAvailableSnapshot" | "getModel" | "getError" | "refresh">;
        const model = await ctx.ui.custom<Model | undefined>((tui, _theme, _kb, done) =>
          new ModelSelectorComponent(
            tui, ctx.model, runtime as unknown as ModelRuntime, ctx.scopedModels,
            done, () => done(undefined), args.trim() || undefined, undefined,
            typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string"
              ? { provider: settings.defaultProvider, id: settings.defaultModel }
              : undefined,
          ),
        );
        if (!model) return;
        if (!ctx.isProjectTrusted()) throw new Error("Project is no longer trusted");
        const current = readSettings(localFile);
        const parentFile = !hasModelSetting(current) ? nearestAncestorModelSettings(ctx.cwd) : undefined;
        let file = localFile;
        if (parentFile) {
          const localChoice = `Save locally: ${localFile}`;
          const parentChoice = `Save to ancestor (shared): ${parentFile}`;
          const choice = await ctx.ui.select(
            "Parent model settings found. Where should this default be saved?\nAncestor loading in subfolders requires trusting the chosen ancestor with /trust.",
            [localChoice, parentChoice, "Cancel"],
          );
          if (choice === parentChoice) file = parentFile;
          else if (choice !== localChoice) return;
        }
        if (!ctx.isProjectTrusted()) throw new Error("Project is no longer trusted");
        const beforeSwitch = readSettings(file);
        rejectLinkedSettings(file);
        const globalSettings = SettingsManager.create(ctx.cwd, getAgentDir()).getGlobalSettings();
        for (const settingsToCheck of file === localFile ? [beforeSwitch] : [readSettings(localFile), beforeSwitch]) {
          const patterns = settingsToCheck.enabledModels === undefined ? globalSettings.enabledModels : settingsToCheck.enabledModels;
          if (patterns !== undefined) {
            if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string")) {
              throw new Error("enabledModels must be an array of strings");
            }
            const scopeRuntime = { getAvailable: async () => registry.getAvailable() };
            const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, scopeRuntime as unknown as ModelRuntime);
            if (scopedModels.length && !scopedModels.some((s) => s.model.provider === model.provider && s.model.id === model.id)) {
              throw new Error(`${model.provider}/${model.id} is outside enabledModels; change that setting before saving this default`);
            }
          }
        }
        if (!(await pi.setModel(model))) throw new Error(`Could not switch to ${model.provider}/${model.id}`);
        switched = true;
        await withFileMutationQueue(file, async () => {
          if (!ctx.isProjectTrusted()) throw new Error("Project is no longer trusted");
          mkdirSync(dirname(file), { recursive: true });
          // Match Pi's settings lock; no await while holding it, so native writers cannot interleave.
          const release = lockfile.lockSync(file, { realpath: false });
          try {
            rejectLinkedSettings(file);
            const latest = readSettings(file);
            if (JSON.stringify(latest.enabledModels) !== JSON.stringify(beforeSwitch.enabledModels)) {
              throw new Error("enabledModels changed while switching; run /model-project again");
            }
            latest.defaultProvider = model.provider;
            latest.defaultModel = model.id;
            const temp = mkdtempSync(join(dirname(file), ".model-project-"));
            try {
              const staged = join(temp, "settings.json");
              writeFileSync(staged, `${JSON.stringify(latest, null, 2)}\n`, { mode: 0o600 });
              renameSync(staged, file);
            } finally {
              rmSync(temp, { recursive: true, force: true });
            }
          } finally {
            release();
          }
        });
        ctx.ui.notify(`Project default: ${model.provider}/${model.id}\nSaved to ${file}`, "info");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`${switched ? "Session switched, but project default was not saved" : "Project model unchanged"}: ${detail}`, "error");
      }
    },
  });
}
