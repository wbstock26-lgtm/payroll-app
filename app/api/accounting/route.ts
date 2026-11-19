import { NextResponse } from "next/server";

const ACCOUNTING_URL = "http://127.0.0.1:8765";

// POST /api/accounting — proxy an entry to the accounting website
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { accountId, ...entry } = body as { accountId: number } & Record<string, unknown>;

    const res = await fetch(`${ACCOUNTING_URL}/api/accounts/${accountId}/entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    return NextResponse.json({ ok: false, detail: String(e) }, { status: 502 });
  }
}
