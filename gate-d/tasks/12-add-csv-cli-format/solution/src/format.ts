export interface Row { name: string; value: number }

export function formatText(rows: Row[]): string {
  return rows.map((row) => `${row.name}: ${row.value}`).join("\n");
}

export function formatCsv(rows: Row[]): string {
  return ["name,value", ...rows.map((row) => `${row.name},${row.value}`)].join("\n");
}
