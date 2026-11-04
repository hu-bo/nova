import { Table as HeroUITable } from "@heroui/react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/** HeroUI v3 Table compound — re-exported here for ergonomic import paths.
 *
 * The HeroUI Table uses react-aria-components' Collection pattern: a `Table.Body` with `items={array}` and a render-prop callback. Plain `<thead>/<tbody>/<tr>` children inside `<Table.Content>` will not render correctly. Use the collection pattern in callers.
 *
 * Example:
 * ```tsx
 * <Table>
 *   <Table.ScrollContainer>
 *     <Table.Content aria-label="Provider list">
 *       <Table.Header>
 *         <Table.Column isRowHeader>名称</Table.Column>
 *         <Table.Column>协议</Table.Column>
 *       </Table.Header>
 *       <Table.Body items={providers}>
 *         {(item) => (
 *           <Table.Row id={item.id}>
 *             <Table.Cell>{item.name}</Table.Cell>
 *             <Table.Cell>{item.protocol}</Table.Cell>
 *           </Table.Row>
 *         )}
 *       </Table.Body>
 *     </Table.Content>
 *   </Table.ScrollContainer>
 * </Table>
 * ```
 */
export const Table = HeroUITable;
export const TableScrollContainer = HeroUITable.ScrollContainer;
export const TableContent = HeroUITable.Content;
export const TableHeader = HeroUITable.Header;
export const TableColumn = HeroUITable.Column;
export const TableBody = HeroUITable.Body;
export const TableRow = HeroUITable.Row;
export const TableCell = HeroUITable.Cell;

/** Visual frame around a plain HTML table — preserved for backward compat
 * with the existing simple-list tables in the routes. Use this when you
 * don't need the react-aria-components interactive features. */
export function TableFrame({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="table-container"
      className="overflow-x-auto rounded-xl bg-surface text-surface-foreground ring-1 ring-border shadow-[var(--shadow-soft)]"
    >
      {children}
    </div>
  );
}

export const tableHeadClass =
  "bg-surface-secondary text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground";
export const tableCellClass = "px-5 py-4 align-middle text-sm text-muted-foreground";
export const tableRowClass = cn("transition-colors hover:bg-surface-secondary");
