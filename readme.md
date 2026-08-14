# GitHub

Access and edit your GitHub repositories and gists directly from Acode without
cloning or downloading them first.

## Connect your GitHub account

Tap the GitHub icon in Acode's sidebar tab bar, or run **GitHub** from the
command palette. The full GitHub workspace opens with a **Sign in with GitHub**
button on Acode 1.12.3 and newer. Acode displays a short code: copy it, open
GitHub, approve access, and return to Acode. Your repositories and gists then
appear in the workspace.

Acode stores GitHub sessions as an encrypted record in the plugin's local
storage. You can also choose **Use personal access token** from the sign-in or
account view. Existing plaintext tokens remain usable during startup, then are
validated and encrypted after the first successful GitHub request. The old
plaintext value is removed only after the encrypted save succeeds.

Older Acode versions use the original manual token flow. Tap **Use personal
access token** and paste a token when prompted. These versions keep the token in
the same encrypted plugin storage. Create and revoke tokens from
[GitHub's personal access token settings](https://github.com/settings/tokens)
and grant only the repository and gist access you need. Never share a token or
paste it outside the plugin's password prompt.

The encryption prevents casual plaintext inspection. Its key ships with the
plugin and Acode plugins share a WebView, so it does not isolate the session
from other installed plugins. Install only plugins you trust and revoke GitHub
access if the device or plugin environment is compromised.

If access expires or is revoked, tap your avatar in the GitHub workspace or run
**GitHub account** from Acode's command palette and reconnect or replace the
token.

## Get started

1. Tap the GitHub icon in Acode's sidebar tab bar.
2. Tap **Sign in with GitHub** and complete authorization, or use a personal
   access token when that is the available sign-in method.
3. Select the Repositories or Gists tab, then choose an item and its branch or
   file.
4. Continue editing with Acode's normal file browser and editor.

## Work with repositories

Repositories are grouped by owner in the GitHub workspace. Search by owner or
repository name, select a repository, and choose a branch. The default branch
is listed first and the selected branch opens as an Acode folder. On wider
screens, the repository list and branches appear side by side. The command
palette's **Open repository** command provides the same workflow.

You can browse directories, open files, edit text or binary files, create files
and directories, delete content, and save changes back to GitHub. The branch
picker also includes **New branch** for creating a branch from an existing one.

By default, the plugin asks for a commit message whenever a repository change
is saved. You can turn this prompt off with the **Ask for commit message** plugin
setting; the plugin will then use an automatic message for the operation.

## Work with gists

Open the **Gists** tab to open files, create a gist, add files, or delete content.
The **Open gist** command provides the same workflow. Saving the editor writes
the updated content to GitHub. Destructive actions are kept in each item's
overflow menu and always require confirmation.

Use **Delete gist** to remove an entire gist or **Delete gist file** to remove a
single file. Both commands ask you to select the target before deletion.

## Commands

| Command | Purpose |
| --- | --- |
| **GitHub** | Open the full GitHub workspace. |
| **Open repository** | Select a repository and branch, then open it as an Acode folder. |
| **Open gist** | Open an existing gist or create a new gist or gist file. |
| **Delete gist** | Select and permanently delete a gist. |
| **Delete gist file** | Select a gist and permanently delete one of its files. |
| **GitHub account** | Open account controls, reconnect, replace a personal access token, switch account, or sign out. |
| **Clear GitHub cache** | Refresh cached repository and gist lists. |

## Troubleshooting

- If authentication fails, open **GitHub account** and reconnect.
- If the plugin cannot save a session, check that Acode has available storage
  and retry the sign-in or token update.
- If a recently created, renamed, or deleted repository or gist is missing from
  the workspace, tap Refresh or run **Clear GitHub cache**.
- If a private or organization repository is missing, use **Add an
  installation** or **Manage repository access**. Organization policy may
  require an owner to approve the request.
- For organization SAML errors, establish an active GitHub SAML session and
  reconnect.
- Offline errors do not remove a valid account. Reconnect to the network and
  refresh the affected tab.
- If saving fails, verify that the GitHub App has write access and that the
  selected branch is not protected against the requested change.
