import { ArticleMeta } from './article-model.js';
import { WriterComment } from './writer-chat-state.js';
import { TextRange } from './article-source-links.js';
/**
 * Comments the writer makes on text: highlight a phrase, a sentence, a paragraph or a section, and type. The comment keeps the quoted text; when
 * the article changes it is found again by that quote, and if the text is gone the comment is kept and marked as outdated, never dropped.
 */
export type CommentResult = {
    ok: true;
    meta: ArticleMeta;
    comment: WriterComment;
} | {
    ok: false;
    reason: string;
};
export declare function addCommentOnText(meta: ArticleMeta, markdown: string, range: TextRange, text: string, now: string): CommentResult;
/** Comments whose text overlaps the range. Comments that arrived from chat have no text of their own and are not here. */
export declare function commentsInRange(meta: ArticleMeta, range: TextRange): WriterComment[];
/** Follows each comment's text through an edit; a comment whose text is gone is marked outdated (and keeps its words). */
export declare function refreshComments(meta: ArticleMeta, markdown: string): ArticleMeta;
