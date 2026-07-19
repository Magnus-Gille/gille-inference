export interface Row {
  name: string;
  value: number;
}

export function formatText(rows: Row[]): string {
  return rows.map((r) => `${r.name}: ${r.value}`).join("\n");
}

/** Render rows as JSON. (REFERENCE SOLUTION.) */
export function formatJson(rows: Row[]): string {
  return JSON.stringify(rows);
}
