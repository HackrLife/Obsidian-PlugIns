# Obsidian PlugIns

Source for every Obsidian plugin I build, one folder per plugin. All of them are free and open source.

## Plugins

| Plugin | What it does | Status | Install |
| --- | --- | --- | --- |
| [Literature Matrix](plugins/literature-matrix) | Compare research notes side by side in a synthesis matrix, with papers as rows and sections such as Method, Data, Findings and Gaps as columns. | 1.0.0 released | [HackrLife/literature-matrix](https://github.com/HackrLife/literature-matrix) |
| [Research Experiment Record](plugins/research-experiment-record) | Turn a research note into a linked experiment record with a hypothesis, method, metrics, evidence, and results. | 1.0.0, preparing submission | [HackrLife/research-experiment-record](https://github.com/HackrLife/research-experiment-record) |

## How this repo is organised

```
plugins/
  <plugin-id>/          one folder per plugin, named by its manifest id
    src/main.*          source
    styles.css
    manifest.json       id, name, version, minAppVersion
    versions.json       plugin version → minimum app version
    package.json
    README.md           shown on the plugin's own repo and in the directory
    LICENSE
    docs/               screenshots
.github/workflows/
  publish.yml           publishes one plugin to its release repo
```

Obsidian installs a plugin from a repo that has `manifest.json` at its root and the build files attached to a GitHub release. So each plugin also has a small release repo of its own, `HackrLife/<plugin-id>`. Nothing is edited there by hand: the publish workflow copies the plugin's folder across, and the release repo's own Release workflow builds the plugin and creates the release whenever the version in `manifest.json` is new.

## Releasing a plugin

1. Raise `version` in the plugin's `manifest.json` and `package.json`, and add the new version to `versions.json`.
2. Commit, then push a tag named `<plugin-id>@<version>`:

```bash
git tag literature-matrix@1.0.1
git push origin literature-matrix@1.0.1
```

The workflow checks the tag against `manifest.json` and syncs the folder to `HackrLife/<plugin-id>`. The release repo then builds the plugin and creates the release with `main.js`, `manifest.json` and `styles.css`. Obsidian reviews each new release automatically.

The publish workflow needs one repository secret, `PUBLISH_TOKEN`: a fine-grained GitHub token with Contents read and write on the release repos.

## Adding a plugin

1. Create the empty release repo `HackrLife/<plugin-id>` (public, no README) and add it to `PUBLISH_TOKEN`. Copy `.github/workflows/release.yml` from an existing release repo into it.
2. Add `plugins/<plugin-id>/` with the files above and a row in the table.
3. Release `1.0.0` as above, then submit the release repo once at [community.obsidian.md](https://community.obsidian.md).

## Rules

- The plugin id is the folder name and the release repo name, and never changes after release.
- Names and descriptions never contain "Obsidian" or "plugin".
- Plugins work offline unless the feature needs the network, and never send notes anywhere without saying so in the README.

## License

MIT © Dev Das. Each plugin carries its own `LICENSE`.
