import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ModelSelectorComponent, ProjectTrustStore, SettingsManager, getPackageDir, initTheme } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";

initTheme("dark");
const root = await mkdtemp(join(tmpdir(), "pi-model-project-test-"));
const globalFile = join(root, "agent", "settings.json");
await mkdir(dirname(globalFile));
await writeFile(globalFile, '{"defaultProvider":"global","defaultModel":"untouched"}\n');
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dirname(globalFile);
after(async () => {
  try {
    assert.equal(await readFile(globalFile, "utf8"), '{"defaultProvider":"global","defaultModel":"untouched"}\n');
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
const models = ["deepseek", "proxy"].map((provider) => ({
  provider, id: "deepseek-chat", name: "DeepSeek", reasoning: false,
}));

async function fixture({ trusted = true, mode = "tui", switchOK = true, keys = ["\r"], settings, parentSettings, grandparentSettings, saveChoice = "local", beforeSelect, beforeStart, onSwitch, refreshPending = false, scopedModels = models.map((model) => ({ model })), start = false, reason = "startup", branch = [], ancestorTrust = true, childTrust, thinkingLevel } = {}) {
  const grandparent = await mkdtemp(join(root, "grandparent-"));
  const parent = join(grandparent, "parent");
  const cwd = join(parent, "project");
  await mkdir(cwd, { recursive: true });
  const file = join(cwd, ".pi/settings.json");
  const parentFile = join(parent, ".pi/settings.json");
  const grandparentFile = join(grandparent, ".pi/settings.json");
  for (const [path, content] of [[file, settings], [parentFile, parentSettings], [grandparentFile, grandparentSettings]]) {
    if (content !== undefined) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
  }
  const commands = new Map();
  const handlers = new Map();
  const notifications = [];
  const switches = [];
  const thinkingSwitches = [];
  let activeThinkingLevel = thinkingLevel;
  if (start) {
    const trust = new ProjectTrustStore(dirname(globalFile));
    if (ancestorTrust !== null) trust.set(grandparent, ancestorTrust);
    if (childTrust !== undefined) trust.set(cwd, childTrust);
  }
  const choices = [];
  let picker, rendered, refreshSignal, disposed = false;
  register({
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => handlers.set(name, handler),
    setThinkingLevel: (level) => { activeThinkingLevel = level; thinkingSwitches.push(level); },
    setModel: async (model) => {
      switches.push(model);
      if (start && switchOK && thinkingLevel !== undefined) activeThinkingLevel = "low";
      if (onSwitch) await onSwitch({ cwd, file, parentFile });
      return switchOK;
    },
  });
  const ctx = {
    cwd, mode, model: models[0], scopedModels,
    get thinkingLevel() { return activeThinkingLevel; },
    sessionManager: { getBranch: () => branch },
    isProjectTrusted: () => trusted,
    modelRegistry: {
      getAvailable: () => models,
      find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
      getError: () => undefined,
      refresh: async ({ signal }) => {
        refreshSignal = signal;
        if (refreshPending) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { errors: new Map(), aborted: signal.aborted };
      },
    },
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      select: async (title, options) => {
        choices.push({ title, options });
        assert.equal(options.length, 3);
        return saveChoice === "local" ? options[0] : saveChoice === "parent" ? options[1] : saveChoice === "cancel" ? options[2] : undefined;
      },
      custom: async (factory, options) => {
        assert.equal(options?.overlay ?? false, false, "use the same inline placement as /model");
        let finish;
        const result = new Promise((resolve) => { finish = resolve; });
        picker = await factory({ terminal: { rows: 40 }, requestRender() {} }, {}, {}, finish);
        assert.ok(picker instanceof ModelSelectorComponent, "reuse Pi's actual picker");
        const dispose = picker.dispose.bind(picker);
        picker.dispose = () => { disposed = true; dispose(); };
        picker.focused = true;
        await new Promise((resolve) => setImmediate(resolve));
        rendered = picker.render(120).join("\n");
        if (beforeSelect) await beforeSelect({ ctx, file, parentFile });
        for (const key of keys) picker.handleInput(key);
        try { return await result; } finally { picker.dispose(); }
      },
    },
  };
  assert.deepEqual([...commands.keys()], ["model-project"]);
  if (start) {
    if (beforeStart) await beforeStart({ cwd, file, parentFile, grandparentFile });
    await handlers.get("session_start")({ type: "session_start", reason }, ctx);
  } else await commands.get("model-project").handler("", ctx);
  return { cwd, file, parentFile, grandparentFile, switches, thinkingSwitches, choices, notifications, picker, rendered, refreshSignal, disposed };
}

test("startup loads nearest ancestor model without writing settings", async () => {
  const parentSettings = '{"defaultProvider":"proxy","defaultModel":"deepseek-chat"}';
  const f = await fixture({ start: true, parentSettings, branch: [{ type: "model_change" }, { type: "thinking_level_change" }] });
  assert.deepEqual(f.switches, [models[1]]);
  assert.deepEqual(f.thinkingSwitches, []);
  assert.equal(f.picker, undefined);
  assert.equal(await readFile(f.parentFile, "utf8"), parentSettings);
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
});

test("startup respects local defaults and nearest ancestor", async () => {
  const nearest = await fixture({ start: true, parentSettings: '{"defaultProvider":"proxy","defaultModel":"deepseek-chat"}', grandparentSettings: '{"defaultProvider":"deepseek","defaultModel":"deepseek-chat"}' });
  assert.deepEqual(nearest.switches, [models[1]]);
  for (const settings of ['{"defaultProvider":"deepseek","defaultModel":"deepseek-chat"}', '{"defaultThinkingLevel":"low"}']) {
    const f = await fixture({ start: true, settings, parentSettings: '{"defaultProvider":"proxy","defaultModel":"deepseek-chat"}' });
    assert.deepEqual(f.switches, []);
  }
  const thinking = await fixture({ start: true, parentSettings: '{"defaultThinkingLevel":"high"}', grandparentSettings: '{"defaultProvider":"proxy","defaultModel":"deepseek-chat"}' });
  assert.deepEqual(thinking.switches, []);
  const distant = await fixture({ start: true, parentSettings: '{"theme":"dark"}', grandparentSettings: '{"defaultProvider":"proxy","defaultModel":"deepseek-chat"}' });
  assert.deepEqual(distant.switches, [models[1]]);
  const alreadySelected = await fixture({ start: true, parentSettings: '{"defaultProvider":"deepseek","defaultModel":"deepseek-chat"}' });
  assert.deepEqual(alreadySelected.switches, []);
});

test("startup skips untrusted projects and existing sessions", async () => {
  for (const options of [
    { trusted: false },
    { reason: "resume" },
    { reason: "fork" },
    { reason: "reload" },
    { branch: [{ type: "message" }] },
    { branch: [{ type: "model_change" }, { type: "model_change" }] },
  ]) {
    const f = await fixture({ start: true, parentSettings: '{"defaultProvider":"proxy","defaultModel":"deepseek-chat"}', ...options });
    assert.deepEqual(f.switches, [], JSON.stringify(options));
  }
  const fresh = await fixture({ start: true, reason: "new", mode: "print", parentSettings: '{"defaultProvider":"proxy","defaultModel":"deepseek-chat"}' });
  assert.deepEqual(fresh.switches, [models[1]]);
});

test("startup ignores bad or unavailable ancestor model and respects scope", async () => {
  const inherited = '{"defaultProvider":"proxy","defaultModel":"deepseek-chat"}';
  const malformed = await fixture({ start: true, parentSettings: '{bad', grandparentSettings: inherited });
  assert.deepEqual(malformed.switches, [models[1]]);
  for (const options of [
    { parentSettings: '{"defaultProvider":"proxy","defaultModel":"unknown"}' },
    { parentSettings: inherited, scopedModels: [{ model: models[0] }] },
    { parentSettings: inherited, switchOK: false },
  ]) {
    const f = await fixture({ start: true, ...options });
    assert.deepEqual(f.switches.filter((m) => m === models[1]), options.switchOK === false ? [models[1]] : []);
    await assert.rejects(readFile(f.file), { code: "ENOENT" });
  }
});

test("explicit CLI model wins over ancestor default", async () => {
  process.argv.push("--model", "deepseek/deepseek-chat");
  try {
    const f = await fixture({ start: true, parentSettings: '{"defaultProvider":"proxy","defaultModel":"deepseek-chat"}' });
    assert.deepEqual(f.switches, []);
  } finally {
    process.argv.splice(-2);
  }
});

test("explicit CLI thinking survives ancestor model selection", async () => {
  process.argv.push("--thinking", "high");
  try {
    for (const thinkingLevel of ["high", "off"]) {
      const f = await fixture({ start: true, thinkingLevel, scopedModels: [{ model: models[0] }, { model: models[1], thinkingLevel: "low" }], parentSettings: '{"defaultProvider":"proxy","defaultModel":"deepseek-chat"}' });
      assert.deepEqual(f.switches, [models[1]]);
      assert.deepEqual(f.thinkingSwitches, ["high"], "even when Pi clamped the initial model to off");
    }
  } finally {
    process.argv.splice(-2);
  }
});

test("selected model's scoped thinking level is retained", async () => {
  const f = await fixture({ start: true, thinkingLevel: "low", scopedModels: [{ model: models[0] }, { model: models[1], thinkingLevel: "high" }], parentSettings: '{"defaultProvider":"proxy","defaultModel":"deepseek-chat"}' });
  assert.deepEqual(f.switches, [models[1]]);
  assert.deepEqual(f.thinkingSwitches, ["high"]);
});

test("ancestor loading requires trust in its source, including explicit denials", async () => {
  const parentSettings = '{"defaultProvider":"proxy","defaultModel":"deepseek-chat"}';
  for (const ancestorTrust of [null, false]) {
    const f = await fixture({ start: true, parentSettings, ancestorTrust });
    assert.deepEqual(f.switches, []);
    if (ancestorTrust === null) assert.ok(f.notifications.some((n) => n.level === "warning" && n.message.includes("Trust")));
    else assert.deepEqual(f.notifications, []);
  }
  const childTrusted = await fixture({ start: true, parentSettings, ancestorTrust: null, childTrust: true });
  assert.deepEqual(childTrusted.switches, [], "trusting only the subfolder cannot approve its parent settings");
  const childDenied = await fixture({ start: true, parentSettings, childTrust: false });
  assert.deepEqual(childDenied.switches, []);
  assert.deepEqual(childDenied.notifications, []);
});

test("trusted ancestor cannot load a symlinked settings file", async () => {
  const f = await fixture({ start: true, parentSettings: '{"defaultProvider":"proxy","defaultModel":"deepseek-chat"}', beforeStart: async ({ parentFile }) => {
    const untrusted = join(root, "external-settings.json");
    await writeFile(untrusted, '{"defaultProvider":"proxy","defaultModel":"deepseek-chat"}');
    await rm(parentFile);
    await symlink(untrusted, parentFile);
  } });
  assert.deepEqual(f.switches, []);
});

test("startup does not load an ancestor through malformed local settings", async () => {
  const f = await fixture({ start: true, settings: "{invalid", parentSettings: '{"defaultProvider":"proxy","defaultModel":"deepseek-chat"}' });
  assert.deepEqual(f.switches, []);
  assert.ok(f.notifications.some((n) => n.level === "warning"));
});

test("native picker displays providers and saves the selected duplicate model", async () => {
  const f = await fixture({ keys: ["\x1b[B", "\r"] });
  assert.match(f.rendered, /\[deepseek\]/);
  assert.match(f.rendered, /\[proxy\]/);
  assert.equal(f.switches[0], models[1]);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), {
    defaultProvider: "proxy", defaultModel: "deepseek-chat",
  });
  assert.ok(f.disposed, "dispose the native picker after selection");
  assert.ok(f.notifications.some((n) => n.message.includes(f.file)));
});

test("save preserves unrelated settings and thinking defaults", async () => {
  const f = await fixture({ settings: JSON.stringify({
    defaultProvider: "old", defaultModel: "old", defaultThinkingLevel: "high", retry: { maxRetries: 8 },
  }) });
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), {
    defaultProvider: "deepseek", defaultModel: "deepseek-chat", defaultThinkingLevel: "high", retry: { maxRetries: 8 },
  });
});

test("ancestor model defaults prompt for local save without changing the shared file", async () => {
  const parentSettings = '{"defaultProvider":"proxy","defaultModel":"deepseek-chat","theme":"dark"}';
  const f = await fixture({ parentSettings });
  assert.equal(f.choices.length, 1);
  assert.ok(f.choices[0].options[0].includes(f.file));
  assert.ok(f.choices[0].options[1].includes(f.parentFile));
  assert.match(f.choices[0].title, /ancestor load/i);
  assert.equal(await readFile(f.parentFile, "utf8"), parentSettings);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { defaultProvider: "deepseek", defaultModel: "deepseek-chat" });
});

test("explicit ancestor save updates nearest model settings, preserving other fields", async () => {
  const grandparentSettings = '{"defaultProvider":"deepseek","defaultModel":"old"}';
  const f = await fixture({
    parentSettings: '{"theme":"light"}', grandparentSettings, saveChoice: "parent",
  });
  assert.equal(f.choices.length, 1);
  assert.ok(f.choices[0].options[1].includes(f.grandparentFile));
  assert.deepEqual(JSON.parse(await readFile(f.grandparentFile, "utf8")), { defaultProvider: "deepseek", defaultModel: "deepseek-chat" });
  assert.equal(await readFile(f.parentFile, "utf8"), '{"theme":"light"}');
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
  assert.ok(f.notifications.some((n) => n.message.includes(f.grandparentFile)));
});

test("malformed ancestor does not prevent saving locally", async () => {
  const f = await fixture({ parentSettings: "{bad json" });
  assert.deepEqual(f.choices, []);
  assert.equal(f.switches[0], models[0]);
  assert.equal(await readFile(f.parentFile, "utf8"), "{bad json");
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).defaultModel, "deepseek-chat");
});

test("malformed ancestor is skipped in favor of the next valid ancestor", async () => {
  const f = await fixture({
    parentSettings: "{bad json", grandparentSettings: '{"defaultProvider":"proxy","defaultModel":"old"}',
    saveChoice: "parent",
  });
  assert.equal(f.choices.length, 1);
  assert.ok(f.choices[0].options[1].includes(f.grandparentFile));
  assert.equal(await readFile(f.parentFile, "utf8"), "{bad json");
  assert.equal(JSON.parse(await readFile(f.grandparentFile, "utf8")).defaultModel, "deepseek-chat");
});

test("nearest ancestor wins and parent save preserves thinking and unrelated settings", async () => {
  const f = await fixture({
    parentSettings: '{"defaultProvider":"proxy","defaultModel":"old","defaultThinkingLevel":"high","theme":"dark"}',
    grandparentSettings: '{"defaultProvider":"deepseek","defaultModel":"old"}', saveChoice: "parent",
  });
  assert.ok(f.choices[0].options[1].includes(f.parentFile));
  assert.deepEqual(JSON.parse(await readFile(f.parentFile, "utf8")), {
    defaultProvider: "deepseek", defaultModel: "deepseek-chat", defaultThinkingLevel: "high", theme: "dark",
  });
  assert.equal(await readFile(f.grandparentFile, "utf8"), '{"defaultProvider":"deepseek","defaultModel":"old"}');
});

test("thinking-only settings stop the ancestor search at the nearest matching folder", async () => {
  const grandparentSettings = '{"defaultProvider":"proxy","defaultModel":"old"}';
  const f = await fixture({
    parentSettings: '{"defaultThinkingLevel":"high"}', grandparentSettings, saveChoice: "parent",
  });
  assert.ok(f.choices[0].options[1].includes(f.parentFile));
  assert.deepEqual(JSON.parse(await readFile(f.parentFile, "utf8")), {
    defaultProvider: "deepseek", defaultModel: "deepseek-chat", defaultThinkingLevel: "high",
  });
  assert.equal(await readFile(f.grandparentFile, "utf8"), grandparentSettings);
});

test("local thinking-only settings do not offer an ancestor save", async () => {
  const f = await fixture({
    settings: '{"defaultThinkingLevel":"low"}',
    parentSettings: '{"defaultProvider":"proxy","defaultModel":"old"}',
  });
  assert.deepEqual(f.choices, []);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), {
    defaultProvider: "deepseek", defaultModel: "deepseek-chat", defaultThinkingLevel: "low",
  });
});

test("linked ancestor settings stay linked and unchanged", async () => {
  let shared;
  const f = await fixture({ saveChoice: "parent", beforeSelect: async ({ parentFile }) => {
    shared = join(dirname(parentFile), "shared.json");
    await mkdir(dirname(parentFile), { recursive: true });
    await writeFile(shared, '{"defaultProvider":"proxy","defaultModel":"old"}');
    await symlink(shared, parentFile);
  } });
  assert.equal(f.choices.length, 1);
  assert.deepEqual(f.switches, []);
  assert.equal(await readlink(f.parentFile), shared);
  assert.equal(JSON.parse(await readFile(shared, "utf8")).defaultModel, "old");
  assert.ok(f.notifications.some((n) => n.level === "error" && n.message.includes("symlink")));
});

test("ancestor linked during model switch is not replaced", async () => {
  let shared;
  const f = await fixture({
    parentSettings: '{"defaultProvider":"proxy","defaultModel":"old"}', saveChoice: "parent",
    onSwitch: async ({ parentFile }) => {
      shared = join(dirname(parentFile), "shared.json");
      await writeFile(shared, '{"defaultProvider":"proxy","defaultModel":"old"}');
      await rm(parentFile);
      await symlink(shared, parentFile);
    },
  });
  assert.equal(f.switches.length, 1);
  assert.equal(await readlink(f.parentFile), shared);
  assert.equal(JSON.parse(await readFile(shared, "utf8")).defaultModel, "old");
  assert.ok(f.notifications.some((n) => n.level === "error" && n.message.includes("symlink")));
});

test("cancelling the save target leaves both settings and session unchanged", async () => {
  for (const saveChoice of ["cancel", "escape"]) {
    const parentSettings = '{"defaultProvider":"proxy","defaultModel":"old"}';
    const f = await fixture({ parentSettings, saveChoice });
    assert.equal(f.choices.length, 1);
    assert.deepEqual(f.switches, []);
    assert.equal(await readFile(f.parentFile, "utf8"), parentSettings);
    await assert.rejects(readFile(f.file), { code: "ENOENT" });
  }
});

test("local model defaults never prompt to overwrite an ancestor", async () => {
  const f = await fixture({
    settings: '{"defaultModel":"old"}',
    parentSettings: '{"defaultProvider":"proxy","defaultModel":"old"}',
  });
  assert.deepEqual(f.choices, []);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { defaultProvider: "deepseek", defaultModel: "deepseek-chat" });
  assert.equal(JSON.parse(await readFile(f.parentFile, "utf8")).defaultModel, "old");
});

test("a local default added during the picker keeps the save local", async () => {
  const parentSettings = '{"defaultProvider":"proxy","defaultModel":"old"}';
  const f = await fixture({
    parentSettings, saveChoice: "parent",
    beforeSelect: async ({ file }) => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, '{"defaultProvider":"proxy","defaultModel":"old"}');
    },
  });
  assert.deepEqual(f.choices, []);
  assert.equal(await readFile(f.parentFile, "utf8"), parentSettings);
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).defaultModel, "deepseek-chat");
});

test("ancestor enabledModels prevents saving an invalid shared default", async () => {
  const parentSettings = '{"defaultProvider":"proxy","defaultModel":"old","enabledModels":["proxy/*"]}';
  const f = await fixture({ parentSettings, saveChoice: "parent" });
  assert.deepEqual(f.switches, []);
  assert.equal(await readFile(f.parentFile, "utf8"), parentSettings);
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
  assert.ok(f.notifications.some((n) => n.level === "error" && n.message.includes("enabledModels")));
});

test("local enabledModels still limits the current session when saving to an ancestor", async () => {
  const parentSettings = '{"defaultProvider":"deepseek","defaultModel":"old"}';
  const settings = '{"enabledModels":["proxy/*"]}';
  const f = await fixture({ settings, parentSettings, saveChoice: "parent" });
  assert.deepEqual(f.switches, []);
  assert.equal(await readFile(f.parentFile, "utf8"), parentSettings);
  assert.equal(await readFile(f.file, "utf8"), settings);
  assert.ok(f.notifications.some((n) => n.level === "error" && n.message.includes("enabledModels")));
});

test("Escape leaves the session and project unchanged", async () => {
  const f = await fixture({ keys: ["\x1b"], refreshPending: true });
  assert.deepEqual(f.switches, []);
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
  assert.ok(f.refreshSignal.aborted);
});

test("untrusted projects and non-TUI clients cannot save", async () => {
  for (const options of [{ trusted: false }, { mode: "rpc" }]) {
    const f = await fixture(options);
    assert.equal(f.picker, undefined);
    assert.deepEqual(f.switches, []);
    await assert.rejects(readFile(f.file), { code: "ENOENT" });
    assert.ok(f.notifications.length);
  }
});

test("malformed or non-object settings are never overwritten", async () => {
  for (const settings of ["{oops", "[]", "null", '"text"']) {
    const f = await fixture({ settings });
    assert.equal(await readFile(f.file, "utf8"), settings);
    assert.deepEqual(f.switches, []);
    assert.ok(f.notifications.some((n) => n.level === "error"));
  }
});

test("failed model switch leaves project defaults unchanged", async () => {
  const settings = '{"defaultProvider":"old","defaultModel":"old"}\n';
  const f = await fixture({ settings, switchOK: false });
  assert.equal(await readFile(f.file, "utf8"), settings);
  assert.ok(f.notifications.some((n) => n.level === "error"));
});

test("write failures report the session-only switch and clean staged files", async () => {
  const f = await fixture({ onSwitch: async ({ file }) => mkdir(file, { recursive: true }) });
  assert.equal(f.switches[0], models[0]);
  assert.ok(f.notifications.some((n) => n.level === "error" && n.message.includes("Session switched, but project default was not saved")));
  assert.deepEqual(await readdir(join(f.cwd, ".pi")), ["settings.json"]);
});

test("save re-reads settings changed while the picker is open", async () => {
  const f = await fixture({
    settings: "{}",
    beforeSelect: async ({ file }) => writeFile(file, '{"theme":"light"}'),
  });
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), {
    theme: "light", defaultProvider: "deepseek", defaultModel: "deepseek-chat",
  });
});

test("invalid settings or revoked trust during selection prevent changes", async () => {
  for (const beforeSelect of [
    async ({ file }) => writeFile(file, "{invalid"),
    async ({ ctx }) => { ctx.isProjectTrusted = () => false; },
  ]) {
    const f = await fixture({ settings: "{}", beforeSelect });
    assert.deepEqual(f.switches, []);
    assert.ok(f.notifications.some((n) => n.level === "error"));
  }
});

test("settings read errors are reported rather than treated as a missing file", async () => {
  const f = await fixture({
    beforeSelect: async ({ file }) => mkdir(file, { recursive: true }),
  });
  assert.deepEqual(f.switches, []);
  assert.ok(f.notifications.some((n) => n.level === "error" && n.message.includes("EISDIR")));
});

test("BOM-prefixed settings are accepted like Pi's native settings", async () => {
  const f = await fixture({ settings: '\uFEFF{"theme":"light"}' });
  assert.equal(f.switches[0], models[0]);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), {
    theme: "light", defaultProvider: "deepseek", defaultModel: "deepseek-chat",
  });
});

test("native settings updates during switching are preserved", async () => {
  const f = await fixture({ settings: "{}", onSwitch: async ({ cwd }) => {
    const manager = SettingsManager.create(cwd, dirname(globalFile));
    manager.setProjectPackages(["npm:example"]);
    await manager.flush();
    assert.deepEqual(manager.drainErrors(), []);
  } });
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), {
    packages: ["npm:example"], defaultProvider: "deepseek", defaultModel: "deepseek-chat",
  });
  assert.deepEqual(await readdir(dirname(f.file)), ["settings.json"]);
});

test("a settings lock held by another process prevents overwriting", async () => {
  let child;
  try {
    const f = await fixture({ settings: "{}", onSwitch: async ({ file }) => {
      child = spawn(process.execPath, ["-e", `
        const lockfile = require(${JSON.stringify(createRequire(join(getPackageDir(), "package.json")).resolve("proper-lockfile"))});
        lockfile.lockSync(process.argv[1], { realpath: false });
        process.stdout.write("locked\\n");
        setInterval(() => {}, 1000);
      `, file], { stdio: ["ignore", "pipe", "inherit"] });
      await once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
    } });
    assert.equal(await readFile(f.file, "utf8"), "{}");
    assert.ok(f.notifications.some((n) => n.level === "error" && /lock/i.test(n.message)));
  } finally {
    if (child) {
      child.kill();
      await once(child, "exit");
    }
  }
});

test("all-model selection outside configured enabledModels is rejected", async () => {
  const settings = '{"enabledModels":["deepseek/deepseek-chat"]}';
  const f = await fixture({
    settings, scopedModels: [{ model: models[0] }], keys: ["\t", ..."proxy", "\r"],
  });
  assert.deepEqual(f.switches, []);
  assert.equal(await readFile(f.file, "utf8"), settings);
  assert.ok(f.notifications.some((n) => n.level === "error" && n.message.includes("enabledModels")));
});

test("global enabledModels also limits project defaults", async () => {
  const global = await readFile(globalFile, "utf8");
  try {
    await writeFile(globalFile, '{"enabledModels":["deepseek/*:high"]}');
    const f = await fixture({ keys: [..."proxy", "\r"] });
    assert.deepEqual(f.switches, []);
    await assert.rejects(readFile(f.file), { code: "ENOENT" });
    assert.ok(f.notifications.some((n) => n.level === "error" && n.message.includes("enabledModels")));
  } finally {
    await writeFile(globalFile, global);
  }
});

test("project enabledModels overrides global patterns, not the CLI model scope", async () => {
  const global = await readFile(globalFile, "utf8");
  try {
    await writeFile(globalFile, '{"enabledModels":["deepseek/*"]}');
    const f = await fixture({
      settings: '{"enabledModels":["proxy/*:high"]}',
      scopedModels: [{ model: models[0] }], keys: ["\t", ..."proxy", "\r"],
    });
    assert.equal(f.switches[0], models[1]);
    assert.equal(JSON.parse(await readFile(f.file, "utf8")).defaultProvider, "proxy");
  } finally {
    await writeFile(globalFile, global);
  }
});

test("invalid enabledModels is rejected before switching", async () => {
  for (const enabledModels of [null, "deepseek/*", [42]]) {
    const settings = JSON.stringify({ enabledModels });
    const f = await fixture({ settings });
    assert.deepEqual(f.switches, []);
    assert.equal(await readFile(f.file, "utf8"), settings);
    assert.ok(f.notifications.some((n) => n.level === "error" && n.message.includes("enabledModels")));
  }
});

test("enabledModels changed during switching is preserved without saving a stale default", async () => {
  const f = await fixture({ settings: "{}", onSwitch: async ({ file }) => {
    await writeFile(file, '{"enabledModels":["proxy/*"]}');
  } });
  assert.equal(f.switches[0], models[0]);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { enabledModels: ["proxy/*"] });
  assert.ok(f.notifications.some((n) => n.level === "error" && n.message.includes("enabledModels changed")));
});

test("an empty configured scope does not prevent saving", async () => {
  const f = await fixture({ settings: '{"enabledModels":["not-a-model"]}', keys: [..."proxy", "\r"] });
  assert.equal(f.switches[0], models[1]);
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).defaultProvider, "proxy");
});

test("picker search uses the provider as well as the model ID", async () => {
  const f = await fixture({ keys: [..."proxy", "\r"] });
  assert.equal(f.switches[0], models[1]);
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).defaultProvider, "proxy");
});
