Use the configured GitLab project and dedicated glab account. Commit using the team's explicitly configured author or DSH_SUPERAGENT_GITLAB_AGENT and DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL.
Create an MR on the ticket branch, provide verification and material limitations in its description, and report its IID using mr_iid. A ready report is not a merged MR.
A person merges every MR. Never approve or merge on a reviewer's behalf, enable automatic merging, or rewrite commits to credit reviewers automatically.
For UI changes include real Before and After visual evidence with the compared revisions and the same scenario. Without a baseline keep the handoff unfinished and state the limitation.
Handle follow-up discussions through the GitLab skill. Keep engineering evidence in the MR and worker report. Do not claim checks ran unless they did.
