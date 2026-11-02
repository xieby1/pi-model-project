# pi-model-project

`/model-project` opens Pi's **own `/model` picker**, then switches the current session to the selected model and saves its `defaultProvider` and `defaultModel`. It normally saves to `<cwd>/.pi/settings.json`. If that file has no model or thinking default and a parent `.pi/settings.json` does, it asks after the picker whether to save locally (default), update the nearest parent's shared settings, or cancel. The prompt shows both paths and warns that Pi only uses a parent's defaults in subfolders when an ancestor-loading extension is installed. A parent file is **not** assumed to be the source of the current session model. Escape at either prompt leaves both the session and settings unchanged. The native picker displays provider badges, so models with the same name and ID from different providers are distinguishable.

Only the chosen settings file's default model is changed: global settings, `defaultThinkingLevel`, and unrelated settings are preserved. The command requires a trusted project and Pi's interactive terminal (TUI); it does not provide a picker in RPC/print/JSON modes. It checks `enabledModels` before switching, refuses malformed selected settings, skips unreadable ancestor candidates, and refuses to replace symlinked settings files. Saving uses Pi's settings lock plus an atomic replacement. If saving fails after switching, it reports that the session changed but the default did not.

## Why another extension?

The requirement was deliberately narrow: **one project-scoped command with the exact model picker used by Pi's `/model`, without changing global or thinking defaults.** These comparisons describe the alternatives as evaluated in October 2026; upstream behavior may change.

| Alternative | What it offers | Why it did not fit |
| --- | --- | --- |
| [Pi's built-in `/model`](https://github.com/earendil-works/pi) | The desired native picker | Its save action (`Ctrl+S`) saves a global default. An ordinary extension shortcut cannot redirect that key while this picker owns input. |
| [`@faiku/pi-default-model-switcher`](https://github.com/Faikuu/pi-default-model-switcher) | `/model-project` writes Pi's project settings; also offers session and global commands | Its separate picker looked inconsistent. Its terminal list omitted the provider from the displayed rows, so two providers offering the same model looked identical even though their underlying values differed. It also wrote `defaultThinkingLevel`, which we wanted to leave alone. |
| [`@jasonish/pi-default-model`](https://www.npmjs.com/package/@jasonish/pi-default-model) | Project/global startup-model commands | It stores a separate `startupModel` setting and applies it at startup instead of saving Pi's native `defaultProvider` / `defaultModel` project defaults. |

This extension reuses Pi's exported `ModelSelectorComponent`, with a small adapter between the extension's model registry and the picker's runtime interface. **Compatibility caveat:** that adapter depends on Pi's picker API; test `/model-project` against your installed Pi after upgrades.

## Use

From this repository, try it without installing:

```sh
pi -e .
# Then run /model-project in Pi.
```

After publishing the Git repository, you can install it from Git instead (replace the GitHub account if needed):

```sh
pi install git:github.com/xieby1/pi-model-project
```

The extension does not create a new model registry, change Pi's built-in `/model` behavior, or enable ancestor inheritance on startup. For a shared parent model default to apply when launching Pi from a subfolder, use an ancestor model loader such as [`@claaslange/pi-directory-models`](https://github.com/claaslange/pi-directory-models). Project trust and an interactive terminal are required to save a choice.

## Test

Node.js 22.19+ is required; the development dependency matches the Pi 1.4.0 version against which these tests were written.

```sh
npm ci
npm test
```

The tests drive Pi's actual picker, including duplicate model names across providers, local and ancestor save targets, cancellation, trust, settings preservation and concurrent writes. No Home Manager or Nix configuration is part of this standalone extension.
