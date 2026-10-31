import { ARTICLE_META_VERSION, ArticleMeta } from './article-model.js';
import { Snapshot } from './article-rules.js';
/**
 * The portable form of one article (article-model plan, section 2): a small folder, represented here as a map from
 * path to text so the browser database, an exported folder and the terminal runner all use the same layout.
 *
 *   article.md              the text, ordinary Markdown
 *   article.meta.json       everything else, with its own format version
 *   sources/<id>.txt        stored source passages, kept out of the main metadata file
 *   versions/<n>.json       published snapshots and checkpoints
 *
 * Loading either succeeds completely or refuses with a message naming what could not be read. Nothing is partly loaded.
 */
export type ArticleFolder = Record<string, string>;
export interface ArticleBundle {
    markdown: string;
    meta: ArticleMeta;
    snapshots: Snapshot[];
}
export type FolderLoad = {
    ok: true;
    bundle: ArticleBundle;
} | {
    ok: false;
    reason: string;
};
export declare function serializeArticle(bundle: ArticleBundle): ArticleFolder;
export declare function loadArticleFolder(folder: ArticleFolder): FolderLoad;
export { ARTICLE_META_VERSION };
