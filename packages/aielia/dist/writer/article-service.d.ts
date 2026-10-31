import { SectionChange } from './article-change-summary.js';
import { ILLMClient, TokenUsage } from '@buildaharness/runtime';
import { ExtractionResult } from './article-claims.js';
import { ArticleBundle, ArticleFolder } from './article-folder.js';
import { Claim, Idea, Source, Brief, StyleProfile } from './article-model.js';
import { ResolveResult, SourceImpact } from './article-resolver.js';
import { IssueCategory } from './article-issues.js';
import { IdeaSuggestion } from './article-ideas.js';
import { SourceLinkProposal, TextRange } from './article-source-links.js';
import { DependencyKind, DependencyProposal } from './article-dependencies.js';
import { ChatTurn } from './writer-chat-history.js';
import { ChangeSummary, VersionComparison } from './article-history.js';
import { Problem, Readiness, Snapshot } from './article-rules.js';
import { EditSuggestResult } from './article-edit-suggest.js';
import { VerifyEntry, VerifyReport } from './article-verify.js';
import { FolderReader } from './local-folder.js';
import { RepoReader } from './repo-reader.js';
import { LoopStep } from './repo-verify-loop.js';
import { ConsistencyResult } from './article-consistency.js';
import { LineRange } from './article-sources.js';
import { SupportCheck } from './article-support.js';
import { WriterChatPort } from './writer-chat-turn.js';
import { ArticleRef } from './writer-chat-state.js';
/**
 * The article service: the operations the /write page and the terminal runner need, built from the pure pieces. Storage is
 * a port (the browser supplies IndexedDB, tests and the runner an in-memory store). The model clients are injected.
 */
export interface ArticleStore {
    list(): Promise<ArticleRef[]>;
    load(id: string): Promise<ArticleBundle | undefined>;
    save(id: string, bundle: ArticleBundle): Promise<void>;
    remove(id: string): Promise<void>;
    getSetting(key: string): Promise<unknown>;
    setSetting(key: string, value: unknown): Promise<void>;
    /** Deletes every article and every setting this store holds. Optional: a store that cannot do it leaves the host to remove the articles one by one. */
    clearAll?(): Promise<void>;
}
export declare function createMemoryArticleStore(): ArticleStore;
/** The phases of a chat edit or draft after the version is saved: the model is asked, then the result is applied (with a short note of how much). */
export type ChatStageListener = (stage: 'asking' | 'applying', detail?: string) => void;
export interface ArticleServiceOptions {
    store: ArticleStore;
    llm: ILLMClient;
    /** Model for every call when `modelFor` is not given. */
    model?: string;
    /** The model for each role, read at call time so the writer can change it between calls: the writer model drafts edit suggestions; the checker model runs claim extraction, support checks, link finding and the effects check. */
    modelFor?: (role: 'writer' | 'checker') => string | undefined;
    /** The name stored with a check result ("which model ran it"); defaults to the checker model. */
    modelName?: string;
    /** Reads a web page as plain text. Absent where the browser cannot reach pages (no proxy and no desktop shell); links are then stored without a passage and the writer pastes it. */
    fetchWeb?: (url: string) => Promise<string>;
    /** Searches the web for pages that might back a claim. Absent where no search is set up. */
    searchWeb?: (query: string) => Promise<{
        title: string;
        url: string;
        snippet: string;
    }[]>;
    onUsage?: (usage: TokenUsage) => void;
    now?: () => string;
    newId?: () => string;
}
export interface UpdateOutcome {
    bundle: ArticleBundle;
    changedSectionIds: string[];
    removedSections: string[];
    extraction?: ExtractionResult;
    resolution?: ResolveResult;
    autoChecks: {
        claimId: string;
        status: SupportCheck['status'];
    }[];
    /** The pass over the whole article for conflicts and overreach (one model call); absent when extraction did not run. */
    consistency?: ConsistencyResult;
}
export interface SourceCandidate {
    title: string;
    url: string;
    snippet: string;
}
export interface SourceRecheckReport {
    read: number;
    unchanged: number;
    /** Addresses whose page text differs from what was stored. */
    changed: string[];
    unreachable: string[];
    /** Web sources not read: no page reader here, or past the limit. */
    skipped: number;
}
export interface ResolveReport {
    category: IssueCategory;
    /** How many items the action dealt with. */
    done: number;
    /** One plain sentence saying what happened. */
    note: string;
}
export declare class ArticleService {
    private readonly opts;
    private readonly store;
    private readonly now;
    private readonly newId;
    constructor(opts: ArticleServiceOptions);
    private checker;
    private writer;
    list(): Promise<ArticleRef[]>;
    get(id: string): Promise<ArticleBundle>;
    create(title: string, markdown?: string): Promise<string>;
    /** The short name the writer files the article under. It does not change the text or the title. */
    rename(id: string, name: string): Promise<void>;
    /**
     * The writer's text changed. Structure first (no model): re-anchor sections and refresh suggestions, then save. Then, unless
     * `analyze` is false, the model judgements: extract claims, run the automatic checks on text the model wrote, and judge what
     * the edit means for the other sections. A failed model step leaves its part as it was and is reported in the outcome.
     */
    updateText(id: string, markdown: string, options?: {
        analyze?: boolean;
        model?: string;
    }): Promise<UpdateOutcome>;
    /** Claim extraction and the automatic checks over the whole article: the first pass for a new article, or on request. Model steps that fail are reported and leave their part as it was. */
    analyze(id: string, model?: string): Promise<UpdateOutcome>;
    private extractAndCheck;
    addSource(id: string, input: {
        kind: Source['kind'];
        address?: string;
        passage?: string;
        note?: string;
        lines?: LineRange;
    }): Promise<string>;
    /**
     * Reads a web source's address. First read: the page text becomes the stored passage. Later reads: same text keeps it current;
     * different text is held as `fetchedPassage` (the stored passage and every check stay as they were), the source is marked
     * changed and a model judges which citing claims it touches. The writer accepts the new text with acceptSourceChange.
     */
    readSource(id: string, sourceId: string, modelOverride?: string): Promise<{
        status: 'read' | 'unchanged' | 'changed' | 'unreachable' | 'unavailable' | 'not_a_link';
        impacts: SourceImpact[];
        reason?: string;
    }>;
    private saveSource;
    /** New text for a source: the first text becomes the passage; the same text keeps it current; different text is held until accepted, and a model judges which citing claims it touches. */
    private receiveText;
    /**
     * The writer gives a new version of a file already stored as a source (dropped again). Same text keeps it current; different text is held
     * like a changed page, with the same impact judgement, until the writer accepts it. Without a stored file of that name the file is not matched.
     */
    offerFileVersion(id: string, name: string, text: string, modelOverride?: string): Promise<{
        status: 'read' | 'unchanged' | 'changed' | 'no_match';
        sourceId?: string;
        impacts: SourceImpact[];
    }>;
    /**
     * Pulls a web page (or a repository file, by its GitHub link) in as a new article to edit: the page text becomes the article text, and the address is kept
     * as a source marked as where it came from. Nothing in the text is treated as checked.
     */
    importPage(address: string): Promise<{
        ok: true;
        id: string;
    } | {
        ok: false;
        reason: string;
    }>;
    /** A text, markdown, MDX or HTML file the writer opens to edit becomes a new article (HTML is turned into markdown). */
    importTextFile(name: string, text: string): Promise<{
        ok: true;
        id: string;
    } | {
        ok: false;
        reason: string;
    }>;
    /**
     * Uses a file from a folder the writer allowed: stored as a code or text source under the address `<folder>/<path>`. A file already stored
     * under that address is compared instead, like a new version of a dropped file.
     */
    addFolderFile(id: string, folder: FolderReader, path: string, modelOverride?: string): Promise<{
        status: 'added' | 'read' | 'unchanged' | 'changed' | 'missing' | 'unsupported';
        sourceId?: string;
        impacts: SourceImpact[];
    }>;
    /** Reads again every source stored from this folder, before publishing or when asked. Changed files wait for the writer; files that are gone are reported. */
    recheckFolder(id: string, folder: FolderReader, modelOverride?: string): Promise<{
        unchanged: number;
        changed: string[];
        missing: string[];
    }>;
    /**
     * Keeps only some lines of a source. A source with an address is read again to take them (or to widen them); a dropped file can be narrowed
     * from the text stored, but not widened (drop the file again). The new passage replaces the old one, as an edit by the writer does.
     * `undefined` clears the range.
     */
    setSourceLines(id: string, sourceId: string, range: LineRange | undefined, modelOverride?: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /**
     * Looks for pages that might back a claim: a web search on the claim's own words (no model call). Pages already stored as sources are left out.
     * Nothing is stored until the writer picks one with useSourceCandidate.
     */
    findSourceCandidates(id: string, claimId: string): Promise<{
        status: 'found' | 'unavailable' | 'failed';
        results: SourceCandidate[];
        reason?: string;
    }>;
    /** The writer picks a found page: it is stored as a web source, read, and tied to the claim by a link the writer drew. A model checks it only when asked. */
    useSourceCandidate(id: string, claimId: string, url: string): Promise<{
        ok: boolean;
        reason?: string;
        read: 'read' | 'unreachable' | 'unavailable' | 'not_a_link' | 'unchanged' | 'changed';
    }>;
    /** Reads every web source again (at most 30, one after another). Used before publishing; nothing is blocked, the report says what to look at. */
    recheckSources(id: string, modelOverride?: string): Promise<SourceRecheckReport>;
    /** The writer takes the new text a re-read found: it becomes the stored passage, so checks made on the old text stop counting until run again. */
    acceptSourceChange(id: string, sourceId: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /** The writer ties a claim to a source: a hand-drawn supported_by link, which the assistant can never remove. */
    attachSource(id: string, claimId: string, sourceId: string): Promise<void>;
    checkClaim(id: string, claimId: string, modelOverride?: string): Promise<SupportCheck>;
    /**
     * Verifies factual claims: a claim with sources that have passages is checked against them; a claim with none is searched for (the web search on
     * the claim's own words), the first few pages are read and kept as proposed sources, and one check says whether they back it. If none does, the
     * pages are dropped and the claim records that it was looked for and not backed. Nothing in the text changes. At most `limit` claims per run.
     */
    /** Repositories the writer handed over for this session, per article. Readers hold browser handles and tokens, so they are never stored in the article. */
    private readonly repos;
    /** Hands a repository to the article for verifying claims. The same repository (by name) replaces the earlier reader. */
    attachRepo(id: string, reader: RepoReader): void;
    detachRepo(id: string, name: string): void;
    attachedRepos(id: string): string[];
    verifyClaims(id: string, opts?: {
        claimIds?: string[];
        limit?: number;
        pages?: number;
        model?: string;
        repoOnly?: boolean;
        batchSize?: number;
        maxToolCalls?: number;
        onStep?: (step: LoopStep) => void;
        onProgress?: (done: number, total: number) => void;
        onEntry?: (entry: VerifyEntry) => void;
        shouldStop?: () => boolean;
    }): Promise<VerifyReport>;
    private readonly repoIndexes;
    /** Claims in batches, each checked by a model that can search the first attached repository. Settled claims keep the lines they rest on as code sources and a recorded check. */
    private verifyBySearch;
    private recordSearchResult;
    private verifyOne;
    private setLookup;
    /** A page found by search is tied to the claim by a proposed link, which the writer can confirm or dismiss like any other proposal. */
    private attachProposed;
    /** Removes sources this run added and the links to them; a claim left with none goes back to having no source. */
    private dropFoundSources;
    /** The writer confirms a claim (and may change its kind). A confirmed claim is matched first on re-extraction and never dropped silently. */
    confirmClaim(id: string, claimId: string, kind?: Claim['kind']): Promise<void>;
    /** The assistant turns the writer\'s instruction into suggestions; nothing is applied until the writer accepts. */
    suggest(id: string, instruction: string, modelOverride?: string, refs?: {
        ideaIds?: string[];
        commentIds?: string[];
        sectionIds?: string[];
        focus?: {
            start: number;
            end: number;
        };
        history?: readonly ChatTurn[];
    }, signal?: AbortSignal): Promise<EditSuggestResult>;
    /** The writer asks for the passage under the cursor or selection to be revised: the result is suggested changes inside that passage only. */
    reviseText(id: string, range: TextRange, instruction: string, modelOverride?: string): Promise<EditSuggestResult | {
        status: 'failed';
        reason: string;
    }>;
    /**
     * The chat edits the article itself. The text as it is now is saved as a version first, always, so the edit can be undone from History; then
     * the edit is made, and only the changes this request produced are applied (suggestions waiting from before stay as they are).
     */
    editFromChat(id: string, instruction: string, modelOverride?: string, signal?: AbortSignal, onStage?: ChatStageListener, history?: readonly ChatTurn[]): Promise<ChatEditResult>;
    /**
     * The chat writes the text of an article that has none: a version is saved first (as for any chat edit), then the draft becomes the text.
     * With `nameIt`, the article is also given the name the draft came with (for an article the chat has just made, which has no name of its own yet).
     * With `rewrite`, the model is given the current text and reworks all of it as the instruction says (a change too wide for edits that quote text).
     */
    draftFromChat(id: string, instruction: string, modelOverride?: string, nameIt?: boolean, signal?: AbortSignal, onText?: (markdownSoFar: string) => void, onStage?: ChatStageListener, rewrite?: boolean, history?: readonly ChatTurn[]): Promise<{
        status: 'drafted' | 'failed';
        savedAs: string;
        name?: string;
        reason?: string;
        change?: SectionChange;
    }>;
    /** The same for the outline: saved first, then the headings are reworked (reworded, added, removed, moved) and each section's text follows its heading. */
    editOutlineFromChat(id: string, instruction: string, modelOverride?: string, signal?: AbortSignal, onStage?: ChatStageListener, history?: readonly ChatTurn[]): Promise<OutlineEditResult>;
    /** Accepts a suggestion (optionally with the writer\'s own wording): the Markdown changes, then the usual update runs. */
    acceptSuggestionAndUpdate(id: string, suggestionId: string, edited?: string, options?: {
        analyze?: boolean;
    }): Promise<{
        ok: true;
        outcome: UpdateOutcome;
    } | {
        ok: false;
        reason: string;
    }>;
    rejectSuggestionById(id: string, suggestionId: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /** Only the writer clears a section\'s needs-review (or sets it held / clean). */
    setReview(id: string, sectionId: string, state: 'clean' | 'held' | 'needs_review'): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    setCommentState(id: string, commentId: string, state: 'open' | 'addressed' | 'dismissed'): Promise<void>;
    /** Saves the article as it is now as a named version the writer can come back to. */
    saveVersion(id: string, label?: string): Promise<void>;
    /**
     * A version the page saves by itself (a sentence finished, a section started, the writer moved on to another sentence). The working text is set to
     * `markdown` first so the version's text and its sections agree; nothing is saved when it is the same text as the latest version.
     */
    autosave(id: string, markdown: string): Promise<boolean>;
    /** Every version, newest first, each with what changed since the version before it (the oldest has nothing to compare with). */
    history(id: string): Promise<{
        index: number;
        kind: Snapshot['kind'];
        label?: string;
        at: string;
        readiness: Snapshot['readiness'];
        change: ChangeSummary;
    }[]>;
    /** What the working article has changed since the latest saved version; undefined when nothing was saved yet. */
    changeSinceLastVersion(id: string): Promise<ChangeSummary | undefined>;
    /** What changed between a stored version and the article now (text, claim status, sources, readiness). */
    compareWithCurrent(id: string, index: number): Promise<VersionComparison>;
    getVersion(id: string, index: number): Promise<Snapshot>;
    /**
     * Restoring makes a new working version from an old one and rewrites no history. The present article is saved as a checkpoint first,
     * so nothing is lost. Reviewer comments and the writer's corrections are the record of the conversation, not of the text, so they stay as they are.
     */
    restore(id: string, index: number): Promise<ArticleBundle>;
    /** The assistant reads the whole article and proposes dependencies between sections. Proposals wait for the writer to confirm them. */
    findDependencies(id: string, modelOverride?: string): Promise<DependencyProposal>;
    /**
     * A first style sheet from the article's own text (brief fields and a writing profile), filling only what the writer has not set. One model call.
     * Returns the names of what was filled in; an empty list means there was nothing to add or the call failed.
     */
    deriveStyleFromText(id: string, modelOverride?: string): Promise<{
        status: 'derived' | 'not_derived';
        filled: string[];
        reason?: string;
    }>;
    /** The writer draws a link by hand. */
    addDependency(id: string, from: string, to: string, kind: DependencyKind): Promise<{
        ok: true;
    } | {
        ok: false;
        reason: string;
    }>;
    /** Only the writer confirms a proposed link, or removes any link. */
    confirmDependency(id: string, linkId: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    removeDependency(id: string, linkId: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /** Attaches a stored source to the text in a range (a phrase, a sentence or what is selected), creating a claim for that text if there is none. */
    attachSourceToText(id: string, range: TextRange, sourceId: string): Promise<{
        ok: true;
        claimIds: string[];
        createdClaim: boolean;
    } | {
        ok: false;
        reason: string;
    }>;
    /** A source stored without saying what it is for: the assistant proposes which claims it bears on, and the writer confirms. */
    proposeLinksForSource(id: string, sourceId: string, modelOverride?: string): Promise<SourceLinkProposal>;
    /** The writer removes a source from a claim (the link only; the stored source stays). Proposals and drawn links alike. */
    detachSource(id: string, claimId: string, sourceId: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    addIdea(id: string, input: {
        text: string;
        origin?: Idea['origin'];
        model?: string;
        sectionId?: string;
    }): Promise<{
        ok: true;
        idea: Idea;
    } | {
        ok: false;
        reason: string;
    }>;
    updateIdea(id: string, ideaId: string, patch: {
        text?: string;
        sectionId?: string | null;
        state?: Idea['state'];
    }): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /** The scratchpad: the writer's free notes, kept as one block of text and given to the chat and the assistant as the ideas to draw on. */
    setScratchpad(id: string, text: string): Promise<void>;
    /** Adds a line to the end of the scratchpad (a chat answer worth keeping). */
    appendToScratchpad(id: string, text: string): Promise<void>;
    deleteIdea(id: string, ideaId: string): Promise<void>;
    /** The assistant proposes new ideas from the article, the sources and what the writer asked for. They are added as open ideas, marked with the model. */
    suggestIdeas(id: string, request?: string, modelOverride?: string): Promise<IdeaSuggestion>;
    /** Writes the chosen ideas into the article as suggestions the writer accepts; each idea is marked used when its suggestion is accepted. */
    writeIdeasIn(id: string, ideaIds: string[], instruction?: string, modelOverride?: string): Promise<EditSuggestResult>;
    setBrief(id: string, brief: Brief): Promise<void>;
    /** Saves a profile in the writer's settings (new, or replacing one with the same id). Returns it, or undefined when it has no name. */
    saveProfile(profile: {
        id?: string;
        name: string;
        voice?: string;
        terms?: {
            use: string;
            instead?: string;
        }[];
    }): Promise<StyleProfile | undefined>;
    profiles(): Promise<StyleProfile[]>;
    deleteProfile(profileId: string): Promise<void>;
    /** Gives the article a copy of a saved profile (null removes it). A later edit of the saved profile does not change articles that already use it until the writer applies it again. */
    useProfile(id: string, profileId: string | null): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /** Renames a section by changing its heading line in the text, which is where the heading lives. The section keeps its identity. */
    renameSection(id: string, sectionId: string, heading: string): Promise<{
        ok: true;
    } | {
        ok: false;
        reason: string;
    }>;
    /** The one-line purpose the outline shows under a section. An empty text removes it. */
    setSectionPurpose(id: string, sectionId: string, purpose: string): Promise<void>;
    addComment(id: string, range: TextRange, text: string): Promise<{
        ok: true;
    } | {
        ok: false;
        reason: string;
    }>;
    editComment(id: string, commentId: string, patch: {
        text?: string;
        decision?: string;
    }): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    deleteComment(id: string, commentId: string): Promise<void>;
    editCorrection(id: string, correctionId: string, patch: {
        note?: string;
        supersedes?: string;
    }): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /** Editing a source's passage replaces it as the writer's own new text, so checks made against the old passage stop counting until they are run again. */
    editSource(id: string, sourceId: string, patch: {
        address?: string;
        note?: string;
        passage?: string;
    }): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /** Renames a saved version. A published version is frozen, label included. */
    renameVersion(id: string, index: number, label: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /** Accepts every pending suggestion in one go: one checkpoint first, then from the end of the text to the start so earlier ones keep their place. */
    acceptAllSuggestions(id: string): Promise<{
        accepted: number;
        skipped: number;
    }>;
    /**
     * The one action for each category of issues (see article-issues.ts). Where the answer is a change to the text it is a set of suggestions,
     * never an edit: suggested changes are accepted (all at once) from the "suggestions" category.
     */
    resolveCategory(id: string, category: IssueCategory, options?: {
        model?: string;
    }): Promise<ResolveReport>;
    /** Every category in a sensible order, one action each. It prepares suggestions but does not apply them; `accept` also applies them at the end. */
    resolveAll(id: string, options?: {
        model?: string;
        categories?: IssueCategory[];
        accept?: boolean;
        onProgress?: (done: number, total: number, category: IssueCategory) => void;
        shouldStop?: () => boolean;
    }): Promise<ResolveReport[]>;
    /** The writer changes the replacement text of a waiting suggestion before accepting it. */
    editSuggestion(id: string, suggestionId: string, replacement: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    readiness(bundle: ArticleBundle): {
        readiness: Readiness;
        problems: Problem[];
    };
    /** A dated, frozen snapshot (D4). Publishing is always allowed (D3); the snapshot records the readiness counts at that moment. */
    publish(id: string, label?: string): Promise<ArticleBundle>;
    exportArticle(id: string): Promise<ArticleFolder>;
    /** Imports a folder under its own id. Refuses a folder it cannot read completely, and refuses to overwrite an existing article. */
    importArticle(folder: ArticleFolder): Promise<{
        ok: true;
        id: string;
    } | {
        ok: false;
        reason: string;
    }>;
}
/**
 * The chat-held state port backed by the article store: each article's comments and corrections live in its own
 * metadata (so they travel with an export), the active article and any held items in the store's settings.
 */
export declare function createArticleChatPort(store: ArticleStore): WriterChatPort;
/**
 * The service with each article's calls run one after another. A step reads the article, waits for the model and saves, so two steps on the same
 * article at once would each save from the text they first read and the later save would erase the earlier one (found in pilot P1: three
 * source-link proposals started together left only one set of links). Calls on different articles still run together, and reads never wait.
 * The calls the service makes on itself are not queued again, so a step that calls another cannot wait on itself.
 */
export declare function serializeByArticle<T extends object>(service: T): T;
/** What a chat edit of the text did: the version saved before it, and each change made. */
export interface ChatEditResult {
    status: 'applied' | 'nothing' | 'failed';
    savedAs: string;
    applied: {
        quote: string;
        replacement: string;
    }[];
    /** Changes that no longer fitted the text when they were made. */
    skipped: number;
    /** What the edit did to the outline and to the wording, section by section. */
    change?: SectionChange;
}
export interface OutlineEditResult {
    status: 'applied' | 'nothing' | 'failed';
    savedAs: string;
    before?: string;
    after?: string;
    reason?: string;
    change?: SectionChange;
}
