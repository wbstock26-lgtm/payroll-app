"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { generatePeriods, SUPPORTED_YEARS } from "@/lib/periods";
import { calculateBiweeklyPayroll } from "@/lib/tax-calculator";
import { syncFromServer, LIVE_CUTOFF, SavedEntries } from "@/lib/payroll-store";

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const COMPANY = "2078680 Alberta Ltd.";
const EI_EMPLOYER_RATE = 1.4;
const VAC_RATE = 0.04;

const EMPLOYEES = [
  {
    id: 1, name: "Kim, Woo Jeon", eiExempt: true, defaultHours: 80,
    getRate: (_p: string) => 25.00,
    getDefaultTax: (p: string) => p >= "2026-10-25" ? 246.57 : 265.41,
  },
  {
    id: 2, name: "Jeong, Jae Yeon", eiExempt: true, defaultHours: 80,
    getRate: (_p: string) => 25.00,
    getDefaultTax: (p: string) => p >= "2026-10-25" ? 246.57 : 265.41,
  },
  {
    id: 3, name: "Lee, Sang Yeol", eiExempt: false, defaultHours: 80,
    getRate: (_p: string) => 25.00,
    getDefaultTax: (p: string) => p >= "2026-10-25" ? 239.74 : 257.95,
  },
  {
    id: 4, name: "Nam, Young Gil", eiExempt: false, defaultHours: 75,
    getRate: (p: string) => p >= "2026-06-21" ? 22.63 : 21.63,
    getDefaultTax: (p: string) => p >= "2026-06-21" ? 193.93 : 178.07,
  },
];

const ABSENCES: Record<number, string[]> = { 4: ["2026-09-27"] };

const MONTH_NAMES = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
type EmpRow = {
  periodLabel: string;
  name: string;
  eiExempt: boolean;
  hours: number;
  rate: number;
  regularPay: number;
  vacPay: number;
  overtime: number;
  holidayPay: number;
  otherBenefit: number;
  totalGross: number;
  tax: number;
  cpp: number;
  ei: number;
  totalDed: number;
  netPay: number;
};

type MonthSums = {
  regularPay: number; vacPay: number; totalGross: number;
  tax: number; cpp: number; ei: number; totalDed: number; netPay: number;
};

// ─────────────────────────────────────────────────────────────
// Data computation
// ─────────────────────────────────────────────────────────────
function computeYear(year: number, savedEntries: SavedEntries): Record<number, EmpRow[]> {
  const periods = generatePeriods(year);
  const byMonth: Record<number, EmpRow[]> = {};

  periods.forEach((p) => {
    const month = parseInt(p.end.slice(5, 7));
    if (!byMonth[month]) byMonth[month] = [];

    const isLive = p.start >= LIVE_CUTOFF;
    const saved = savedEntries[p.start];

    EMPLOYEES.forEach((emp) => {
      if (isLive) {
        const s = saved?.[emp.id];
        const hours = s?.regular ?? 0;
        const rate = s?.rate ?? emp.getRate(p.start);
        const regularPay = s?.regularPay ?? 0;
        const holidayPay = s?.holidayPay ?? 0;
        const otherBenefit = s?.otherBenefit ?? 0;
        const vacPay = s?.vacationPay ?? 0;
        const totalGross = s?.totalGross ?? 0;
        const tax = s?.tax ?? 0;
        const cpp = s?.cpp ?? 0;
        const ei = s?.ei ?? 0;
        const totalDed = s?.totalDeduction ?? 0;
        const netPay = s?.netPay ?? 0;
        byMonth[month].push({
          periodLabel: p.label, name: emp.name, eiExempt: emp.eiExempt,
          hours, rate, regularPay, vacPay, overtime: 0,
          holidayPay, otherBenefit, totalGross, tax, cpp, ei, totalDed, netPay,
        });
        return;
      }

      const absent = (ABSENCES[emp.id] ?? []).includes(p.start);
      const hours = absent ? 0 : emp.defaultHours;
      const rate = emp.getRate(p.start);
      const regularPay = Math.round(hours * rate * 100) / 100;
      const holidayPay = 0;
      const otherBenefit = 0;
      const vacPay = Math.round((regularPay + holidayPay) * VAC_RATE * 100) / 100;
      const totalGross = Math.round((regularPay + holidayPay + vacPay + otherBenefit) * 100) / 100;
      const calc = calculateBiweeklyPayroll(totalGross, emp.eiExempt, p.start);
      const tax = totalGross === 0 ? 0 : emp.getDefaultTax(p.start);
      const cpp = calc.cpp;
      const ei = emp.eiExempt ? 0 : calc.ei;
      const totalDed = Math.round((tax + cpp + ei) * 100) / 100;
      const netPay = Math.round((totalGross - totalDed) * 100) / 100;

      byMonth[month].push({
        periodLabel: p.label, name: emp.name, eiExempt: emp.eiExempt,
        hours, rate, regularPay, vacPay, overtime: 0,
        holidayPay, otherBenefit, totalGross, tax, cpp, ei, totalDed, netPay,
      });
    });
  });

  return byMonth;
}

function sumRows(rows: EmpRow[]): MonthSums {
  const s: MonthSums = { regularPay: 0, vacPay: 0, totalGross: 0, tax: 0, cpp: 0, ei: 0, totalDed: 0, netPay: 0 };
  rows.forEach((r) => {
    s.regularPay  += r.regularPay;
    s.vacPay      += r.vacPay;
    s.totalGross  += r.totalGross;
    s.tax         += r.tax;
    s.cpp         += r.cpp;
    s.ei          += r.ei;
    s.totalDed    += r.totalDed;
    s.netPay      += r.netPay;
  });
  (Object.keys(s) as (keyof MonthSums)[]).forEach((k) => {
    s[k] = Math.round(s[k] * 100) / 100;
  });
  return s;
}

// ─────────────────────────────────────────────────────────────
// Excel export — replicates "Payroll 20XX" sheet format
// Uses xlsx-js-style for full border/fill support + SUM formulas
// Cols: A=Period  B=Employee  C=Hours  D=Rate  E=Regular  F=VacPay
//       G=OT  H=Holiday  I=Other  J=TotalGross(blue)
//       K=Tax  L=CPP  M=EI  N=TotalDed  O=NetPay(blue)
// CRA section uses cols D-G
// ─────────────────────────────────────────────────────────────
async function exportAccountantExcel(year: number) {
  // xlsx-js-style supports writing borders/fills; same API as xlsx
  const XLSX = await import("xlsx-js-style" as never) as typeof import("xlsx");

  const byMonth = computeYear(year, await (async () => { try { const r = await fetch("/api/payroll"); return r.ok ? await r.json() : {}; } catch { return {}; } })());
  const months = (Object.keys(byMonth).map(Number)).sort((a, b) => a - b);

  // Excel date serial for the 1st of each month
  const epochOffset = new Date(Date.UTC(1899, 11, 30)).getTime();
  const dateSerial = (y: number, m: number) =>
    Math.round((new Date(Date.UTC(y, m - 1, 1)).getTime() - epochOffset) / 86400000);

  // ── Style definitions (xlsx-js-style nested format)
  const thin = { style: "thin", color: { rgb: "000000" } };
  const BORDER = { top: thin, bottom: thin, left: thin, right: thin };
  const FILL_BLUE  = { fgColor: { rgb: "DCE6F2" }, patternType: "solid" };
  const FILL_MED   = { fgColor: { rgb: "B9CDE5" }, patternType: "solid" };
  const NUM = "#,##0.00";

  type CS = Record<string, unknown>;

  const sHdr  = (fill?: CS): CS => ({ font: { bold: true, sz: 11 }, border: BORDER, alignment: { horizontal: "center", vertical: "center" }, ...(fill ? { fill } : {}) });
  const sHdrL = (): CS => ({ font: { bold: true, sz: 11 }, border: BORDER }); // left-aligned header (Employee col)
  const sDat  = (fill?: CS, bold?: boolean): CS => ({ font: { sz: 11, ...(bold ? { bold: true } : {}) }, border: BORDER, alignment: { horizontal: "right" }, numFmt: NUM, ...(fill ? { fill } : {}) });
  const sTxt  = (fill?: CS, bold?: boolean): CS => ({ font: { sz: 11, ...(bold ? { bold: true } : {}) }, border: BORDER, ...(fill ? { fill } : {}) });
  const sCRA  = (bold?: boolean): CS => ({ font: { sz: 11, ...(bold ? { bold: true } : {}) }, fill: FILL_MED, border: BORDER, alignment: { horizontal: "right" }, numFmt: NUM });
  const sCRAH = (): CS => ({ font: { bold: true, sz: 11 }, fill: FILL_MED, border: BORDER, alignment: { horizontal: "center" } });

  // ── Worksheet builder
  const ws: Record<string, unknown> = {};
  let R = 0; // 0-based row index

  // col index → Excel letter (0=A, 1=B, …)
  const L = (c: number) => String.fromCharCode(65 + c);
  // Excel cell address (1-based for formulas)
  const addr = (r0: number, c: number) => `${L(c)}${r0 + 1}`;

  const put = (r: number, c: number, cell: unknown) => {
    ws[`${L(c)}${r + 1}`] = cell;
  };

  const num = (r: number, c: number, v: number, f?: string, s?: CS) =>
    put(r, c, { t: "n", v, ...(f ? { f } : {}), s: s ?? sDat() });

  const str = (r: number, c: number, v: string, s?: CS) =>
    put(r, c, { t: "s", v, s: s ?? {} });

  for (const month of months) {
    const mRows = byMonth[month];
    const MON   = MONTH_NAMES[month].toUpperCase();
    const sums  = sumRows(mRows);
    const n     = mRows.length;

    // Row offsets within this month block
    const rDate    = R;      // date serial header
    const rComp    = R + 1;  // company name
    const rH1      = R + 2;  // header row 1
    const rH2      = R + 3;  // header row 2
    const rData0   = R + 4;  // first data row (0-based)
    const rDataEnd = R + 4 + n - 1; // last data row (0-based)
    const rGT      = R + 4 + n;     // Grand Total
    const rGross   = R + 4 + n + 2; // GROSS PAYROLL
    const rCRALbl  = R + 4 + n + 4; // PAYABLE TO CRA
    const rCRAHdr  = R + 4 + n + 6; // CPP/EI/TAX header
    const rDed     = R + 4 + n + 7; // Deducted amount
    const rCont    = R + 4 + n + 8; // Company contribution
    const rTotal   = R + 4 + n + 10;// Total

    // Excel 1-based rows for formula references
    const xD0  = rData0  + 1;
    const xDE  = rDataEnd + 1;
    const xGT  = rGT     + 1;
    const xDed = rDed    + 1;
    const xCon = rCont   + 1;

    // ── Date header & company
    put(rDate, 1, { t: "n", v: dateSerial(year, month), s: { font: { bold: true, sz: 11 } } });
    put(rComp, 1, { t: "s", v: COMPANY,                 s: { font: { bold: true, sz: 11 } } });

    // ── Column headers row 1
    str(rH1,  1,  "EMPLOYEE",       sHdrL());
    str(rH1,  2,  "HOURS ",         sHdr());
    str(rH1,  3,  "RATE",           sHdr());
    str(rH1,  4,  "REGULAR ",       sHdr());
    str(rH1,  5,  "VACATION ",      sHdr());
    str(rH1,  6,  "OVER",           sHdr());
    str(rH1,  7,  "HOLIDAY",        sHdr());
    str(rH1,  8,  "OTHER TAXABLE",  sHdr());
    str(rH1,  9,  "TOTAL ",         sHdr(FILL_BLUE));
    str(rH1, 10,  "TAX",            sHdr());
    str(rH1, 11,  "CPP",            sHdr());
    str(rH1, 12,  "EI",             sHdr());
    str(rH1, 13,  "TOTAL",          sHdr());
    str(rH1, 14,  "NET ",           sHdr(FILL_BLUE));

    // ── Column headers row 2
    str(rH2,  4,  "PAY",       sHdr());
    str(rH2,  5,  "PAY ($)",   sHdr());
    str(rH2,  6,  "TIME",      sHdr());
    str(rH2,  7,  "PAY",       sHdr());
    str(rH2,  8,  "BENEFIT",   sHdr());
    str(rH2,  9,  "GROSS",     sHdr(FILL_BLUE));
    str(rH2, 13,  "DEDUCTION", sHdr());
    str(rH2, 14,  "PAY ",      sHdr(FILL_BLUE));

    // ── Data rows with formulas
    mRows.forEach((rd, i) => {
      const r = rData0 + i;
      const xl = r + 1; // Excel row (1-based)
      str(r, 0, rd.periodLabel, sTxt());
      str(r, 1, rd.name,        sTxt());
      num(r, 2,  rd.hours,        undefined,                              sDat());
      num(r, 3,  rd.rate,         undefined,                              sDat());
      num(r, 4,  rd.regularPay,   undefined,                              sDat());
      // F = VacPay = (E+H)*4%
      num(r, 5,  rd.vacPay,       `(${L(4)}${xl}+${L(7)}${xl})*0.04`,   sDat());
      num(r, 6,  rd.overtime,     undefined,                              sDat());
      num(r, 7,  rd.holidayPay,   undefined,                              sDat());
      num(r, 8,  rd.otherBenefit, undefined,                              sDat());
      // J = TotalGross = E+F+G+H+I
      num(r, 9,  rd.totalGross,   `${L(4)}${xl}+${L(5)}${xl}+${L(6)}${xl}+${L(7)}${xl}+${L(8)}${xl}`, sDat(FILL_BLUE));
      num(r, 10, rd.tax,          undefined,                              sDat());
      num(r, 11, rd.cpp,          undefined,                              sDat());
      if (!rd.eiExempt) num(r, 12, rd.ei, undefined,                     sDat());
      // N = TotalDed = K+L+M
      num(r, 13, rd.totalDed,     `${L(10)}${xl}+${L(11)}${xl}+${L(12)}${xl}`, sDat());
      // O = NetPay = J-N
      num(r, 14, rd.netPay,       `${L(9)}${xl}-${L(13)}${xl}`,         sDat(FILL_BLUE));
    });

    // ── Grand Total (SUM formulas)
    str(rGT, 1, "Grand Total ", sTxt(undefined, true));
    num(rGT, 4,  sums.regularPay, `SUM(${L(4)}${xD0}:${L(4)}${xDE})`,  sDat(undefined, true));
    num(rGT, 5,  sums.vacPay,     `SUM(${L(5)}${xD0}:${L(5)}${xDE})`,  sDat(undefined, true));
    num(rGT, 6,  0,               `SUM(${L(6)}${xD0}:${L(6)}${xDE})`,  sDat(undefined, true));
    num(rGT, 7,  0,               `SUM(${L(7)}${xD0}:${L(7)}${xDE})`,  sDat(undefined, true));
    num(rGT, 8,  0,               `SUM(${L(8)}${xD0}:${L(8)}${xDE})`,  sDat(undefined, true));
    num(rGT, 9,  sums.totalGross, `SUM(${L(9)}${xD0}:${L(9)}${xDE})`,  sDat(FILL_BLUE, true));
    num(rGT, 10, sums.tax,        `SUM(${L(10)}${xD0}:${L(10)}${xDE})`,sDat(undefined, true));
    num(rGT, 11, sums.cpp,        `SUM(${L(11)}${xD0}:${L(11)}${xDE})`,sDat(undefined, true));
    num(rGT, 12, sums.ei,         `SUM(${L(12)}${xD0}:${L(12)}${xDE})`,sDat(undefined, true));
    num(rGT, 13, sums.totalDed,   `SUM(${L(13)}${xD0}:${L(13)}${xDE})`,sDat(undefined, true));
    num(rGT, 14, sums.netPay,     `SUM(${L(14)}${xD0}:${L(14)}${xDE})`,sDat(FILL_BLUE, true));

    // ── GROSS PAYROLL (blank row after GT, then this)
    str(rGross, 1, `GROSS PAYROLL FOR ${MON} ${year}`, { font: { bold: true, sz: 11 } });
    num(rGross, 4, sums.totalGross, `${L(9)}${xGT}`, { font: { bold: true, sz: 11 }, numFmt: NUM });

    // ── PAYABLE TO CRA
    str(rCRALbl, 1, `PAYABLE TO CRA FOR ${MON} ${year}`, { font: { bold: true, sz: 11 } });

    // ── CRA header row
    str(rCRAHdr, 3, "CPP",   sCRAH());
    str(rCRAHdr, 4, "EI",    sCRAH());
    str(rCRAHdr, 5, "TAX",   sCRAH());
    str(rCRAHdr, 6, "TOTAL", sCRAH());

    // ── Deducted amount (references Grand Total row)
    str(rDed, 1, "Deducted amount", sTxt());
    num(rDed, 3, sums.cpp,     `${L(11)}${xGT}`,                          sCRA());
    num(rDed, 4, sums.ei,      `${L(12)}${xGT}`,                          sCRA());
    num(rDed, 5, sums.tax,     `${L(10)}${xGT}`,                          sCRA());
    num(rDed, 6, sums.totalDed,`${L(3)}${xDed}+${L(4)}${xDed}+${L(5)}${xDed}`, sCRA());

    // ── Company contribution
    const eiEmp = Math.round(sums.ei * EI_EMPLOYER_RATE * 100) / 100;
    str(rCont, 1, "Company contribution", sTxt());
    num(rCont, 3, sums.cpp, `${L(3)}${xDed}`,                             sCRA());
    num(rCont, 4, eiEmp,    `${L(4)}${xDed}*${EI_EMPLOYER_RATE}`,        sCRA());
    num(rCont, 6, Math.round((sums.cpp + eiEmp) * 100) / 100,
                            `${L(3)}${xCon}+${L(4)}${xCon}`,             sCRA());

    // ── Total
    const craTotal = Math.round((sums.cpp * 2 + sums.ei + eiEmp + sums.tax) * 100) / 100;
    str(rTotal, 1, "Total", sCRA(true));
    num(rTotal, 3, Math.round(sums.cpp * 2 * 100) / 100,
                              `${L(3)}${xDed}+${L(3)}${xCon}`,           sCRA(true));
    num(rTotal, 4, Math.round((sums.ei + eiEmp) * 100) / 100,
                              `${L(4)}${xDed}+${L(4)}${xCon}`,           sCRA(true));
    num(rTotal, 5, sums.tax,  `${L(5)}${xDed}`,                          sCRA(true));
    num(rTotal, 6, craTotal,  `${L(3)}${rTotal + 1}+${L(4)}${rTotal + 1}+${L(5)}${rTotal + 1}`, sCRA(true));

    R = rTotal + 2; // advance past this month block + 1 blank row
  }

  // ── Worksheet range and column widths
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: R - 1, c: 14 } });
  ws["!cols"] = [
    { wch: 17.6 }, // A  Period
    { wch: 34.3 }, // B  Employee
    { wch: 14.1 }, // C  Hours
    { wch: 16.3 }, // D  Rate / CPP
    { wch: 15.0 }, // E  Regular Pay / EI
    { wch: 13.6 }, // F  Vacation Pay / TAX
    { wch: 15.4 }, // G  Overtime / TOTAL
    { wch:  9.1 }, // H  Holiday Pay
    { wch:  9.1 }, // I  Other Benefit
    { wch: 13.1 }, // J  Total Gross (blue)
    { wch: 11.9 }, // K  Tax
    { wch: 11.9 }, // L  CPP
    { wch: 10.0 }, // M  EI
    { wch: 11.9 }, // N  Total Deduction
    { wch: 18.3 }, // O  Net Pay (blue)
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `Payroll ${year}`);
  XLSX.writeFile(wb, `Payroll_${year}_Accountant.xlsx`);
}

// ─────────────────────────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────────────────────────
function fmtN(n: number) {
  return n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ─────────────────────────────────────────────────────────────
// Page Component
// ─────────────────────────────────────────────────────────────
export default function AccountantPage() {
  const [year, setYear] = useState(2026);
  const [exporting, setExporting] = useState(false);
  const [savedEntries, setSavedEntries] = useState<SavedEntries>({});

  useEffect(() => {
    syncFromServer().then(setSavedEntries);
  }, [year]);

  const byMonth = useMemo(() => computeYear(year, savedEntries), [year, savedEntries]);
  const months = useMemo(
    () => (Object.keys(byMonth).map(Number)).sort((a, b) => a - b),
    [byMonth],
  );

  async function handleExport() {
    setExporting(true);
    try {
      await exportAccountantExcel(year);
    } finally {
      setExporting(false);
    }
  }

  // Yearly totals
  const yearTotal = useMemo(() => {
    const all: EmpRow[] = [];
    months.forEach((m) => byMonth[m].forEach((r) => all.push(r)));
    return sumRows(all);
  }, [byMonth, months]);

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-6xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <Link href="/home" className="text-sm text-blue-600 hover:underline">← 홈으로</Link>
            <h1 className="text-2xl font-bold text-gray-900 mt-1">회계사 제출 자료</h1>
            <p className="text-gray-500 text-sm">{COMPANY} · {year}년 연간 급여 요약</p>
          </div>

          {/* Year + Export */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-xl px-3 py-2 shadow-sm">
              <span className="text-sm text-gray-500 font-medium mr-1">연도</span>
              {SUPPORTED_YEARS.map((y) => (
                <button
                  key={y}
                  onClick={() => setYear(y)}
                  className={`px-3 py-1 rounded-lg text-sm font-semibold transition ${
                    year === y ? "bg-blue-600 text-white" : "text-gray-500 hover:bg-gray-100"
                  }`}
                >
                  {y}
                </button>
              ))}
            </div>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="flex items-center gap-2 bg-green-600 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-green-700 transition shadow-sm disabled:opacity-50"
            >
              {exporting ? "생성 중…" : "📥 Excel 다운로드"}
            </button>
          </div>
        </div>

        {/* Year summary card */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {[
            { label: "총 Gross Payroll", val: yearTotal.totalGross, color: "text-blue-700" },
            { label: "총 Tax (직원)",     val: yearTotal.tax,        color: "text-orange-600" },
            { label: "총 CPP (직원)",     val: yearTotal.cpp,        color: "text-purple-600" },
            { label: "총 Net Pay",        val: yearTotal.netPay,     color: "text-green-700" },
          ].map(({ label, val, color }) => (
            <div key={label} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
              <div className="text-xs text-gray-500 mb-1">{label}</div>
              <div className={`text-lg font-bold ${color}`}>${fmtN(val)}</div>
            </div>
          ))}
        </div>

        {/* Monthly breakdown */}
        {months.map((month) => {
          const mRows = byMonth[month];
          const s = sumRows(mRows);
          const eiEmp     = Math.round(s.ei * EI_EMPLOYER_RATE * 100) / 100;
          const empContrib = Math.round((s.cpp + eiEmp) * 100) / 100;
          const craTotal   = Math.round((s.cpp * 2 + s.ei + eiEmp + s.tax) * 100) / 100;

          return (
            <div key={month} className="bg-white rounded-xl shadow-sm border border-gray-100 mb-4 overflow-hidden">
              {/* Month header */}
              <div className="px-4 py-2 bg-blue-50 border-b border-blue-100 flex items-center justify-between">
                <span className="font-semibold text-blue-800 text-sm">
                  {MONTH_NAMES[month]} {year}
                </span>
                <span className="text-xs text-blue-600">
                  Total Gross: <strong>${fmtN(s.totalGross)}</strong>&nbsp;|&nbsp;
                  CRA payable: <strong>${fmtN(craTotal)}</strong>
                </span>
              </div>

              {/* Payroll data table */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-gray-50">
                      <th className="border border-gray-200 px-2 py-1 text-left font-semibold text-gray-600 w-32">Pay Period</th>
                      <th className="border border-gray-200 px-2 py-1 text-left font-semibold text-gray-600 w-36">Employee</th>
                      <th className="border border-gray-200 px-2 py-1 text-right font-semibold text-gray-600">Hours</th>
                      <th className="border border-gray-200 px-2 py-1 text-right font-semibold text-gray-600">Rate</th>
                      <th className="border border-gray-200 px-2 py-1 text-right font-semibold text-gray-600">Regular Pay</th>
                      <th className="border border-gray-200 px-2 py-1 text-right font-semibold text-gray-600">Vac Pay</th>
                      <th className="border border-gray-200 px-2 py-1 text-right font-semibold text-gray-600">Holiday</th>
                      <th className="border border-gray-200 px-2 py-1 text-right font-semibold text-gray-600 bg-blue-50">Total Gross</th>
                      <th className="border border-gray-200 px-2 py-1 text-right font-semibold text-gray-600">Tax</th>
                      <th className="border border-gray-200 px-2 py-1 text-right font-semibold text-gray-600">CPP</th>
                      <th className="border border-gray-200 px-2 py-1 text-right font-semibold text-gray-600">EI</th>
                      <th className="border border-gray-200 px-2 py-1 text-right font-semibold text-gray-600">Total Ded.</th>
                      <th className="border border-gray-200 px-2 py-1 text-right font-semibold text-gray-600 bg-blue-50">Net Pay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mRows.map((rd, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="border border-gray-100 px-2 py-1 text-gray-500">{rd.periodLabel}</td>
                        <td className="border border-gray-100 px-2 py-1 text-gray-800 font-medium">{rd.name}</td>
                        <td className="border border-gray-100 px-2 py-1 text-right text-gray-700">{fmtN(rd.hours)}</td>
                        <td className="border border-gray-100 px-2 py-1 text-right text-gray-700">{fmtN(rd.rate)}</td>
                        <td className="border border-gray-100 px-2 py-1 text-right text-gray-700">{fmtN(rd.regularPay)}</td>
                        <td className="border border-gray-100 px-2 py-1 text-right text-gray-700">{fmtN(rd.vacPay)}</td>
                        <td className="border border-gray-100 px-2 py-1 text-right text-gray-700">{fmtN(rd.holidayPay)}</td>
                        <td className="border border-gray-100 px-2 py-1 text-right font-semibold text-blue-700 bg-blue-50">{fmtN(rd.totalGross)}</td>
                        <td className="border border-gray-100 px-2 py-1 text-right text-red-600">{fmtN(rd.tax)}</td>
                        <td className="border border-gray-100 px-2 py-1 text-right text-red-600">{fmtN(rd.cpp)}</td>
                        <td className="border border-gray-100 px-2 py-1 text-right text-red-600">
                          {rd.eiExempt ? <span className="text-gray-400">—</span> : fmtN(rd.ei)}
                        </td>
                        <td className="border border-gray-100 px-2 py-1 text-right font-semibold text-red-700">{fmtN(rd.totalDed)}</td>
                        <td className="border border-gray-100 px-2 py-1 text-right font-semibold text-green-700 bg-blue-50">{fmtN(rd.netPay)}</td>
                      </tr>
                    ))}

                    {/* Grand Total row */}
                    <tr className="bg-gray-100 font-semibold">
                      <td className="border border-gray-200 px-2 py-1 text-gray-500" colSpan={4}></td>
                      <td className="border border-gray-200 px-2 py-1 text-right text-gray-800">{fmtN(s.regularPay)}</td>
                      <td className="border border-gray-200 px-2 py-1 text-right text-gray-800">{fmtN(s.vacPay)}</td>
                      <td className="border border-gray-200 px-2 py-1 text-right text-gray-800">0.00</td>
                      <td className="border border-gray-200 px-2 py-1 text-right text-blue-700 bg-blue-100">{fmtN(s.totalGross)}</td>
                      <td className="border border-gray-200 px-2 py-1 text-right text-red-600">{fmtN(s.tax)}</td>
                      <td className="border border-gray-200 px-2 py-1 text-right text-red-600">{fmtN(s.cpp)}</td>
                      <td className="border border-gray-200 px-2 py-1 text-right text-red-600">{fmtN(s.ei)}</td>
                      <td className="border border-gray-200 px-2 py-1 text-right text-red-700">{fmtN(s.totalDed)}</td>
                      <td className="border border-gray-200 px-2 py-1 text-right text-green-700 bg-blue-100">{fmtN(s.netPay)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* CRA payable section */}
              <div className="px-4 py-3 bg-gray-50 border-t border-gray-100">
                <div className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">
                  Payable to CRA — {MONTH_NAMES[month]} {year}
                </div>
                <div className="overflow-x-auto">
                  <table className="text-xs">
                    <thead>
                      <tr>
                        <th className="w-40 text-left text-gray-500 font-medium pb-1"></th>
                        <th className="w-24 text-right text-gray-600 font-semibold pb-1 px-3">CPP</th>
                        <th className="w-24 text-right text-gray-600 font-semibold pb-1 px-3">EI</th>
                        <th className="w-24 text-right text-gray-600 font-semibold pb-1 px-3">TAX</th>
                        <th className="w-28 text-right text-gray-800 font-bold pb-1 px-3">TOTAL</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="text-gray-600 py-0.5">Deducted (employee)</td>
                        <td className="text-right px-3 text-gray-700">${fmtN(s.cpp)}</td>
                        <td className="text-right px-3 text-gray-700">${fmtN(s.ei)}</td>
                        <td className="text-right px-3 text-gray-700">${fmtN(s.tax)}</td>
                        <td className="text-right px-3 font-semibold text-gray-800">${fmtN(s.totalDed)}</td>
                      </tr>
                      <tr>
                        <td className="text-gray-600 py-0.5">Company contribution</td>
                        <td className="text-right px-3 text-gray-700">${fmtN(s.cpp)}</td>
                        <td className="text-right px-3 text-gray-700">${fmtN(eiEmp)}</td>
                        <td className="text-right px-3 text-gray-400">—</td>
                        <td className="text-right px-3 font-semibold text-gray-800">${fmtN(empContrib)}</td>
                      </tr>
                      <tr className="border-t border-gray-200 font-bold">
                        <td className="text-gray-800 pt-1">Total payable to CRA</td>
                        <td className="text-right px-3 pt-1 text-blue-700">${fmtN(Math.round(s.cpp * 2 * 100) / 100)}</td>
                        <td className="text-right px-3 pt-1 text-blue-700">${fmtN(Math.round((s.ei + eiEmp) * 100) / 100)}</td>
                        <td className="text-right px-3 pt-1 text-blue-700">${fmtN(s.tax)}</td>
                        <td className="text-right px-3 pt-1 text-blue-800 text-sm">${fmtN(craTotal)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          );
        })}

        <p className="mt-4 text-xs text-gray-400 text-center">
          CRA 2025–{year} 기준. EI 고용주 분담금 = 직원 EI × 1.4. CPP 고용주 분담금 = 직원 CPP 동일.
        </p>
      </div>
    </main>
  );
}
