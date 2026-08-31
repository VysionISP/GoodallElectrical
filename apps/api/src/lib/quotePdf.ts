import PDFDocument from "pdfkit";
import { PassThrough } from "node:stream";

export interface QuotePdfItem {
  description: string;
  quantity: number;
  unit: string | null;
  unit_price: number | null;
  unit_cost: number | null;
  category: string;
}

export interface QuotePdfData {
  quote: {
    id: string;
    quote_number: string | null;
    status: string;
    subtotal: number | null;
    gst: number | null;
    total: number | null;
    internal_material_cost: number | null;
    internal_labour_cost: number | null;
    internal_other_cost: number | null;
    internal_total_cost: number | null;
    forecast_gross_profit: number | null;
    forecast_margin: number | null;
    notes: string | null;
    approved_by: string | null;
    approved_at: string | null;
    created_at: string;
  };
  items: QuotePdfItem[];
  customerName: string | null;
  jobTitle: string | null;
}

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "Not available";
  return n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
}

/**
 * Renders a quote as a PDF. `variant: "customer"` is the only version a
 * customer should ever see -- scope, line-item prices, GST, total, terms.
 * It must NEVER include cost price, profit, margin, or internal notes
 * (section 17 of the brief is explicit about this, so this function
 * physically cannot write those fields when variant is "customer" --
 * there's no flag to leak them by mistake, the code path doesn't exist).
 * `variant: "owner"` adds the internal P&L and approval trail on top.
 */
export function renderQuotePdf(data: QuotePdfData, variant: "owner" | "customer"): NodeJS.ReadableStream {
  const doc = new PDFDocument({ margin: 50, size: "A4" });
  const stream = new PassThrough();
  doc.pipe(stream);

  doc.fontSize(20).fillColor("#111").text("Goodall Electrical", { continued: false });
  doc.fontSize(10).fillColor("#555").text("Electrical Contracting");
  doc.moveDown(1.5);

  doc
    .fontSize(16)
    .fillColor("#111")
    .text(variant === "owner" ? "QUOTE (Owner Copy)" : "QUOTE");
  doc.fontSize(10).fillColor("#555").text(`Quote ${data.quote.quote_number ?? data.quote.id}`);
  if (data.customerName) doc.text(`Customer: ${data.customerName}`);
  if (data.jobTitle) doc.text(`Job: ${data.jobTitle}`);
  doc.text(`Date: ${new Date(data.quote.created_at).toLocaleDateString("en-AU")}`);
  doc.moveDown(1);

  doc.fontSize(12).fillColor("#111").text("Line items", { underline: true });
  doc.moveDown(0.5);
  const tableTop = doc.y;
  doc.fontSize(10).fillColor("#333");
  doc.text("Description", 50, tableTop, { width: 250 });
  doc.text("Qty", 300, tableTop, { width: 50 });
  doc.text("Unit price", 350, tableTop, { width: 90 });
  doc.text("Total", 450, tableTop, { width: 90 });
  doc.moveDown(0.5);
  doc
    .moveTo(50, doc.y)
    .lineTo(545, doc.y)
    .strokeColor("#ccc")
    .stroke();
  doc.moveDown(0.3);

  for (const item of data.items) {
    const y = doc.y;
    const lineTotal = item.quantity * (item.unit_price ?? 0);
    doc.text(item.description, 50, y, { width: 250 });
    doc.text(`${item.quantity}${item.unit ? " " + item.unit : ""}`, 300, y, { width: 50 });
    doc.text(money(item.unit_price), 350, y, { width: 90 });
    doc.text(money(lineTotal), 450, y, { width: 90 });
    doc.moveDown(0.6);
  }

  doc.moveDown(0.5);
  doc
    .moveTo(50, doc.y)
    .lineTo(545, doc.y)
    .strokeColor("#ccc")
    .stroke();
  doc.moveDown(0.5);

  doc.fontSize(11).fillColor("#111");
  doc.text(`Subtotal: ${money(data.quote.subtotal)}`, { align: "right" });
  doc.text(`GST: ${money(data.quote.gst)}`, { align: "right" });
  doc.fontSize(13).text(`Total: ${money(data.quote.total)}`, { align: "right" });
  doc.moveDown(1);

  doc.fontSize(9).fillColor("#777").text("Terms: Payment due per agreed terms. Quote valid for 30 days from date above.");

  if (variant === "owner") {
    doc.moveDown(1.5);
    doc.fontSize(12).fillColor("#111").text("Internal P&L (owner only -- never shown to customer)", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#333");
    doc.text(`Material cost: ${money(data.quote.internal_material_cost)}`);
    doc.text(`Labour cost: ${money(data.quote.internal_labour_cost)}`);
    doc.text(`Other cost: ${money(data.quote.internal_other_cost)}`);
    doc.text(`Total cost: ${money(data.quote.internal_total_cost)}`);
    doc.moveDown(0.3);
    doc.fontSize(11).fillColor("#111");
    doc.text(`Forecast gross profit: ${money(data.quote.forecast_gross_profit)}`);
    doc.text(
      `Forecast margin: ${data.quote.forecast_margin !== null && data.quote.forecast_margin !== undefined ? data.quote.forecast_margin.toFixed(1) + "%" : "Not available"}`
    );

    doc.moveDown(1);
    doc.fontSize(12).fillColor("#111").text("Approval", { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#333");
    doc.text(`Status: ${data.quote.status}`);
    if (data.quote.approved_by) {
      doc.text(`Approved by: ${data.quote.approved_by} at ${data.quote.approved_at ? new Date(data.quote.approved_at).toLocaleString("en-AU") : "unknown time"}`);
    } else {
      doc.text("Not yet approved -- this quote cannot be sent to the customer until approved.");
    }
    if (data.quote.notes) {
      doc.moveDown(0.5);
      doc.fontSize(10).fillColor("#333").text(`Notes: ${data.quote.notes}`);
    }
  }

  doc.end();
  return stream;
}
