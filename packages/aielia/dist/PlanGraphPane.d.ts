import { VizNode } from './plan-viz/types.js';
/** Width at which the detail drawer docks to the right instead of being toggled. */
export declare const DRAWER_DOCK_COLUMNS = 120;
export interface PlanGraphPaneProps {
    nodes: readonly VizNode[];
    columns: number;
    rows: number;
    /** False while an approval prompt owns the keyboard: the pane stays drawn but ignores keys. */
    active?: boolean;
    color?: boolean;
    ascii?: boolean;
    onClose: () => void;
}
/**
 * Read-only plan graph pane (plans/plan_visualization_plan.html, R2). Keys: arrows (or [ ]) move along edges and ranks, j/k and PgUp/PgDn scroll the detail drawer,
 * Tab/Shift+Tab walk task order, Enter or d toggles the detail drawer below 120 columns, q or Esc closes.
 * No key edits anything: the plan changes only through the approval gate.
 */
export declare function PlanGraphPane({ nodes, columns, rows, active, color, ascii, onClose }: PlanGraphPaneProps): React.JSX.Element;
