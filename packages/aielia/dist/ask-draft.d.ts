import { AskAnswer, AskQuestion, AskQuestionOption } from '@buildaharness/harness';
/**
 * One question's in-progress answer, shared by the CLI's text prompt and AskQuestionCard.tsx. Kept
 * separate from AskAnswer itself so a user can flip between picking an option and typing free text
 * without losing whichever they touched last; draftToAnswer collapses it to the wire shape.
 */
export interface QuestionDraft {
    selectedLabels: string[];
    editText: string;
    freeText: string;
    /**
     * Only the card sets this: it hides the note field without clearing the text, so `false` means "ignore
     * editText". Left unset (the CLI, which only fills editText through its explicit `e<n>` command), a
     * non-empty editText counts.
     */
    showEdit?: boolean;
}
export declare function emptyDraft(): QuestionDraft;
/** Recommended option(s) first, stable otherwise, so the same question lists its options in the same order on every surface. */
export declare function orderedOptions(question: AskQuestion): AskQuestionOption[];
/** Collapses one question's draft into the wire AskAnswer shape, or null while still unanswered (INV-28). */
export declare function draftToAnswer(questionId: string, draft: QuestionDraft): AskAnswer | null;
