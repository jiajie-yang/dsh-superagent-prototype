# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

Choose the repository provider first. The main walkthrough below uses GitHub; for GitLab, follow the complete [GitLab repository provider](#gitlab-repository-provider) walkthrough and its dedicated template. GitLab-only deployments do not need a GitHub account or `gh` login.

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades.
- **An agent GitHub account.** The agent comments, pushes branches and opens pull requests as this account, through a GitHub CLI signed in only as that account.
- **Optional:** a Feishu bot for chat requests.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Sources for the repository and accounts, Policy for allowed lists, and Execution for worker directories and commands.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

## Prerequisites

- Node.js 22.19+ or 24+, pnpm, git 2.32+, Python 3.8+ and tmux
- GitHub CLI (`gh`) 2.48 or later. Source CLI fields must point to `gh` or `lark-cli` wrappers; the host relies on their subcommands and output formats.
- A repository on github.com; GitHub Enterprise Server is not supported. To create a checkout per Ticket, keep a local clone from which the prepare command can add worktrees. Install `git-lfs` if that repository uses Git LFS.
- A model provider configured for DeepSeek Harness. dsh-superagent uses the profile's default model unless the Eval or Execution settings name another.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent, because dsh-superagent reads the account's notifications.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. dsh-superagent reads the login the same way.

### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

## Install

Run this block once, on a machine that has no `superagent` profile yet:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

## Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu, also enable the `dsh-superagent-feishu` entry there. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute path: the database, the lock, the command shims in `worker-bin`, the agent's git configuration and, by default, the Ticket directories in `work`. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |

After the first start, edit machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

## Start and stop

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` runs `dsh --profile superagent` in tmux session `dsh-superagent`, or `dsh-<profile>` for another profile. It waits up to one minute for the runtime to become ready or report a setup requirement. On a first run it prints the missing setup information. It refuses duplicate instances, including ones started outside this script.

`stop` and `restart` request graceful shutdown and wait up to five minutes for Executors. They never force-kill the process or touch other tmux sessions.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and setup requirements under `setup`. `start` and `restart` print those problems as lines; they exit 1 if the service never comes up. Only an intentional `stop` pauses automatic recovery.

Each profile stores logs and control files under `.artifacts/`:

- Startup logs: `dsh-superagent-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the script. The newest 20 are kept.
- Control files: `control/profiles/<profile>/`, containing the stop marker, lock and process id.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

### Hourly check

Create the hourly check in the DeepSeek Harness profile you normally use, not in `superagent`. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path filled in:

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** Set the GitHub repository (`owner/name`) and agent CLI, for example `/home/me/.local/bin/gh-agent`. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub accounts and Feishu users who may ask for work; until a list has someone, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** The directory root and a prepare command. To give each Ticket a checkout of the repository:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   List personal CLIs, such as one signed in to your own account, as blocked commands.
4. **Prompts.** Set the team sections: the GitHub disclosure line, review bots, the commit author and the auto-merge condition.

### Management API

The panel uses a local HTTP API that agents can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing headers or an `Origin` from another site receive 403.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET settings` | `blocks`: `policy`, `eval` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone` or `channelIgnored` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting dsh-superagent: `restarting: true`. Refused when setup has nothing to fix |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | Reads the prompt configuration: `current`, with its `revision` and `config`, `defaults`, `sections`, the team sections in the order Sessions read them, `skillName`, the pattern of a team skill's name, `builtin`, the names a team skill cannot take, and `skillPrefix`, which Sessions load a skill's name under. Or saves it: the new `revision` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket, as the panel does |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Executor Session event handling; appears after its first failure |
| `github`, `feishu`, `history` | Source polling, events and history recovery |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `source:github`, `source:feishu`: `{"enabled": true, "config": {…}}`. GitHub's config has `repository` and `cli`, and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI; Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`.
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, and by `issues`, `pulls`, `comments` or `ci` for GitHub; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `maxWorkers`, `directory`, `prepare` and `blockedCommands`. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing a repository or CLI runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup verifies the GitHub repository and the agent's push access, writes the worker environment, and checks that git uses only the agent credentials for github.com. A Feishu setup failure disables only the Feishu Source.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` runs the agent's CLI; `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLI as the github.com credential helper, rewrites GitHub SSH addresses to HTTPS and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN` and `GITHUB_TOKEN` are removed.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Feishu, mention the bot in a configured chat.

## Upgrade

1. Wait until no Executor is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`.
3. Run `git pull && pnpm install && pnpm build`.
4. Run `scripts/dsh-superagent restart` and inspect its status.

A restart ends running Assignments and starts replacements with recovery notes. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### Agent presets

The worker and router presets move shell commands to the background after 5 seconds. A Session cannot load without its preset. Keep the `dsh-superagent-worker` and `dsh-superagent-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `The GitHub Source names no repository.` | Set the repository, `owner/name`, on the GitHub card |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| `git does not read the github.com credential configuration dsh-superagent writes` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The panel says dsh-superagent is not answering | It is restarting, or did not start because of its configuration; the DeepSeek Harness log names the cause |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Install a DeepSeek Harness version within the `engines.dsh` range |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |

## GitLab repository provider

This walkthrough creates a GitLab-only profile named `gitlab-agent` on port `3084`. Replace the example instance, project, paths and base branch with yours. Use a new profile and state directory; keep an existing installation's configuration when upgrading.

### 1. Prerequisites and agent identity

Install the shared prerequisites listed above: Node.js, system pnpm, git, Python and tmux, plus a DSH version satisfying `engines.dsh` in `package.json`. Use `glab` instead of `gh`; verify `glab auth git-credential --help` works. Install git-lfs if the target repository needs it. Configure a usable model provider in the new DSH profile before requesting work; the main and Executor Sessions use its default model unless their settings specify another.

Use a dedicated agent identity, either a dedicated user or the bot of a project access token. It needs Developer access or higher to the configured project, API read/write access for issues, comments and MRs, and HTTPS Git push access to work branches. A project access token with `api` and `write_repository` scopes can provide these capabilities. Keep its token in a private file owned by the service's OS user, outside the repository, state directory and generated worker files. Never put it in Source settings, a clone URL, shell arguments or chat.

The deployment owns each instance's identity and credential file; Source only stores the wrapper's absolute path. For this `gitlab-agent` profile use `~/.config/dsh-superagent/gitlab-agent/glab/agent-token`. Other profiles on the same server must use their own wrapper, directory and token file (for example `review-agent/glab/agent-token`), as well as separate state directories and ports. These directories prevent accidental credential mixing; isolation from other processes running as the same OS user requires a dedicated OS account or container.

Create or rotate the token using this hidden terminal prompt. It writes a mode-`0600` file by atomic replacement in a mode-`0700` directory, without including the token in command history:

```sh
python3 - <<'PY'
import getpass, os, tempfile
from pathlib import Path

directory = Path.home() / '.config/dsh-superagent/gitlab-agent/glab'
directory.mkdir(mode=0o700, parents=True, exist_ok=True)
directory.chmod(0o700)
token = getpass.getpass('GitLab agent token: ').strip()
if not token:
    raise SystemExit('Token must not be empty')
fd, temporary = tempfile.mkstemp(prefix='.agent-token-', dir=directory)
try:
    with os.fdopen(fd, 'w') as output:
        output.write(token + '\n')
    os.replace(temporary, directory / 'agent-token')
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
```

Create an executable wrapper. First find the real glab executable with `command -v glab`, then replace `/absolute/path/to/glab` below and set both host values to the Source's HTTPS host. Keep both values identical:

```sh
mkdir -p ~/.local/bin
cat > ~/.local/bin/glab-gitlab-agent <<'EOF'
#!/bin/sh
set -eu
umask 077
unset GITLAB_TOKEN GITLAB_ACCESS_TOKEN OAUTH_TOKEN CI_JOB_TOKEN GLAB_TOKEN
export GLAB_CONFIG_DIR="$HOME/.config/dsh-superagent/gitlab-agent/glab/config"
export GITLAB_HOST='gitlab.example.com'
export GITLAB_API_HOST='gitlab.example.com'
export GLAB_API_PROTOCOL=https GLAB_SKIP_TLS_VERIFY=false
export GLAB_ENABLE_CI_AUTOLOGIN=false CI=true GLAB_USE_KEYRING=false GLAB_IS_OAUTH2=false
token_file="$HOME/.config/dsh-superagent/gitlab-agent/glab/agent-token"
if [ ! -f "$token_file" ] || [ ! -r "$token_file" ]; then
  echo 'GitLab agent token file is missing or unreadable' >&2
  exit 1
fi
if ! GITLAB_TOKEN=$(cat "$token_file") || [ -z "$GITLAB_TOKEN" ]; then
  echo 'GitLab agent token file is empty or unreadable' >&2
  exit 1
fi
export GITLAB_TOKEN
exec '/absolute/path/to/glab' "$@"
EOF
chmod 700 ~/.local/bin/glab-gitlab-agent
~/.local/bin/glab-gitlab-agent api --hostname gitlab.example.com user --jq '{id, username, email}'
~/.local/bin/glab-gitlab-agent api --hostname gitlab.example.com 'projects/group%2Fsubgroup%2Frepository'
```

The wrapper loads the token for every invocation, including workers' Git credential helper. Missing, unreadable or empty files stop before glab runs; an expired/revoked token fails authentication without falling back to a personal login. The pinned API host, protocol and TLS verification override ambient variables and glab configuration. Keep any required proxy and corporate CA configuration; do not disable TLS verification. The wrapper's `CI=true`, disabled CI auto-login and disabled keyring are scoped to its child process, not the whole DSH service. The example was checked with glab `1.118.0`; recheck API, MR, discussion and Git helper behavior when upgrading glab.

Do not run agent-side `auth login` or `auth logout`. glab's keyring entries can be shared by host even across different configuration directories. This workflow supplies a token directly and does not migrate, overwrite or delete existing personal/legacy credentials. When adopting it, provision the agent's token file explicitly; do not automatically export or clean up old logins.

For rotation, wait for idle and stop the service, rerun the hidden prompt to atomically replace the file, and verify `/user` and the project with the wrapper before restarting. Retain the same numeric agent ID for an existing state directory; a new project-token bot may have a different ID and need new state. For local removal, stop the service and remove only that instance's token file. Local deletion does **not** revoke the token: revoke it separately in GitLab when no longer needed. Do not use `auth logout` as token-file cleanup.

Confirm the returned user is the agent and has an email. The project must have a clone URL on the same instance and project or group access level at least `30`. Setup checks these facts; it does not prove pushes to protected branches will succeed. Workers run with the operator's OS permissions, as described under [Permissions and isolation](#permissions-and-isolation).

### 2. Install and copy the GitLab template

Run from this source checkout, using the system pnpm. If DSH is not installed, install the version described under [Install](#install) first.

```sh
pnpm install --frozen-lockfile
pnpm check
dsh --profile gitlab-agent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile gitlab-agent add "link:$PWD"
cp examples/profile.gitlab.cordis.patch.yml \
  "${DSH_HOME:-$HOME/.dsh}/profiles/gitlab-agent/cordis.patch.yml"
```

The profile-creation and template-copy commands above are for a **new installation only**. `--from-default-profile` replaces an existing profile, including its user configuration; do not use it for upgrades.

Edit the copied [GitLab template](../examples/profile.gitlab.cordis.patch.yml): replace its `stateDir` placeholder with a new absolute path, such as `/home/me/.dsh/state/gitlab-agent`, and choose an unused port. It already sets `repositoryProvider: gitlab`, enables `dsh-superagent-gitlab` and disables the GitHub and Feishu Sources. Leave the bundle's router and worker presets installed.

Only machine configuration and plugin enablement belong in this file. Configure the instance, project, CLI, Policy and Execution through the Superagent panel. Feishu can be enabled and configured separately later.

### 3. Start and configure the Source

Start in the foreground first:

```sh
dsh --profile gitlab-agent --no-open
```

Open the full URL DSH prints, then **Superagent** in the sidebar. Waiting for setup on the first start is expected. Configure the profile's model provider and default model if not already available.

In **Sources → GitLab**, enable the Source and set:

| Field | Example |
| --- | --- |
| `baseUrl` | `https://gitlab.example.com` — HTTPS origin only, without a project path or `/api/v4` |
| `project` | `group/subgroup/repository` — a path, not a URL |
| `cli` | `/home/me/.local/bin/glab-gitlab-agent` — the wrapper's absolute path |
| `pollSeconds` | `60` by default; supported range `30`–`3600` |
| `receiveAllIssues`, `receiveAllMergeRequests`, `receiveAllComments` | Keep all off for the first deployment |

Saving account fields checks them and may restart Superagent. Wait for its API to answer again before saving the next block. For API-driven setup, read `GET settings` again and use the current block revision; preserve other fields when saving a whole block.

The first successful setup binds the state directory to the instance, numeric project ID and agent ID. Changing those requires a new state directory, even when previous tickets have ended. Credential rotation for the same identity is allowed. Do not reuse an existing GitHub state directory with ticket/event/session history.

### 4. Configure execution before allowing requests

Prepare a dedicated local clone. This example selects the agent helper only for the clone command, without modifying your global git configuration. Replace `/home/me`, the URL and destination:

```sh
mkdir -p /home/me/src
git -c credential.helper= \
  -c 'credential.helper=!/home/me/.local/bin/glab-gitlab-agent auth git-credential' \
  clone https://gitlab.example.com/group/subgroup/repository.git /home/me/src/repository-agent
```

Keep credentials and `http.*.extraheader` out of the clone's local `.git/config`; worker git uses the agent's generated HTTPS helper. Prepare the project's test tools and dependencies too: a working clone alone does not make tests runnable.

In **Execution**, start with `maxWorkers: 1`, leave the directory root empty to use `<stateDir>/work`, and configure the Prepare command below. Replace both absolute paths and set `main` to the base branch for Issue and other non-MR tickets. Use the Node.js version required by this checkout and the dedicated clone created above.

```sh
exec node /home/me/src/dsh-superagent-prototype/scripts/gitlab-prepare.mjs \
  /home/me/src/repository-agent main
```

The helper uses the bound project ID and dedicated `glab` shim. It checks that the clone's fetch and push URLs resolve to that project's HTTPS clone URL. Each new ticket gets a separate local `agent/<ticket-name>` branch. For an MR-origin ticket it reads the open MR at Prepare time, requires both projects to match the deployment, checks that both branches exist, and verifies that the source branch's advertised and fetched commit match the MR API SHA. Fork MRs are outside this single-project deployment. A missing, moved or unverifiable source fails Prepare. Retry after GitLab converges or ask the operator to inspect the MR. A subsequent remote update leaves the pinned workspace intact.

Review on an agent-created MR goes back to its existing ticket and workspace. Prepare never pushes, resets a branch or switches the workspace to the review event's head. A manual repeat accepts a worktree on the ticket branch that still contains its pinned base, including local edits and commits. A missing worktree with prior execution, an agent-owned MR, or a saved baseline fails and needs manual restoration. Inspect the ticket branch and `refs/dsh-superagent/bases/<ticket-id>` before repairing a partially created workspace. Preserve the work directory and the dedicated clone together.

Before an MR-origin ticket's first launch, Executor runs Prepare even if an earlier attempt left a directory, then requires a registered linked worktree on the ticket branch with the saved baseline in its history. It checks the same conditions before resuming an MR-origin ticket or delivering review feedback for an agent-owned MR. Workspace checks remain active when the GitLab Source is disabled.

If Prepare fails or is interrupted before a new Issue or other non-MR ticket starts, retry runs Prepare again even when it left a directory. Inspect a partial worktree and verify its baseline before restoring its pin.

When upgrading, replace the old worktree commands before admitting new requests. If your Prepare command also installs dependencies or runs other bootstrap steps, call the helper without `exec` and run those steps from `$DSH_SUPERAGENT_DIR` only after the helper succeeds. An existing non-MR-origin ticket can reuse the previous example's `refs/dsh-superagent/<ticket-id>` ref. When reusing that ref or resuming a custom ticket branch, the Executor reads the bound agent-owned MR and checks its full source branch against the local branch. For an existing MR-origin ticket without a verified pin, an operator must verify the actual MR baseline before recording it in `refs/dsh-superagent/bases/<ticket-id>` or repairing the workspace. Workers deliver from the ticket branch and report the new MR with `mr_iid`. Leave the originating MR's source branch under its author's control.

Review **Prompts → Delivery requirements**: use the agent's verified email and intended commit author, name the target branch and required project checks, retain the automation disclosure, and require human merge. GitLab defaults already use glab and manual merge; no GitHub auto-merge account is needed. Keep the default `observe` mode initially. It limits inferred work; **allowed users' explicit requests still execute**, so add the allowed list after execution setup is ready.

### 5. Configure the allowed users

In **Policy → GitLab → allowed users**, add the **people who may request work**, not the agent itself. A row's `id` must be `encodeURIComponent(baseUrl):numeric-user-id`. A username or a bare number is not this identity; `name` is optional display text and does not grant access.

To find your own numeric ID, use your **personal** glab login, not `glab-gitlab-agent`. Confirm its returned username is yours:

```sh
glab api --hostname gitlab.example.com user --jq '{id, username}'
```

For another person, obtain and verify their numeric user ID on this instance. Replace the URL and `123` in this command to generate the exact value to paste. Use the same instance as the Source; `origin` removes a trailing slash:

```sh
node -e '
const [baseUrl, userId] = process.argv.slice(1)
console.log(encodeURIComponent(new URL(baseUrl).origin) + ":" + userId)
' https://gitlab.example.com 123
```

Output: `https%3A%2F%2Fgitlab.example.com:123`. Paste this entire string into the ID column. This is the existing identity format; generating it does not change the stored Policy or automatically grant anyone access.

Leave **candidate bots** empty unless messages from another bot should become inferred candidates. That list uses the same ID format and does not let bots make explicit requests. It is not where the agent's own account or human operators belong.

### 6. Configure webhook intake

Choose **Webhook intake** when a full scan of Issues, MRs and discussions would exceed the API budget for the desired intake interval. For example, a project with roughly 1,070 MRs and 19 Issues can spend about 2,170 requests on one pass, or about 36 hours of quota at 60 requests per hour. Polling remains the default and works for small projects with ample quota. On a quota-constrained first install, prepare the token and proxy before enabling the GitLab Source, then save it with webhook intake enabled so it starts in the chosen mode.

1. Generate a dedicated shared secret, for example with `openssl rand -hex 32`. Store it in `<stateDir>/gitlab-webhook-token`, owned by the DSH user with mode `0600` or read-only mode `0400`. Enter the same value in GitLab's **Secret token** field. This receiver uses `X-Gitlab-Token` over HTTPS. Keep the token out of logs and source control.
2. Use an internal HTTPS reverse proxy that GitLab can reach. Forward only `POST /webhooks/gitlab` to the existing DSH loopback listener. Preserve the request path and GitLab headers. Limit the request body to 256 KiB. Keep the management panel and other DSH paths off this proxy. Have the host administrator allow the receiver port from GitLab through the firewall and verify reachability from the GitLab host. For self-managed GitLab, allowlist the receiver in GitLab's outbound settings if required. For an internal certificate, configure GitLab to trust the issuing CA.
3. Enable **Webhook intake** in Superagent first. In the **GitLab webhook receiver** health entry, resolve any token file error. Then have a project Maintainer create the hook under **Settings → Webhooks**. Select **Issues**, **Merge request events**, and **Comments** and keep SSL verification enabled. This version processes Issue, MR and Issue/MR comment hooks. Pipeline and job hooks can remain unchecked.
4. Create a new Issue or review comment from an allowed account and check that it arrives once. Resend the same delivery from **Recent events** to verify deduplication. Edit a comment with a mention and check that the edit appears only as context.

A supported event returned as HTTP 200 was durably accepted. The receiver health entry shows the last recorded receipt within 14 days. Ignored events returning 204 and duplicate receipts do not advance it. An old timestamp may reflect either inactivity or a delivery problem. Send a new supported event to verify the path from GitLab. If deliveries return 4xx, check the receiver switch, token, proxy path and event configuration before retrying. Re-enable the hook if GitLab disabled it, then replay failed deliveries from **Recent events** and confirm the timestamp advances. Background processing can still be delayed by API errors. The Webhook effect health entry shows backlog and failures, and GitLab's **Recent events** shows HTTP delivery outcomes. After a `429` the webhook consumer and reconciliation share a 30-second cooldown. A failed effect remains queued with exponential backoff.

In Webhook mode the Source reconciles only threads with live tickets, at intervals of at least 15 minutes. Resend failed deliveries from GitLab to recover requests for Issues and MRs that have no ticket yet. If the receiver was unavailable beyond GitLab's delivery history, the requester can send a new comment. To switch back to polling, disable the project hook and allow the webhook queue to drain before changing the Source mode. Configure a single hook for this receiver per project.

### 7. Verify, then run in the background

```sh
curl --fail --silent --show-error -H 'x-orchestrator-request: 1' \
  http://127.0.0.1:3084/orchestrator/api/state
curl --fail --silent --show-error -H 'x-orchestrator-request: 1' \
  http://127.0.0.1:3084/orchestrator/api/sources
```

Expect `setup.problem: null`, runtime and GitLab health `ready`, only the GitLab Source installed/enabled for a fresh GitLab-only profile, and no running or queued work before the test. A model must be usable, not merely named in configuration.

In polling mode, wait for the first successful scan. In webhook mode, verify an accepted delivery as above. Then from an allowed person's account post a **new** Issue/MR or comment mentioning `@<agent username>` with a small, specific task, its required checks and target branch. Ask for an MR without merging it. The first scan establishes a current-time baseline rather than importing all old messages. Edits without a verified editor are context only and cannot authorize new work as the original author; use a new comment for the test. The agent ignores its own messages.

Verify the Ticket, worktree, execution Session, actual checks and MR creation. On a separate human-authored, same-project MR, verify that the initial worktree matches its API `sha` and the delivery branch is separate. Verify that deleting a source branch before Prepare yields a visible failure. Add a new review discussion on the agent's bound MR without mentioning the agent, and verify it reuses the ticket worktree. Check that the agent account can update its own branch while GitLab's protected branch settings restrict writes to shared branches. Then merge manually and verify the Ticket ends as `merged`. Pipeline feedback is context for an existing ticket, not an independent request.

After foreground verification, press Ctrl+C and wait for DSH to exit before starting a background instance:

```sh
tmux new-session -d -s dsh-gitlab-agent -n server 'dsh --profile gitlab-agent --no-open'
tmux attach -t dsh-gitlab-agent
```

Detach with Ctrl+B, then D. Stop by attaching and pressing Ctrl+C; wait for exit before restarting. On hosts where the [service script](#start-and-stop) recognizes DSH, it can instead be used with `--profile gitlab-agent --url http://127.0.0.1:3084`. The macOS Electron-hosted DSH used in integration exposed `ps` decoding and process-name recognition limitations in that script. Use direct startup/tmux and the HTTP checks there; do not enable its automatic recovery until process detection works on your host.

For upgrades, wait for idle, stop gracefully and back up the state directory and dedicated clone. Before resuming existing MR-origin tickets or processing their review comments, audit their worktrees for `refs/dsh-superagent/bases/<ticket-id>`. If a pin is missing, verify the original MR source commit used to create that ticket and confirm it is an ancestor of the registered ticket branch. Record that SHA in the dedicated clone with `git update-ref refs/dsh-superagent/bases/<ticket-id> <verified-sha> ''`. Leave the ticket paused if the original baseline or workspace cannot be verified. Rebuild the checkout with system pnpm, then restart the existing profile with its current user patch. Recheck runtime/GitLab health and existing Ticket state.

| Symptom | Check |
| --- | --- |
| GitLab setup fails | Instance wrapper executable, private nonempty token file and its permissions, `/user` identity/email, pinned HTTPS API host, project path, same-host clone URL and Developer access |
| API reads succeed but a push fails | Token's Git write capability and branch protection; setup does not prove actual delivery |
| Mention produces no Ticket | Correct person's full encoded ID, new message after the first poll, Source enabled, processing not paused |
| GitLab webhook test reports `No route to host` | Check routing from the GitLab host and allow the receiver port through the host firewall for GitLab. Local receiver health cannot detect a firewall rejection. |
| Webhook intake stops while Source health is ready | Check the hook status and last successful delivery under GitLab **Recent events**, then check the proxy access log. Source health reflects reconciliation and queue processing. |
| Existing MR ticket fails to resume or receive review feedback | Verify its linked worktree and audit or restore its original baseline pin using the upgrade steps above. |
| Prepare fails | Clone path, base branch, local credentials/extraheaders and project prerequisites; correct the command before retrying |
| State directory binding fails | Use a new directory for another instance, project or agent identity |
| Management API disappears after unexpected initialization failure | The failed Runtime withdraws its service and cleans resources; fix the cause and restart the main plugin through DSH's Plugin Manager or restart the profile |

One state directory serves one HTTPS instance and one project, including nested groups. Configuring your fork as that project is supported. The provider handles same-project MRs and requires human merge. Polling mode scans paginated project objects and discussions, with subscriptions first. Webhook mode processes supported project events and reconciles active tickets only. Failed reads retain the relevant cursors. Complete real-instance webhook, discussion, push and merge checks on your target installation.
