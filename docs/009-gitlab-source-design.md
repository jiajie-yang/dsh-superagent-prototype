# 009 GitLab repository support

This document describes the implemented GitLab adapter and its boundaries. For installation, credentials and allowed-user configuration, follow [006 Deployment](006-deployment.md#gitlab-repository-provider). The component map is in [007 Architecture](007-architecture.md).

## Scope and configuration

A deployment works on one repository provider at a time: GitHub by default, or GitLab with `repositoryProvider: gitlab` in the main plugin configuration. Feishu remains an optional message Source. GitLab supports one HTTPS instance at its domain root, one project (including nested groups), and one dedicated agent identity. People merge every MR.

GitLab's Source configuration contains `baseUrl`, `project`, `cli`, `pollSeconds`, `webhookEnabled` and the three `receiveAll*` switches. It uses the existing `source:gitlab` settings block, revision checks, history and generated Source panel. `baseUrl`, `project` and `cli` changes are probed before saving and trigger a restart. The bundle includes the GitLab plugin disabled by default; the GitLab-only profile template enables it and disables GitHub and Feishu.

The selected repository Source supplies account facts, skills and execution variables. The other repository Source stays inactive even when installed. Engine authorization, Ticket routing and execution remain shared; there is no repository-plugin framework or second settings system.

## State boundaries and GitHub compatibility

A GitLab state directory is bound on its first successful setup to `{provider, instance, projectId, agentId}`. Setup and account-setting saves reject another instance, numeric project ID or agent ID. Changing the wrapper or rotating a token is allowed for the same identity. Project paths can change while the numeric project ID remains the same.

A directory containing unbound repository Ticket, Trigger or Session-prompt history cannot be adopted as GitLab state. GitLab-bound state cannot be opened as GitHub. Use a new state directory rather than migrating old work, subscriptions or pending replies across providers.

GitHub keeps its existing account and repository configuration flow: this feature does not create a fixed GitHub binding or reject otherwise valid GitHub account/repository changes. A GitHub binding left by an earlier development revision is left untouched and does not restrict GitHub configuration. It still prevents that directory from being adopted as GitLab state.

## Credentials and execution

The deployment owns the instance's identity and private token file. Source settings store only an executable wrapper path; tokens do not belong in settings, prompt text, clone URLs or generated worker files. Each service instance has its own wrapper, token file and glab configuration directory.

The documented wrapper loads its token on every invocation and fails before glab for a missing, unreadable or empty file. It clears inherited credential variables and pins the API host, HTTPS, TLS verification and PAT authentication mode. CI auto-login and keyring use are disabled within the wrapper's child process. Initialization, rotation and local removal use the token file, without agent-side `auth login/logout` or automatic migration of existing credentials. Local deletion does not revoke the GitLab token.

Setup checks the agent's numeric user ID, username and email, the project's numeric ID, a same-instance HTTPS clone URL, and Developer access or higher. These checks do not prove an actual push will succeed. Workers use the configured glab shim and the same wrapper through Git's HTTPS credential helper. The Execution prepare command creates a worktree from a dedicated local clone.

These wrappers provide default-path credential separation. Workers have their OS user's permissions; stronger isolation requires a separate OS account or container, as described in the deployment guide.

## Events, authorization and recovery

Thread IDs contain the normalized instance, numeric project ID, object kind and IID. Actor IDs use `encodeURIComponent(baseUrl):numeric-user-id`; usernames are for mention matching, not authorization. The allowed list names the people who may request work, not the agent. A display name grants no permission. Other automated accounts can be listed as candidate bots; their messages do not become explicit human requests.

New Issue/MR bodies and comments become Triggers. The agent's own messages and system notes are ignored. Body and comment edits without a verified editor are context only; the original author is not treated as the editor. MR discussions share the MR Thread and retain a discussion ID for replies.

Polling prioritizes subscriptions, then scans all paginated project Issues/MRs and their discussions. This avoids relying on comment edits advancing the parent's `updated_at`. It costs more API requests than incremental discovery; large-project scan optimization is outside this release.

The first poll persists a current-time baseline before network access. Each object has its own cursor. Failed reads retain the relevant cursors while healthy objects continue; errors remain visible in health. Disabling the Source during a read stops intake and cursor advancement so unread notes can be retried after re-enabling it. Existing subscriptions retain the normal polling window from the shared domain model.

Body snapshots keep a hash, remote update time and monotonic revision. Body intake and observation changes commit in the same synchronous Store transaction, including evaluation scheduling after commit. An observed `A → B → A` produces distinct versions; stale or unchanged snapshots do not replay work. Intermediate edits never seen by polling cannot be reconstructed.

In Webhook mode, the receiver on `POST /webhooks/gitlab` authenticates the project and commits a receipt and a queued effect together. The effect holds routing identifiers and fetches current objects and relevant notes using the Agent's project access. Polling and webhooks share trigger IDs and admission rules. Reconciliation reads only threads with live tickets, and GitLab delivery replay can recover events that missed ingress. See the [deployment guide](006-deployment.md#6-configure-webhook-intake) for setup.

## Replies and MR lifecycle

Replies validate the configured instance/project and preserve the original discussion address. Before sending, the adapter paginates object notes and checks for its own hidden Outbox message marker. This supports retry after a successful POST whose local acknowledgement was lost. It relies on GitLab's read consistency and does not guarantee exactly-once delivery. Authentication/access failures are retained for retry; only HTTP 410 is treated as gone.

Workers report GitLab delivery with `mr_iid`; `pr_number` retains its GitHub meaning. Reports reject a reference for the wrong provider. MR reads happen before the transaction; claiming the MR, recording the report and queuing its notification happen atomically.

An MR must be the originating MR or an agent MR on the Ticket's branch, with both source and target projects equal to the configured project. A branch's last component matches the Ticket's execution name. An MR cannot belong to another active Ticket. Ticket projections include the MR IID and a URL when validated thread metadata provides it.

A ready report keeps an open MR subscribed for follow-up. Merge/close observations call the existing Engine lifecycle interface; they do not bypass unfinished follow-up protection. Terminal notices can return to the original non-GitLab channel. Automatic merge, approval on another person's behalf and cross-project fork execution are excluded.

## CI feedback

Only opened MRs bound to active Tickets produce pipeline feedback. The fingerprint includes pipeline ID, pipeline SHA/status and MR head SHA. An existing pipeline on the first observation establishes a silent baseline. Observing no pipeline also persists a baseline, so the first later pipeline is reported; repeated polls and restarts do not duplicate that observation. A temporary absence does not overwrite an existing pipeline fingerprint.

CI events are context: `human: false`, no actor identity and no explicit request. They reach subscribed active Tickets but cannot authorize new work or resume an ended Ticket. Matching head/pipeline SHAs are labeled as such; merged-result or stale SHA associations remain unverified rather than being guessed.

## Runtime lifecycle

The main plugin publishes its service before asynchronous setup completes so Source plugins can register during initialization. An owned child scope withdraws that service and its dependent Sources on unexpected initialization failure while preserving the outer entry's restart capability.

Shutdown aborts initialization and waits for it to settle before closing the Store, restoring the process environment and releasing the state-directory lock. Initialization checks for unload after awaited setup/Session creation and before starting background work. Expected setup-pending states keep the management panel available for configuration.

## Validation and remaining boundaries

The automated suite covers provider selection, GitLab-only startup with GitHub installed, authorization, snapshots and SQLite restarts, partial polling failures, Source-off races, resource paths, MR ownership/reporting, replies, CI intake and lifecycle cleanup. It also covers GitHub account/repository saves and restart behavior, with and without an older GitHub binding. `pnpm check` runs typechecking, tests and builds.

Development validation on one self-hosted GitLab project exercised a real allowed-person mention, worker checks and push, MR creation, an unmentioned review discussion and reply, current-head pipeline context, manual merge, Ticket completion and same-state restart. Separate live fault injection checked unexpected master-Session initialization failure, resource cleanup and recovery. These runs preceded the upstream commit reorganization; they are evidence for the exercised paths, not a certification of all GitLab installations.

The documented wrapper was additionally checked with glab `1.118.0` against a temporary HTTPS fixture using synthetic credentials: API/MR/discussion operations, Git helper, rotation, expired credentials, API-target/TLS overrides and PAT/OAuth mode separation. Real personal credentials and keyring entries were not used for those checks.

Remaining boundaries:

- GitLab.com and other GitLab server versions have not received the same end-to-end validation; no universal compatibility claim is made.
- Feishu entry and cross-channel terminal delivery are covered by fixtures, not a real Feishu/GitLab integration run.
- Merged-results pipeline SHA handling is covered by fixtures; the real project exercised matching head SHA feedback.
- The first-pipeline-after-no-pipeline repair is covered by Engine/SQLite restart regressions, not an additional remote pipeline scenario.
- Source-off races and special-character repository paths use local regressions.
- Attachment model input, pipeline webhooks, multi-project dispatch, default-branch proactive CI work and automatic merge remain outside scope.
- The service script's macOS Electron process-detection limitations are separate work; the tested deployment uses direct startup/tmux and HTTP health checks.
