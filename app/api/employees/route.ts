import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { backupPayrollDb } from "@/lib/db-backup";

// Employee list is kept in the payroll database (AppSetting table, key "employees")
// instead of only in the browser, so it survives clearing browser data or switching browsers.
const KEY = "employees";

async function ensureTable() {
  // Same shape as the AppSetting model in prisma/schema.prisma
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "AppSetting" ("key" TEXT NOT NULL PRIMARY KEY, "value" TEXT NOT NULL, "updatedAt" TEXT NOT NULL)`
  );
}

// GET /api/employees → { employees: Employee[] | null }  (null = never saved on the server yet)
export async function GET() {
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(
      `SELECT "value" FROM "AppSetting" WHERE "key" = ?`, KEY
    );
    return NextResponse.json({ employees: rows.length ? JSON.parse(rows[0].value) : null });
  } catch (err) {
    console.error("[employees GET]", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

// PUT /api/employees  body: { employees: Employee[] }
export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { employees?: unknown };
    const list = body.employees;
    if (!Array.isArray(list) || list.some((e) => !e || typeof e !== "object" || typeof (e as { name?: unknown }).name !== "string")) {
      return NextResponse.json({ ok: false, error: "employees must be a list" }, { status: 400 });
    }
    await ensureTable();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES (?, ?, ?)
       ON CONFLICT("key") DO UPDATE SET "value" = excluded."value", "updatedAt" = excluded."updatedAt"`,
      KEY, JSON.stringify(list), new Date().toISOString()
    );
    backupPayrollDb();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[employees PUT]", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
