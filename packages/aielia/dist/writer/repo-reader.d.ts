import { FolderReader } from './local-folder.js';
/**
 * A repository the writer hands to Write so claims about code can be found in it and verified: a folder on the writer's computer (the same
 * reader as for folder files) or a GitHub repository. Both only list and read; neither writes. A GitHub repository is read through GitHub's
 * own interfaces (the file list from the API, file text from raw.githubusercontent.com), which a browser may call directly. A private
 * repository needs the writer's own token, kept in this browser.
 */
export interface RepoReader extends FolderReader {
    /** The address a file of this repository is stored under as a source (a link for GitHub, `<folder>/<path>` for a folder). */
    addressOf?(path: string): string;
}
export interface GithubRepoSpec {
    owner: string;
    repo: string;
    /** A branch, tag or commit; the repository's default branch when absent. */
    ref?: string;
    /** Only the files under this folder (from an address like github.com/o/r/tree/main/packages/x). */
    path?: string;
}
/** The repository named by a GitHub address (github.com/o/r, with an optional /tree/<ref>), or `o/r`. Anything else is undefined. */
export declare function parseGithubRepoAddress(input: string): GithubRepoSpec | undefined;
export interface GithubReaderOptions {
    fetchImpl?: typeof fetch;
    /** The writer's own GitHub token, for a private repository. Sent only to GitHub. */
    token?: string;
}
export declare function githubRepoReader(spec: GithubRepoSpec, options?: GithubReaderOptions): RepoReader;
/** Several repositories read as one: each file is listed as `<repository name>/<path>`, and reads and addresses are routed back to the repository it came from. */
export declare function combineRepos(readers: readonly RepoReader[]): RepoReader;
