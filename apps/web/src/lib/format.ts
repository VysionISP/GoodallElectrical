/** Never render a missing financial figure as $0 -- section 30 of the brief. */
export function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "Not available";
  return n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
}

export function percent(n: number | null | undefined): string {
  if (n === null || n === undefined) return "Not available";
  return `${n.toFixed(1)}%`;
}

export function provenanceLabel(source: string | undefined): string {
  switch (source) {
    case "fergus":
      return "LIVE FROM FERGUS";
    case "xero":
      return "LIVE FROM XERO";
    case "owner_provided":
      return "OWNER PROVIDED";
    case "ai_inferred":
      return "AI INFERRED";
    default:
      return "";
  }
}
