/**
 * The adjustments a writer can ask for in the chat. The first menu holds a handful of categories; picking one opens a single field whose
 * suggestions are "Aspect: option" pairs (type to filter, or type your own words). Whatever is sent becomes an ordinary chat message.
 * Two kinds, which only change the wording of the instruction: "setting" (how the article should be written: tone, length, audience ...)
 * and "revision" (a one-off action on the text: shorten the introduction, add examples ...).
 * Settings that are not about the text itself live elsewhere (Style tab, Sources tab, the Do actions) and are deliberately not repeated here.
 */
export type ParameterGroup = 'tone' | 'audience' | 'length' | 'structure' | 'seo' | 'sources' | 'promotion' | 'brand' | 'revise';
export type ParameterKind = 'setting' | 'revision';
export interface WriteParameter {
    id: string;
    label: string;
    options: string[];
    group: ParameterGroup;
    kind: ParameterKind;
}
export declare const WRITE_PARAMETERS: WriteParameter[];
export declare function findParameter(id: string): WriteParameter | undefined;
export declare const PARAMETER_GROUPS: {
    id: ParameterGroup;
    label: string;
}[];
/** The suggestions of a category, each one "Aspect: option". */
export declare function adjustmentChoices(group: ParameterGroup): string[];
/** The chat message an adjustment turns into. Any aspect and any value are accepted, listed or not. */
export declare function adjustmentInstruction(aspect: string, value: string, kind: ParameterKind): string;
/**
 * What the writer typed in a category's field. A suggestion ("Tone of voice: Witty", or its aspect with a value of their own) keeps its
 * aspect; any other words are taken as the request itself. `group` is absent for "Something else".
 */
export declare function adjustmentFromText(group: ParameterGroup | undefined, text: string): string;
