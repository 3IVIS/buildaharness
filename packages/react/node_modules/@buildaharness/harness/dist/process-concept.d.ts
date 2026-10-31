import { TaskGraph } from './state/task-graph.js';
export declare class ProcessConceptValidationError extends Error {
    constructor(message: string);
}
export declare class ProcessConceptNotFoundError extends Error {
    constructor(conceptId: string);
}
export type RiskLevelStr = 'LOW' | 'MEDIUM' | 'HIGH';
export type AbstractionLevelStr = 'module' | 'goal' | 'subgoal' | 'function' | 'leaf' | 'statement';
export interface ProcessConceptStep {
    id: string;
    description: string;
    dependsOn: string[];
    riskLevel: RiskLevelStr;
    abstractionLevel: AbstractionLevelStr;
    expectedTools: string[];
    successCriteria: string[];
    strategyHint: string | null;
}
export declare class ProcessConcept {
    id: string;
    name: string;
    description: string;
    successCriteria: string[];
    schemaVersion: string;
    steps: ProcessConceptStep[];
    constructor(data: {
        id: string;
        name: string;
        description: string;
        successCriteria: string[];
        schemaVersion: string;
        steps: ProcessConceptStep[];
    });
    validate(): string[];
    static fromJson(json: Record<string, unknown>): ProcessConcept;
    seedTaskGraph(taskGraph: TaskGraph): void;
}
