import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { backupPayrollDb } from "@/lib/db-backup";
import type { SavedEntries, SavedPeriod } from "@/lib/payroll-store";

// Backups (local prisma/backups + OneDrive) are made by backupPayrollDb() after each save.
const createBackup = backupPayrollDb;

// GET /api/payroll — returns all saved period entries
export async function GET() {
  try {
    const entries = await prisma.payrollEntry.findMany({ orderBy: { periodStart: "asc" } });
    const result: SavedEntries = {};
    for (const e of entries) {
      try { result[e.periodStart] = JSON.parse(e.data) as SavedPeriod; } catch {}
    }
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({}, { status: 500 });
  }
}

// POST /api/payroll — upserts one period's data + auto backup
export async function POST(request: Request) {
  try {
    const { periodStart, data } = (await request.json()) as {
      periodStart: string;
      data: SavedPeriod;
    };
    const dataStr = JSON.stringify(data);
    await prisma.payrollEntry.upsert({
      where: { periodStart },
      update: { data: dataStr },
      create: { periodStart, data: dataStr },
    });
    createBackup();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
