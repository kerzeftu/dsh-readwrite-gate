# 司门 · `dsh-readwrite-gate`

[简体中文](README.md) | **English**

司门 is a file access permission plugin for DeepSeek Harness (DSH). It adds two permission presets, **No access** and **Read and write inside workspace**, and prompts for approval when a file operation falls outside the permitted scope.

Choose a preset from the permission menu in the input area. Additional access can be granted through approval prompts or the extra file permissions panel.

## Permission presets

| Preset | Read access | Write access |
|---|---|---|
| No access | Denied by default; manually added read allowlist entries are exceptions | Denied |
| Read and write inside workspace | Workspace and temporary directories; other paths require approval | Workspace and temporary directories |
| Read-only | Any path | Denied |
| Edit inside workspace | Any path | Workspace and temporary directories |
| Full access | Any path | Any path |

**Read and write inside workspace** and **Edit inside workspace** have the same write scope. They differ in whether reads outside the workspace require approval. Temporary directories include `/tmp` and the system's temporary directory.

Under either workspace preset, writes outside the permitted scope also trigger an approval prompt. Approval does not override the DSH sandbox or grant the ability to write outside its allowed scope.

## Granting and revoking access

Approval prompts offer three choices: **Deny**, **Allow once**, and **Always allow access/modification in this conversation**.

- Read approval does not automatically grant write access.
- Persistent approval usually covers the file's containing directory, not just the individual file. It applies to the contents of that directory. Check the path shown in the prompt before approving.
- The extra file permissions panel has separate read and write sections. Writable paths also appear in the read section. Removing a path from the read section revokes both read and write access; removing it from the write section revokes only write access.
- Grants are kept in the current Harness process. After a restart, approval is required again.

See the [authorization guide](docs/authorization.md) for details. The linked documentation is in Chinese.

## Installation

Download a [release asset](https://github.com/kerzeftu/dsh-readwrite-gate/releases) or clone the repository, keep a local copy of the plugin directory, and install it into the DSH profile you intend to use. See [installation and configuration](docs/configuration.md) for the full procedure.

For manual configuration, add the dependency and bundle entry to the profile's `package.json`. The example below shows only the relevant fields; merge them into the existing configuration rather than replacing the file. Replace `<repo-path>` with the absolute path to your local plugin directory.

```json
{
  "dependencies": { "dsh-readwrite-gate": "link:<repo-path>" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-readwrite-gate"] } }
}
```

Restart Harness after installation or an upgrade. Packaging and development notes are in the [development guide](docs/development.md).

## Compatibility

The table describes the testing performed for each version, not a compatibility guarantee for all DSH releases.

| DSH version | Validation |
|---|---|
| `0.2.1-alpha.1` | Primary development version; loading, file access, and approval flows tested |
| `0.2.2-rc.3` | Configuration composition and startup tested; behavioral testing was not performed to the same extent |

For other versions, test loading and approval behavior in a separate profile first. See [troubleshooting](docs/troubleshooting.md).

## Commands

| Command | Purpose |
|---|---|
| `/access-allow` or `/access-allow list` | Show current permissions and additional paths |
| `/access-allow add <path>` | Add a read allowlist entry that remains readable under No access |
| `/access-allow add-write <path>` | Grant write access, subject to the current preset and sandbox |
| `/access-allow remove <path>` | Revoke read and write grants for the path |
| `/access-allow clear` | Clear additional paths for this conversation |

Use the input area's permission menu to change presets, not these commands. Paths can be managed through either the panel or commands. See [installation and configuration](docs/configuration.md) for complete command usage.

## Limitations

司门 determines access scope by analyzing tool arguments and paths in commands. It is not an operating-system-level sandbox. Commands that cannot be fully analyzed are handled according to their working directory or the configured denial policy; this does not guarantee that arbitrary scripts cannot access paths outside the intended scope. Writes must also pass DSH's own sandbox checks.

## Further reading

The following guides are in Chinese:

- [Project overview](docs/overview.md): features, intended use, and terminology.
- [Installation and configuration](docs/configuration.md): installation, configuration fields, and commands.
- [Authorization](docs/authorization.md): grant scope, lifetime, and revocation.
- [Troubleshooting](docs/troubleshooting.md): loading problems, UI issues, and unexpected permission behavior.

Maintainers can use the [documentation index](docs/README.md) to find architecture, development, and testing guides. Version history is in the [changelog](CHANGELOG.md).

## License

Released under the [MIT License](LICENSE). Author: kerzeftu.
