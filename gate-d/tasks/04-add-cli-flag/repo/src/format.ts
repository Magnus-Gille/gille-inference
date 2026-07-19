export interface Row {
  name: string;
  value: number;
}

/** Render rows as plain text, one "name: value" per line. */
export function formatText(rows: Row[]): string {
  return rows.map((r) => `${r.name}: ${r.value}`).join("\n");
}
