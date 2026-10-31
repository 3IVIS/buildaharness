export interface PlanTask {
    id: string;
    title: string;
    description: string;
    depends_on: string[];
    risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
    abstraction_level: number;
    parallel_write_domains: string[];
}
export interface PlanTemplate {
    name: string;
    version: string;
    success_criteria: string;
    tags: string[];
    tasks: PlanTask[];
    metadata: Record<string, unknown>;
}
export declare function loadTemplate(name: string): PlanTemplate;
export declare function listTemplateNames(): string[];
/**
 * Heuristic: match description keywords to a template name. Always returns a
 * template — falls back to 'problem_solving' on zero keyword hits, exactly like
 * the Python planner agent's pick_template_for_task. Used by buildPlanFromTemplate
 * once a template has already been chosen some other way (e.g. matchTemplateIfConfident).
 */
export declare function pickTemplateForTask(description: string): string;
/**
 * Stricter variant for the planning gate (planning-classifier.ts): returns null on
 * zero keyword hits instead of defaulting to problem_solving. The gate needs "no
 * real match" to be distinguishable from "weakly matched problem_solving" — an
 * always-a-fallback heuristic can't express that distinction.
 */
export declare function matchTemplateIfConfident(description: string): string | null;
