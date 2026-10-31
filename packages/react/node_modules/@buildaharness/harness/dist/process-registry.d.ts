import { ProcessConcept } from './process-concept.js';
export declare class ProcessRegistry {
    private _registry;
    register(conceptId: string, concept: ProcessConcept): void;
    load(conceptId: string): ProcessConcept;
    listAvailable(): string[];
}
export declare function registerAll(registry: ProcessRegistry): void;
export declare const DEFAULT_REGISTRY: ProcessRegistry;
