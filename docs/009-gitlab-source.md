# 009 GitLab Source (self-hosted)

This document is the implementation plan for a GitLab Source aimed at self-hosted GitLab instances inside an enterprise network. It uses the concepts in [001 Domain model](001-domain.md) and [002 Authorization](002-authorization.md), and the extension points in [007 Architecture](007-architecture.md) and [008 Cookbook](008-cookbook.md).

> **Status: skeleton only.** The code in this change is a runnable Source skeleton with mocked unit tests. It has never been run against a real GitLab instance, because this environment has no access to one. Everything below marked *verify on the instance* is an explicit assumption, not a verified fact.

## Scope of this round

Delivered:

- a Source kind (`gitlab`) with configuration, Policy part, admission rows, Channel, Thread context and execution-environment variables;
- trigger normalization for Issues, merge requests and notes;
- a polling loop with a project cursor and per-Thread note checkpoints;
- a REST API v4 client whose transport is injectable, so tests never touch the network;
- unit tests backed by a fake `GitlabApi` and a fake `fetch`.

Deliberately not delivered in this round:

- setup verification of the bot account, token and project (no `SETUP_FIELDS`, no facts, no `SetupError` codes);
- worker-side GitLab access (pushing branches, opening merge requests);
- webhooks, pipeline/CI triggers, merge-request approvals and discussion-thread replies;
- an end-to-end test against an internal instance.

## 1. Access model

One Source instance watches **one project on one GitLab instance**. This mirrors the GitHub Source, which watches one repository.

| Item | Choice | Reason |
| --- | --- | --- |
| Reads | GitLab REST API v4 over HTTPS | Stable for self-hosted instances, no extra binary on the DSH host, and no dependency on `glab` being installed or configured |
| Identity | A dedicated bot account with a personal access token, or a project access token | A personal account would mix a person's audit trail with the agent's; a dedicated identity can be removed or rotated independently |
| Token storage | `DSH_SUPERAGENT_GITLAB_TOKEN` in the dsh-superagent service environment | Never stored in SQLite settings, never shown in the panel, never copied into prompts, Policy text or worker variables |
| Transport scope | Polling only | No inbound port, no webhook secret, and no GitLab → DSH connectivity requirement in this round |
| Instance URL | `baseUrl` in the Source configuration, e.g. `https://gitlab.example.com` or `https://example.com/gitlab` | Self-hosted instances may live under a path prefix; only `https` is accepted, plus `http` for loopback |
| Project | `project` as `path_with_namespace` | The API address is `/projects/:url-encoded-path`; display names are not stable |

The token is read at call time from the service environment, so rotating it requires a restart but does not require editing settings or re-saving Policy.

## 2. Source interface mapping

The kind follows `SourceKind` in `src/sources/kind.ts`:

| `SourceKind` member | GitLab implementation |
| --- | --- |
| `kind` | `gitlab`; it is the settings block `source:gitlab` and the Policy block `policy.sources.gitlab` |
| `schema`, `fields` | `baseUrl`, `project`, `pollSeconds` (30–3600, default 60), `failuresBeforeError`, and the `observeIssues` / `observeMergeRequests` / `observeNotes` switches |
| `health` | One entry, `gitlab`; `setupPending`, `sourceOff`, `gitlabUnconfigured`, `gitlabTokenUnset` and `pollFailures` are the fixed statuses |
| `scope` | Rows `issues`, `merge_requests`, `comments`; `observed` follows the matching switch |
| `channel` | `sendGitlab` posts a note; `gitlabLink` returns the page |
| `threadContext` | `gitlabThreadContext` reads a note page, the Issue/merge-request description (`root`), and no answered note (`parent` is empty) |
| `find` | `#12` → `gitlab:issue:12`; `!7` → `gitlab:mr:7`; `gitlab:issue:12`, `gitlab:mr:7`; and a `…/-/issues/12` or `…/-/merge_requests/7#note_2` page |
| `policy` | `allowed` usernames, optional `bots`, and the three admission rows |
| `environment` | Five non-secret variables listed in §7 |
| plugin entry | `src/sources/gitlab.ts`, built as `gitlab-watch` and inserted disabled in `cordis.patch.yml` |

The polling loop waits for `ctx.ready`, reads nothing while `ctx.configured()` is false, follows the Source switch, and reports health like the other Source loops.

## 3. Trigger normalization

| Concept | Mapping |
| --- | --- |
| Trigger | One newly opened Issue, one newly opened merge request, or one note |
| Thread | `gitlab:` + `issue:<iid>` or `mr:<iid>`; Issues and merge requests have separate IID sequences, so the kind is part of the id |
| Actor | The GitLab `username`, matched case-insensitively against Policy entries |
| Human | `user.bot !== true` and not the bot's own username |
| Addressed | A `@username` mention of the bot in the Issue/merge-request description or the note body, at a user boundary |
| Channel address | `baseUrl`, `project`, `kind`, `iid`, and the web `url`; a note URL carries `#note_<id>` |
| Receiving scope | `issues`, `merge_requests` or `comments` |

Stable Trigger ids:

| Event | Id |
| --- | --- |
| Issue body | `key('gitlab-issue', project, iid)` |
| Merge request body | `key('gitlab-merge-request', project, iid)` |
| Note | `key('gitlab-note', project, kind, iid, note.id, note.updated_at)` |

Consequences:

- Re-reading the same interval is safe: the Engine answers `duplicate` for a stored id.
- A note edit produces a new Trigger because `updated_at` is part of the id; notes are paged by update time so an edited note is seen without scanning the whole history. An Issue or merge-request edit does not, matching the GitHub Source.
- GitLab system notes ("changed the description", label changes) and the bot's own notes never become Triggers; empty notes are dropped.
- A deleted author is normalized to `ghost`, which can never be on the allowed list.
- The bot's own Issue/merge-request bodies are not received.

Bodies use `title` + blank line + `description`; notes use their body. `meta` carries `project`, `kind`, `iid`, `thread`, `messageId` (`root` or the note id), `noteId` for notes, and `sourceBranch`/`targetBranch` for merge requests.

## 4. Policy and admission rows

`policy.sources.gitlab` holds `allowed` (GitLab usernames), optional `bots`, and the shared `admission` table. The rows are:

| Row id | Scope | `listedUnaddressed` | `unlistedAddressed` | `unlistedUnaddressed` |
| --- | --- | --- | --- | --- |
| `issues` | New Issues | available when `observeIssues` is on | always available | available when `observeIssues` is on |
| `merge_requests` | New merge requests | available when `observeMergeRequests` is on | always available | available when `observeMergeRequests` is on |
| `comments` | Notes on Issues and merge requests | available when `observeNotes` is on | always available | available when `observeNotes` is on |

Defaults, from `ADMISSION_DEFAULTS`: an unaddressed message from a listed sender is an **inferred** candidate where the row makes the cell available; an addressed message from an unlisted sender is **ignored** by default; an unaddressed message from an unlisted sender is **ignored**.

A listed sender who mentions the bot is always **explicit** and needs no cell. An unlisted sender who mentions the bot uses `unlistedAddressed`; raise it to `inferred` or `explicit` to let project members outside the list ask. Notes that do not mention the bot reach an existing Ticket's Thread as follow-ups regardless of the table, as on GitHub.

No pipeline/CI row exists yet. Adding one later is additive: a new row id, an `observePipelines` switch, and a Trigger with no human sender, like the GitHub `ci` row.

## 5. Reply channel

Replies are top-level notes:

- Issue: `POST /projects/:id/issues/:iid/notes`
- Merge request: `POST /projects/:id/merge_requests/:iid/notes`

GitLab notes have no idempotency key, so the Channel appends a hidden marker, `<!-- dsh-superagent:<message id> -->`, and looks for it in the newest notes before posting. A retried send therefore does not duplicate a note.

- `404` → `gone`: the Issue or merge request is deleted, confidential to the token, or otherwise permanently unreachable.
- Every other failure (`401`, `403`, `429`, `5xx`) is thrown and retried by the Outbox with its normal backoff.
- `allowed(address, config)` requires the saved project and instance URL to match the current configuration.
- The Channel does not post inline discussion replies or merge-request approvals. A reply is always a top-level note; this is a known simplification, not a verified product behavior.

## 6. Polling design

Each round:

1. Read `GET /user` to learn the bot's username.
2. Read Issues and merge requests updated since the stored project cursor, newest first, stopping at the first item at or before the cursor. At most 5 pages of 100 items per list.
3. For each item:
   - if it was created inside this interval and its author is not the bot, receive its body Trigger;
   - read its notes newer than that Thread's checkpoint in update order, oldest first, stopping at the first old note; at most 5 pages;
   - receive a note when it mentions the bot, when the matching observation switch is on, or when a Ticket already follows the Thread;
   - move the Thread's note checkpoint forward;
   - update the Thread's label, URL and `pollError`.
4. Move the project cursor to five seconds before the round started (`cursorAt`), so late writes are read again; stable ids deduplicate them.

The first round starts at "now" and reads no history, matching the GitHub Source's observation switches. Cursors live in `KV.gitlab.since` and `KV.gitlab.notes(<thread>)`.

Failure semantics:

- Each Issue, merge request and Thread fails independently; the round continues.
- A round with any failure does **not** move the project cursor. The next round reads the same interval again; Threads whose checkpoints moved are skipped, and stable ids make the re-read harmless.
- A single failed round is silent; `failuresBeforeError` consecutive failures report `pollFailures` on `gitlab`.

Cost: one user read plus the two list reads per round, and one notes read per Issue or merge request updated since the previous round. A quiet project costs a small constant; a very busy project can hit the 5-page cap, which is a known limitation. Webhooks or GitLab's TODOs/notification APIs are the natural optimization in a later round.

## 7. Execution-environment variables

Declared for every enabled Source and computed from the configuration and the originating Trigger. None is a credential.

| Variable | Value |
| --- | --- |
| `DSH_SUPERAGENT_GITLAB_BASE_URL` | The configured instance URL |
| `DSH_SUPERAGENT_GITLAB_PROJECT` | The configured `path_with_namespace` |
| `DSH_SUPERAGENT_GITLAB_KIND` | `issue` or `merge_request` when the Ticket started on GitLab, otherwise empty |
| `DSH_SUPERAGENT_GITLAB_NUMBER` | The IID when the Ticket started on GitLab, otherwise empty |
| `DSH_SUPERAGENT_GITLAB_URL` | The web page of the originating Issue, merge request or note, otherwise empty |

The token is intentionally not a worker variable. Workers need a separate credential path in a later round (for example a `glab` wrapper signed in to the bot account, or a narrow helper that calls the API). Until that exists, a worker can read the project and reason about the request but cannot push a branch or open a merge request on GitLab.

## 8. Configuration and network

Example setting:

```json
{
  "sources": {
    "gitlab": {
      "enabled": true,
      "config": {
        "baseUrl": "https://gitlab.example.com",
        "project": "group/subgroup/project",
        "pollSeconds": 60,
        "failuresBeforeError": 3,
        "observeIssues": false,
        "observeMergeRequests": false,
        "observeNotes": false
      }
    }
  },
  "policy": {
    "sources": {
      "gitlab": {
        "allowed": [{ "id": "alice" }, { "id": "bob" }],
        "admission": {}
      }
    }
  }
}
```

Service environment:

```sh
DSH_SUPERAGENT_GITLAB_TOKEN=...            # bot token; never commit it
NODE_EXTRA_CA_CERTS=/etc/ssl/internal-ca.pem  # when the instance uses an internal CA
NODE_USE_ENV_PROXY=1                       # Node 22.15+/24, when an egress proxy is required
HTTPS_PROXY=http://proxy.example.com:8080
NO_PROXY=gitlab.example.com,localhost
```

Notes:

- TLS verification stays on. Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- The token scope must allow `POST` notes, so `api` (not `read_api`) is required for a read/write deployment.
- GitLab never needs to reach the DSH host in this round; connectivity is one-way, DSH → GitLab on 443.
- Cursors compare ISO timestamps; the DSH host and GitLab should be time-synchronized.
- Confidential Issues and merge requests are read when the token can see them. Filtering them out is an open decision.

## 9. Verification status

Unit tests (`tests/gitlab.spec.ts`) cover translation, scope and admission rows, Thread context, the notes Channel, the REST client's URL/token/pagination/error behavior, polling and cursors, and the plugin entry. The tests use a fake `GitlabApi` and a fake `fetch`; **no test opens a network connection**.

Not verified, and to be checked on the target instance:

- `GET /user` returns the bot user for the chosen token type (personal token versus project access token);
- `PRIVATE-TOKEN` authentication and the `x-next-page` header on the target GitLab version;
- `sort` / `order_by=updated_at` parameters on the notes endpoint (the poll relies on update ordering for edits);
- the `bot` and `system` fields on users and notes;
- the exact mention syntax rendered by the instance's Markdown;
- behavior on more than 500 updated Issues or merge requests in one interval;
- rate limiting and any instance-level API restrictions.

The end-to-end path (token → real project → real note → real reply) is **not** verified.

## 10. Inputs needed from the operator

1. **Instance**: base URL (including any path prefix) and GitLab version.
2. **Bot account**: whether to use a dedicated user or a project access token; its username; the project role (Reporter is enough for reading and notes; Developer is needed later for branches and merge requests); whether it may be mentioned in public project discussions.
3. **Token**: type, scope (`api`), expiry, where it will be stored as `DSH_SUPERAGENT_GITLAB_TOKEN`, and the rotation procedure. A token with the smallest possible project scope is preferred; an administrator or group-wide token is not.
4. **Test project**: `path_with_namespace`, visibility (private/internal/public), whether Issues and merge requests are enabled, one test Issue, one test merge request, and one note that mentions the bot. Also say whether confidential issues or bot-generated notes are expected.
5. **Network**: confirm the DSH host can resolve and reach the instance on 443, whether an internal CA or egress proxy is required, and whether the host's clock is synchronized. No inbound access is needed for polling.
6. **Decisions**:
   - one project per Source instance, or several projects (would need a design change);
   - polling interval and acceptable API load;
   - whether unaddressed Issues, merge requests and notes should be observed and assessed, or only mentions;
   - whether unlisted project members who mention the bot may originate work;
   - whether pipeline/CI triggers and webhooks are wanted in the next round;
   - how workers should act on GitLab (install `glab` with a bot credential, or build a narrow API helper), since this round only reads and replies.

## 11. Phased plan

| Phase | Work |
| --- | --- |
| 1 (this change) | Source skeleton, trigger normalization, Policy rows, notes Channel, execution variables, mocked unit tests, this plan |
| 2 | Real-instance smoke test; setup verification (`SETUP_FIELDS`, facts, `SetupError`); token/account checks; worker-side GitLab access; deployment documentation |
| 3 | Webhooks or notification APIs, pipeline triggers, discussion-thread replies, multi-project support, confidential filtering, rate-limit handling |

## 12. Files in this change

New: `src/sources/gitlab.ts`, `src/sources/gitlab-api.ts`, `src/sources/gitlab-trigger.ts`, `src/sources/gitlab-channel.ts`, `src/sources/gitlab-read.ts`, `tests/gitlab.spec.ts`, this document.

Changed: `src/kv.ts` (two cursor families), `src/sources/host.ts` and `src/client/locales.ts` (two health codes and the Source labels), `tsdown.config.ts`, `package.json`, `cordis.patch.yml`, `docs/007-architecture.md`, `tests/bundle-patch.spec.ts`.
