# SETUP

Instructions for an agent that sets up dsh-superagent with its operator. If you are a person, ask your coding agent to read this file and follow it.

## How to run the setup

The setup follows [docs/000-philosophy.md](docs/000-philosophy.md): it takes as little of the operator's attention as possible.

- **Before the first question,** read only this file and `docs/000-philosophy.md`, and run the probe below once. Read nothing else until every answer is collected.
- **Ask one question per message,** about one thing. Wait for the answer before the next one. Skip a question the probe already answers.
- **Keep each message under 300 words,** unless the operator asks for more. Give each question a recommended answer the operator can accept with one word, and one sentence on why it matters.
- **Do not execute while asking.** Collect every answer, then send one message with the full plan, and execute only after the operator confirms it.
- **Never ask for a secret in the chat.** Steps that need the operator's hands, such as creating an account, signing a CLI in or entering an app secret, go into one message with the exact commands to run in their own terminal.
- **Teach the philosophy through the questions,** one sentence at a time, not as a lecture.

## 1. Probe

First note the repository provider from the operator's request or an existing profile's `repositoryProvider` (`github` when omitted). If neither establishes it, ask once in question 1 below. Do not probe a GitHub login for a GitLab deployment.

Run the shared environment probe from this checkout once, and keep the result to yourself:

```sh
node -v; pnpm -v; git --version; tmux -V; python3 --version; dsh --version
command -v gh
command -v glab
command -v lark-cli
grep -l -E 'id: dsh-superagent\b' "${DSH_HOME:-$HOME/.dsh}"/profiles/*/cordis.patch.yml 2>/dev/null
```

- **Prerequisites:** Node.js 22.19+ or 24+, system pnpm, git 2.32+, tmux, Python 3.8+, and DSH within the `engines.dsh` range of `package.json`. GitHub needs gh 2.48+; GitLab needs glab with `auth git-credential`. A missing one becomes an item of the plan, not a question. DSH also needs a model provider; if the operator has never run DSH with a model, configuring one is an operator step.
- **Operator login:** when the provider is already known, probe only that provider's personal CLI: `gh api user --jq .login` for GitHub, or `glab api --hostname <instance-host> user --jq '{id, username}'` for GitLab when the instance is known. Skip an unavailable login or unresolved instance. Never treat the agent wrapper's identity as the operator. If the provider is established during questions, defer the CLI probe to execution; ask the operator's account in question 5 instead.
- **Existing profile:** a profile with a `dsh-superagent` entry is an earlier setup: ask whether to continue it, keep its configuration, and read Upgrade in `docs/006-deployment.md`.

## 2. Questions

Ask in this order, one per message, following the flow of work in [docs/001-domain.md](docs/001-domain.md): first where Triggers come from, then who may ask for work there, then what the Executor does with a Ticket. Recommendations are in brackets.

**Sources: where requests come from.**

1. **Sources.** Establish GitHub or GitLab only if not already known, then ask separately whether Feishu is also needed. [Use the requested repository provider alone, unless the team works in Feishu.]
2. **Repository.** For GitHub, which github.com repository, as `owner/name`? For GitLab, collect the HTTPS instance origin and project path (including nested groups), skipping facts already supplied. Ask which intake mode to use. Recommend webhooks when a full scan of Issues, MRs and their discussions exceeds the available API budget for the desired intake interval. For a small project with ample quota, polling avoids a receiver deployment. Preserve the mode of an existing profile unless the operator requests a change.
3. **Agent account.** Which dedicated identity and CLI wrapper will the agent use? [A dedicated account, never the operator's own: everything the agent writes appears under this name.] GitLab can use a project-token bot or dedicated user with Developer access or higher. Creating the identity and authenticating its CLI are operator steps.
4. With Feishu: **which chats,** by name? The agent looks up their ids after the bot is configured.

**Policy: who may ask for work.**

5. **On the repository provider.** Which people may ask the agent for work? [Only the operator initially.] GitHub uses logins. GitLab uses the person's numeric ID on the selected instance, encoded as described in the GitLab deployment guide; obtain/verify IDs during execution, not by asking for encoded strings or tokens in chat. A display name does not grant permission.
6. With Feishu: **who may ask in Feishu?** [Everyone in the first chat, kept in sync with its members.]

**Execution: what the agent does with a Ticket.**

7. **Checkout.** Which local clone of the repository should each Ticket check out from? [A new clone under `~/src/<name>`.]
8. **Commit identity.** Who should the agent's commits name as author? [The agent account, so its work is visibly its own.] Another identity, such as the operator's, goes into the Delivery requirements prompt section.
9. **Auto-merge (GitHub only).** Should the agent enable auto-merge on its own pull requests once they are ready and approved? [No: people merge until the agent's pull requests have been right for a while.] The agent never enables it as the agent account, so with yes it needs the GitHub CLI of another account that may merge: ask the operator to sign one in among the operator steps, and name it in Delivery requirements. With no, remove the auto-merge paragraph from Delivery requirements. For GitLab skip this question: a person merges every MR, and no second merge account is needed.

Do not ask about values with a good default; list them in the plan instead:

- GitHub: profile `superagent`, port `3082`, new absolute state directory `<home>/.dsh/state/superagent`; GitLab: profile `gitlab-agent`, port `3084`, new absolute state directory `<home>/.dsh/state/gitlab-agent`. Both use DSH's Web template and remain separate from the operator's working profile;
- an hourly check from the operator's own profile only after the service script is confirmed to recognize the host's DSH process; use direct startup and HTTP checks for the documented macOS Electron limitation;
- branch prefix `agent/`;
- accept mode `observe`, which records proactive work without doing it, and the default rules and prompt sections;
- with Feishu: the bot reads only mentions, and direct messages are on.

## 3. Plan

Send one message, under 300 words: what will be installed, the accounts and CLIs, the settings to save, the operator steps, and the defaults. Ask for one confirmation.

## 4. Execute

1. **Operator steps first.** Read the selected provider's account instructions in `docs/006-deployment.md` (the GitLab walkthrough for GitLab). Write the dedicated CLI wrappers, then send one message with what only the operator can do: create the identity, grant repository access and supply its credentials; with Feishu, create/publish the bot app and enter its secret. Wait for completion. For GitLab, follow the documented per-instance private token-file workflow and wrapper pins (API host, HTTPS/TLS, CI auto-login and keyring); never use agent-side `glab auth login/logout`, reuse another instance's file, or export/delete legacy keyring credentials. The operator enters the token through the documented hidden terminal prompt, never chat or Source settings. Verify GitHub with `<wrapper> api user --jq .login`; verify GitLab with `<wrapper> api --hostname <host> user` and the configured project. For GitLab, obtain allowed people's numeric IDs using their own verified identities and generate the full IDs with the documented command. Only GitHub auto-merge needs a second merge account.
2. **Install and start.** Follow the selected provider's walkthrough. GitHub uses `examples/profile.cordis.patch.yml`; GitLab uses `examples/profile.gitlab.cordis.patch.yml`, a new state directory, `repositoryProvider: gitlab` and the enabled GitLab plugin. Skip cloning this repository: you are in its checkout. Clone the target repository if requested. With an existing profile, skip `--from-default-profile`, which replaces it, and edit its user patch instead of copying over it. Confirm the profile has a usable default model. For GitLab-only setup keep GitHub and Feishu disabled.
3. **Settings.** Save through the existing Management API, preserving unrelated fields in each whole block. For GitHub, save `source:github`, optional `source:feishu`, `policy`, `executor`, then delivery prompts as described in the main walkthrough. For GitLab, save `source:gitlab` with the chosen intake mode. For webhooks, follow the [receiver checklist](docs/006-deployment.md#6-configure-webhook-intake): prepare the token, HTTPS proxy and firewall, enable intake in Superagent, then create and test the GitLab hook. Configure Execution and review GitLab delivery prompts, then save the allowed list in `policy`. This avoids accepting explicit requests before execution setup is ready; `observe` does not block explicit requests. If Feishu is requested, configure it before adding its allowed users. A save with `restarting: true` restarts Superagent: wait for `GET state` to answer again and reread `GET settings` revisions before saving the next block.
4. **Failures.** A refused save names the setup problem in its response body. Find it in the Troubleshooting table of `docs/006-deployment.md`, fix it, and continue. Ask the operator only for what you cannot fix yourself.

## 5. Verify and hand over

Verify the runtime and selected Source are ready with no setup problem. Use the walkthrough's HTTP checks when the service script cannot recognize the host process; otherwise `scripts/dsh-superagent status` with the correct profile/URL exits 0. Configure the hourly check only after process detection works, from the operator's own profile as described in the deployment guide. Then send one message, under 300 words:

- The panel URL, and that the **Superagent** entry in the sidebar is where to look.
- How to try it: from an account on the allowed list, comment `@<agent login> <request>` on an issue in the repository. A Ticket appears on the overview within about a minute.
- Three rules for the operator, from the Responsibility section of `docs/000-philosophy.md`: start narrow, tune for less noise, own what the agent says.
- Where to read more: the numbered documents in `docs/`, in order.

## GitLab alternative

Use [the complete GitLab walkthrough](docs/006-deployment.md#gitlab-repository-provider) and [GitLab-only template](examples/profile.gitlab.cordis.patch.yml), rather than translating the GitHub commands. Set `repositoryProvider: gitlab`, enable `dsh-superagent-gitlab`, and use a new state directory. No GitHub login is required. Keep the existing identity format and permissions; do not automatically add the logged-in account or project members to the allowed list. Validate a new allowed-person mention, an MR discussion follow-up, and Ticket closure after human merge.
