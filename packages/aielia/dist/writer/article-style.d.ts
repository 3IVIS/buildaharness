import { ArticleMeta, StyleProfile } from './article-model.js';
import { SettingsStore } from './write-permissions.js';
declare const BRIEF_FIELDS: readonly ["audience", "purpose", "tone", "length", "notes"];
/** Replaces the article's brief. Empty fields are dropped; an empty brief removes it. */
export declare function setBrief(meta: ArticleMeta, input: Partial<Record<(typeof BRIEF_FIELDS)[number], string | undefined>>): ArticleMeta;
/** Normalises a profile: trims text, drops empty terms and repeats, caps the list. */
export declare function cleanProfile(p: {
    id: string;
    name: string;
    voice?: string;
    terms?: {
        use: string;
        instead?: string;
    }[];
}): StyleProfile | undefined;
/** Gives the article a copy of a profile, or removes it with null. */
export declare function applyProfile(meta: ArticleMeta, profile: StyleProfile | null): ArticleMeta;
/** The plain text the assistant is given, or '' when the writer set neither a brief nor a profile. */
export declare function renderStyleGuide(meta: Pick<ArticleMeta, 'brief' | 'style'>): string;
export declare function loadProfiles(store: SettingsStore): Promise<StyleProfile[]>;
export declare function saveProfile(store: SettingsStore, profile: {
    id?: string;
    name: string;
    voice?: string;
    terms?: {
        use: string;
        instead?: string;
    }[];
}, newId?: () => string): Promise<StyleProfile | undefined>;
export declare function deleteProfile(store: SettingsStore, id: string): Promise<void>;
export {};
