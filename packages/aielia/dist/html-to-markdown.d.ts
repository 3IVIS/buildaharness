/**
 * HTML to markdown for pulling a page in to edit: no DOM, so it runs in the shared code. It keeps the structure an article has (headings, paragraphs,
 * lists, quotes, code, links, emphasis) and drops what is not the article (scripts, styles, navigation, headers and footers outside the main text,
 * forms, comments). When the page has a <main> or <article>, only that is used. It is a reader, not a parser of every page on the web: odd markup
 * comes out as plain paragraphs.
 */
/** True when the text is an HTML document or fragment (it has a structural tag near its start). */
export declare function looksLikeHtml(text: string): boolean;
export declare function htmlToMarkdown(html: string): string;
/** The page's own title from its <title>, with a trailing site name (after a pipe, dash or colon) removed; undefined when it has none. */
export declare function htmlTitle(html: string): string | undefined;
