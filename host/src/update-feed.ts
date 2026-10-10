/**
 * The release feed the app checks for a newer version: GitHub's list of releases, not its "latest"
 * release — the app ships as pre-releases, which "latest" leaves out (it answers 404 until a full
 * release exists). The newest one in the list wins (update-check.ts).
 */
export const UPDATE_FEED = "https://api.github.com/repos/liberuum/knowledge-vault-app/releases?per_page=10";
