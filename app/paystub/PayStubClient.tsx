"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { generatePeriods, SUPPORTED_YEARS } from "@/lib/periods";
import { calculateBiweeklyPayroll } from "@/lib/tax-calculator";
import { syncFromServer, LIVE_CUTOFF, SavedEntries } from "@/lib/payroll-store";
import { loadEmployeeSins } from "@/lib/employee-store";

// ---------------------------------------------------------------------------
// Employee definitions
// ---------------------------------------------------------------------------
const EMPLOYEES = [
  {
    id: 1, name: "Kim, Woo Jeon", sin: "660 252 867", eiExempt: true, defaultHours: 80,
    getRate: (_p: string) => 25.00,
    getDefaultTax: (p: string) => p >= "2026-10-25" ? 246.57 : 265.41,
  },
  {
    id: 2, name: "Jeong, Jae Yeon", sin: "660 372 434", eiExempt: true, defaultHours: 80,
    getRate: (_p: string) => 25.00,
    getDefaultTax: (p: string) => p >= "2026-10-25" ? 246.57 : 265.41,
  },
  {
    id: 3, name: "Lee, Sang Yeol", sin: "658 318 993", eiExempt: false, defaultHours: 80,
    getRate: (_p: string) => 25.00,
    getDefaultTax: (p: string) => p >= "2026-10-25" ? 239.74 : 257.95,
  },
  {
    id: 4, name: "Nam, Young Gil", sin: "954 661 179", eiExempt: false, defaultHours: 75,
    getRate: (p: string) => p >= "2026-06-21" ? 22.63 : 21.63,
    getDefaultTax: (p: string) => p >= "2026-06-21" ? 193.93 : 178.07,
  },
];

// Nam absent in period starting 2026-09-27 (P21)
const ABSENCES: Record<number, string[]> = { 4: ["2026-09-27"] };
const VAC_RATE = 0.04;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Override = { tax?: number; cpp?: number; ei?: number };
type Overrides = Record<string, Override>; // keyed by period start date

type PeriodRow = {
  n: number; start: string; end: string; label: string;
  hours: number; rate: number;
  regularPay: number; holidayPay: number; otherBenefit: number;
  vacPay: number; totalGross: number;
  tax: number; cpp: number; ei: number; totalDed: number; netPay: number;
  vacEarned: number; vacPaid: number;
};

// ---------------------------------------------------------------------------
// Per-period computation (applies overrides for tax / cpp / ei)
// ---------------------------------------------------------------------------
function computeAllPeriods(empIdx: number, year: number, overrides: Overrides, savedEntries: SavedEntries): PeriodRow[] {
  const emp = EMPLOYEES[empIdx];
  const periods = generatePeriods(year);
  return periods.map((p) => {
    const isLive = p.start >= LIVE_CUTOFF;
    const saved = isLive ? savedEntries[p.start]?.[emp.id] : undefined;

    if (isLive && saved) {
      const vacPay = saved.vacationPay;
      return {
        n: p.n, start: p.start, end: p.end, label: p.label,
        hours: saved.regular, rate: saved.rate,
        regularPay: saved.regularPay, holidayPay: saved.holidayPay,
        otherBenefit: saved.otherBenefit, vacPay, totalGross: saved.totalGross,
        tax: saved.tax, cpp: saved.cpp, ei: saved.ei,
        totalDed: saved.totalDeduction, netPay: saved.netPay,
        vacEarned: vacPay, vacPaid: -vacPay,
      };
    }

    if (isLive) {
      return {
        n: p.n, start: p.start, end: p.end, label: p.label,
        hours: 0, rate: emp.getRate(p.start),
        regularPay: 0, holidayPay: 0, otherBenefit: 0, vacPay: 0, totalGross: 0,
        tax: 0, cpp: 0, ei: 0, totalDed: 0, netPay: 0,
        vacEarned: 0, vacPaid: 0,
      };
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
    const ov = overrides[p.start] ?? {};
    const tax = totalGross === 0 ? 0 : (ov.tax ?? emp.getDefaultTax(p.start));
    const cpp = ov.cpp ?? calc.cpp;
    const ei  = ov.ei  ?? calc.ei;
    const totalDed = Math.round((tax + cpp + ei) * 100) / 100;
    const netPay   = Math.round((totalGross - totalDed) * 100) / 100;

    return {
      n: p.n, start: p.start, end: p.end, label: p.label,
      hours, rate, regularPay, holidayPay, otherBenefit, vacPay, totalGross,
      tax, cpp, ei, totalDed, netPay,
      vacEarned: vacPay, vacPaid: -vacPay,
    };
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const dtLong = (d: string) =>
  new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function fmtN(n: number): string {
  return n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmt(n: number): string { return fmtN(n); }
function fmtCol(end: string): string { return end.slice(5, 10); }
function sumArr(arr: number[]): number {
  return Math.round(arr.reduce((a, b) => a + b, 0) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Excel export — matches Test.xlsx layout with formulas
// Columns: A=Desc  B=CurHrs  C=CurRate  D=CurAmt  E=spacer
//          F=YtdHrs  G=YtdRate  H=YtdAmt  I=spacer  J=spacer  K+=periods
// ---------------------------------------------------------------------------
async function exportToExcel(emp: typeof EMPLOYEES[0], rows: PeriodRow[], thru: number, year: number) {
  // xlsx-js-style supports writing borders/fills
  const XLSX = await import("xlsx-js-style" as never) as typeof import("xlsx");
  const visible = rows.slice(0, thru);
  const cur = rows[thru - 1];

  const pEnd = (end: string) => end.slice(5, 10);

  // 1-based column number → Excel letter (A=1, Z=26, AA=27, ...)
  const colLetter = (n: number): string => {
    let s = "";
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };
  // K = first period column (col 11), LC = last period column
  const KC = colLetter(11);            // "K"
  const LC = colLetter(10 + thru);    // e.g. "AF" for thru=22

  const ytdH       = sumArr(visible.map(r => r.hours));
  const ytdReg     = sumArr(visible.map(r => r.regularPay));
  const ytdHoliday = sumArr(visible.map(r => r.holidayPay));
  const ytdOther   = sumArr(visible.map(r => r.otherBenefit));
  const ytdVac     = sumArr(visible.map(r => r.vacPay));
  const ytdGross   = sumArr(visible.map(r => r.totalGross));
  const ytdTax   = sumArr(visible.map(r => r.tax));
  const ytdCpp   = sumArr(visible.map(r => r.cpp));
  const ytdEi    = sumArr(visible.map(r => r.ei));
  const ytdDed   = sumArr(visible.map(r => r.totalDed));
  const ytdNet   = sumArr(visible.map(r => r.netPay));
  const ytdVE    = sumArr(visible.map(r => r.vacEarned));
  const ytdVP    = sumArr(visible.map(r => r.vacPaid));

  type Cell = string | number;
  const N = thru;
  const blank = (): Cell[] => Array(10 + N).fill("");

  const R = (
    desc: Cell, cH: Cell, cR: Cell, cA: Cell,
    yH: Cell, yR: Cell, yA: Cell,
    cols: Cell[]
  ): Cell[] => [desc, cH, cR, cA, "", yH, yR, yA, "", "", ...cols];

  const data: Cell[][] = [
    // Row 1 : Company name
    ["2078680 Alberta Ltd.", ...Array(9 + N).fill("")],
    blank(), blank(), // 2–3
    // Row 4 : Date + period end-date headers (col K aligns with first period column)
    ["", "", "", "", "", "", "Date: ", dtLong(cur.end), "", "", ...visible.map(r => pEnd(r.end))],
    blank(), blank(), // 5–6
    // Row 7–8 : Employee / SIN
    ["Employee ", "", "", "", "", "", "SIN", "", "", "", ...Array(N).fill("")],
    [emp.name,   "", "", "", "", "", "",    "", "", "", ...Array(N).fill("")],
    blank(), blank(), // 9–10
    // Row 11 : Pay period
    ["Pay period", `${cur.start} ~ ${cur.end}`, ...Array(8 + N).fill("")],
    blank(), // 12
    // Row 13–14 : Column headers
    ["", "", "", "AMOUNT", "", "", "", "YTD AMOUNT", ...Array(2 + N).fill("")],
    ["DESCRIPTION", "HOURS", "RATE", "AMOUNT", "", "HOURS", "RATE", "AMOUNT", "", "", ...Array(N).fill("")],
    // Row 15 : Wage
    R("Wage", cur.hours, cur.rate, cur.regularPay, ytdH, cur.rate, ytdReg, visible.map(r => r.regularPay)),
    // Row 16 : VacPay-Paid Out
    R("VacPay-Paid Out", "", "", cur.vacPay, "", "", ytdVac, visible.map(r => r.vacPay)),
    // Row 17 : Holiday Pay
    R("Holiday Pay", "", "", cur.holidayPay, "", "", ytdHoliday, visible.map(r => r.holidayPay)),
    // Row 18 : Other Benefit
    R("Other Benefit", "", "", cur.otherBenefit, "", "", ytdOther, visible.map(r => r.otherBenefit)),
    // Row 19 : Total Gross
    R("", cur.hours, cur.rate, cur.totalGross, ytdH, "", ytdGross, visible.map(r => r.totalGross)),
    blank(), // 20
    // Row 21 : Taxes section header
    ["Taxes", "", "", "AMOUNT", "", "", "", "YTD AMOUNT", ...Array(2 + N).fill("")],
    // Row 22–24 : Tax / CPP / EI
    R("Federal Income Tax", "", "", cur.tax,  "", "", ytdTax, visible.map(r => r.tax)),
    R("CPP-Employee",       "", "", cur.cpp,  "", "", ytdCpp, visible.map(r => r.cpp)),
    R("EI-Employee", "", "",
      emp.eiExempt ? 0 : cur.ei, "", "",
      emp.eiExempt ? 0 : ytdEi,
      visible.map(r => (emp.eiExempt ? 0 : r.ei) as Cell)),
    // Row 25 : Total Deductions
    R("", "", "", cur.totalDed, "", "", ytdDed, visible.map(r => r.totalDed)),
    blank(), // 26
    // Row 27 : Net Pay
    R("Net Pay", "", "", cur.netPay, "", "", ytdNet, visible.map(r => r.netPay)),
    blank(), // 28
    // Row 29–32 : Vacation section
    ["Vacation pay", ...Array(9 + N).fill("")],
    R("Earned",  "", "", cur.vacEarned, "", "", ytdVE, visible.map(r => r.vacEarned)),
    R("Paid",    "", "", cur.vacPaid,   "", "", ytdVP, visible.map(r => r.vacPaid)),
    R("Balance", "", "", 0,             "", "", 0,     visible.map(() => 0 as Cell)),
  ];

  const ws = XLSX.utils.aoa_to_sheet(data);

  // ── Inject Excel formulas ──────────────────────────────────────────────────
  const rW  = 15; // Wage
  const rV  = 16; // VacPay
  const rOT = 17; // Holiday Pay
  const rH  = 18; // Other Benefit
  const rG  = 19; // Total Gross
  const rTx = 22; // Federal Income Tax
  const rCP = 23; // CPP
  const rEI = 24; // EI
  const rD  = 25; // Total Deductions
  const rN  = 27; // Net Pay
  const rVE = 30; // Vacation Earned
  const rVP = 31; // Vacation Paid
  const rVB = 32; // Vacation Balance

  const setF = (addr: string, f: string, v: number | string) => {
    ws[addr] = { ...(ws[addr] ?? {}), t: typeof v === "number" ? "n" : "s", f, v };
  };

  setF(`D${rW}`, `B${rW}*C${rW}`,                           cur.regularPay);
  setF(`D${rV}`, `(D${rW}+D${rOT})*0.04`,                  cur.vacPay);
  setF(`D${rG}`, `D${rW}+D${rV}+D${rOT}+D${rH}`,           cur.totalGross);
  setF(`D${rD}`, `D${rTx}+D${rCP}+D${rEI}`,                cur.totalDed);
  setF(`D${rN}`, `D${rG}-D${rD}`,                           cur.netPay);
  setF(`D${rVE}`,`D${rW}*0.04`,                             cur.vacEarned);
  setF(`D${rVP}`,`-D${rVE}`,                                cur.vacPaid);
  setF(`D${rVB}`,`D${rVE}+D${rVP}`,                        0);

  const sr = (row: number) => `SUM(${KC}${row}:${LC}${row})`;
  setF(`H${rW}`,  sr(rW),                              ytdReg);
  setF(`H${rV}`,  `(H${rW}+H${rOT})*0.04`,            ytdVac);
  setF(`H${rOT}`, sr(rOT),                             ytdHoliday);
  setF(`H${rH}`,  sr(rH),                              ytdOther);
  setF(`H${rG}`,  `H${rW}+H${rV}+H${rOT}+H${rH}`,    ytdGross);
  setF(`H${rTx}`, sr(rTx),                           ytdTax);
  setF(`H${rCP}`, sr(rCP),                           ytdCpp);
  if (!emp.eiExempt) setF(`H${rEI}`, sr(rEI), ytdEi);
  else ws[`H${rEI}`] = { ...(ws[`H${rEI}`] ?? {}), t: "n", v: 0 };
  setF(`H${rD}`,  `H${rTx}+H${rCP}+H${rEI}`,        ytdDed);
  setF(`H${rN}`,  `H${rG}-H${rD}`,                  ytdNet);
  setF(`H${rVE}`, sr(rVE),                           ytdVE);
  setF(`H${rVP}`, sr(rVP),                           ytdVP);
  setF(`H${rVB}`, `H${rVE}+H${rVP}`,               0);

  const curPeriodRows: [number, number | string][] = [
    [rW,  cur.regularPay], [rV,  cur.vacPay],
    [rOT, cur.holidayPay], [rH,  cur.otherBenefit],
    [rG,  cur.totalGross],
    [rTx, cur.tax],        [rCP, cur.cpp],
    [rD,  cur.totalDed],   [rN,  cur.netPay],
    [rVE, cur.vacEarned],  [rVP, cur.vacPaid],  [rVB, 0],
  ];
  for (const [row, val] of curPeriodRows) {
    setF(`${LC}${row}`, `$D$${row}`, val);
  }
  if (!emp.eiExempt) setF(`${LC}${rEI}`, `$D$${rEI}`, cur.ei);
  else ws[`${LC}${rEI}`] = { ...(ws[`${LC}${rEI}`] ?? {}), t: "n", v: 0 };

  // ── Apply styles (xlsx-js-style nested format) ────────────────────────────
  const thin = { style: "thin", color: { rgb: "000000" } };
  const BORDER = { top: thin, bottom: thin, left: thin, right: thin };
  const NUM = "#,##0.00";

  // Merge style onto existing cell (preserves t/f/v)
  const applyS = (addr: string, s: Record<string, unknown>) => {
    if (ws[addr] && typeof ws[addr] === "object") {
      (ws[addr] as Record<string, unknown>).s = s;
    } else if (!ws[addr] || ws[addr] === "") {
      ws[addr] = { t: "s", v: "", s };
    }
  };

  const sHdr = (center?: boolean): Record<string, unknown> => ({
    font: { bold: true, sz: 10 }, border: BORDER,
    alignment: { horizontal: center ? "center" : "left", vertical: "center" },
  });
  const sNum = (bold?: boolean): Record<string, unknown> => ({
    font: { sz: 10, ...(bold ? { bold: true } : {}) },
    border: BORDER, alignment: { horizontal: "right" }, numFmt: NUM,
  });
  const sTxt = (bold?: boolean): Record<string, unknown> => ({
    font: { sz: 10, ...(bold ? { bold: true } : {}) }, border: BORDER,
  });

  // Header row 14 — description + current cols + YTD cols + period cols
  applyS("A14", sHdr());
  for (const col of ["B", "C", "D", "F", "G", "H"]) applyS(`${col}14`, sHdr(true));
  for (let p = 0; p < thru; p++) applyS(`${colLetter(11 + p)}14`, sHdr(true));

  // Period end-date header row 4 — dates at K..LC (aligned with data columns)
  for (let p = 0; p < thru; p++) applyS(`${colLetter(11 + p)}4`, sHdr(true));

  // Data rows and which are bold (totals)
  const dataRows = [rW, rV, rOT, rH, rG, rTx, rCP, rEI, rD, rN, rVE, rVP, rVB];
  const boldSet  = new Set([rG, rD, rN]);

  for (const r of dataRows) {
    const bold = boldSet.has(r);
    applyS(`A${r}`, sTxt(bold));
    for (const col of ["B", "C", "D"]) applyS(`${col}${r}`, sNum(bold));
    for (const col of ["F", "G", "H"]) applyS(`${col}${r}`, sNum(bold));
    for (let p = 0; p < thru; p++) applyS(`${colLetter(11 + p)}${r}`, sNum(bold));
  }

  // ──────────────────────────────────────────────────────────────────────────
  ws["!cols"] = [
    { wch: 22 }, { wch: 8 }, { wch: 8 }, { wch: 12 },
    { wch: 2 },  { wch: 8 }, { wch: 10 },{ wch: 14 },
    { wch: 2 },  { wch: 2 },
    ...visible.map(() => ({ wch: 10 })),
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Pay Stub");
  XLSX.writeFile(wb, `PayStub-${emp.name.replace(", ", "-")}-${year}-P${thru}.xlsx`);
}

// ---------------------------------------------------------------------------
// Table cell helpers — each renders exactly one <td>
// ---------------------------------------------------------------------------
const tb = "px-2 py-1.5 text-right";

function C({ v, cls, zero }: { v: number; cls?: string; zero?: string }) {
  return <td className={`${tb} ${cls ?? "text-gray-700"}`}>{v === 0 ? (zero ?? "0.00") : fmtN(v)}</td>;
}
function D({ cls }: { cls?: string }) {
  return <td className={`${tb} ${cls ?? "text-gray-400"}`}>-</td>;
}
function Y({ v, bg, cls, bold, zero }: { v: number | string; bg?: string; cls?: string; bold?: boolean; zero?: string }) {
  const text = typeof v === "string" ? v : (v === 0 ? (zero ?? "0.00") : fmtN(v as number));
  return <td className={`${tb} ${bg ?? "bg-gray-50"} ${bold ? "font-semibold" : ""} ${cls ?? ""}`}>{text}</td>;
}

// Editable numeric cell for Tax / CPP / EI overrides
function E({ v, onChange, cls }: { v: number; onChange: (n: number) => void; cls?: string }) {
  return (
    <td className="px-1 py-1 border-l border-gray-100">
      <input
        type="number"
        step="0.01"
        min="0"
        value={v === 0 ? "" : v}
        placeholder="-"
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className={`w-full text-right bg-transparent text-xs border-b border-dashed focus:outline-none focus:border-solid
          [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none
          ${cls ?? "text-red-600 border-red-300 focus:border-red-500"}`}
      />
    </td>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function PayStubClient() {
  const [empIdx, setEmpIdx]       = useState(0);
  const [year, setYear]           = useState(2026);
  const [thru, setThru]           = useState(22);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [sins, setSins]           = useState<Record<string, string>>({});
  const [savedEntries, setSavedEntries] = useState<SavedEntries>({});

  useEffect(() => {
    loadEmployeeSins().then(setSins);   // from the payroll database (browser copy as fallback)
  }, []);

  useEffect(() => {
    syncFromServer().then(setSavedEntries);
  }, [empIdx, year]);

  const allRows = useMemo(() => computeAllPeriods(empIdx, year, overrides, savedEntries), [empIdx, year, overrides, savedEntries]);
  const emp     = EMPLOYEES[empIdx];
  const visible = allRows.slice(0, thru);
  const cur     = allRows[thru - 1];

  const ytd = useMemo(() => ({
    hours:        sumArr(visible.map(r => r.hours)),
    regularPay:   sumArr(visible.map(r => r.regularPay)),
    holidayPay:   sumArr(visible.map(r => r.holidayPay)),
    otherBenefit: sumArr(visible.map(r => r.otherBenefit)),
    vacPay:       sumArr(visible.map(r => r.vacPay)),
    totalGross:   sumArr(visible.map(r => r.totalGross)),
    tax:        sumArr(visible.map(r => r.tax)),
    cpp:        sumArr(visible.map(r => r.cpp)),
    ei:         sumArr(visible.map(r => r.ei)),
    totalDed:   sumArr(visible.map(r => r.totalDed)),
    netPay:     sumArr(visible.map(r => r.netPay)),
    vacEarned:  sumArr(visible.map(r => r.vacEarned)),
    vacPaid:    sumArr(visible.map(r => r.vacPaid)),
  }), [visible]);

  function setOverride(start: string, field: keyof Override, val: number) {
    setOverrides(prev => ({
      ...prev,
      [start]: { ...prev[start], [field]: val },
    }));
  }

  if (!cur) return null;
  const totalCols = 7 + thru;

  return (
    <main className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-full mx-auto">

        {/* Top bar */}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2 print:hidden">
          <div>
            <Link href="/home" className="text-xs text-blue-600 hover:underline">← 홈으로</Link>
            <h1 className="text-xl font-bold text-gray-900 mt-0.5">개인별 급여 명세서</h1>
            <p className="text-gray-400 text-xs">2078680 Alberta Ltd.</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => exportToExcel(emp, allRows, thru, year)}
              className="bg-green-600 text-white px-4 py-1.5 rounded-lg text-xs hover:bg-green-700 font-medium"
            >
              📥 Excel 다운로드
            </button>
            <button
              onClick={() => window.print()}
              className="bg-gray-800 text-white px-3 py-1.5 rounded-lg text-xs hover:bg-gray-700"
            >
              🖨 인쇄
            </button>
          </div>
        </div>

        {/* Controls */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-4 flex flex-wrap gap-5 items-end print:hidden">
          <div>
            <p className="text-xs text-gray-500 mb-1.5 font-medium">직원 선택</p>
            <div className="flex gap-1.5 flex-wrap">
              {EMPLOYEES.map((e, i) => (
                <button key={e.id} onClick={() => { setEmpIdx(i); setOverrides({}); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    empIdx === i ? "bg-blue-600 text-white shadow-sm" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}>
                  {e.name}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1.5 font-medium">연도</p>
            <div className="flex gap-1">
              {SUPPORTED_YEARS.map((y) => (
                <button key={y} onClick={() => { setYear(y); setOverrides({}); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                    year === y ? "bg-blue-600 text-white" : "text-gray-500 hover:bg-gray-100"
                  }`}>
                  {y}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1.5 font-medium">
              표시 기간 — P1 ~ <strong>P{thru}</strong>
              <span className="font-normal text-gray-400 ml-1">({cur.end})</span>
            </p>
            <div className="flex items-center gap-2">
              <input type="range" min={1} max={26} value={thru}
                onChange={(e) => setThru(Number(e.target.value))}
                className="w-36 accent-blue-600" />
              <span className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded font-semibold">P{thru}</span>
            </div>
          </div>
        </div>

        {/* Stub header */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 px-5 py-3 mb-4 flex justify-between flex-wrap gap-2 text-xs print:hidden">
          <div className="space-y-0.5">
            <p className="font-bold text-gray-900 text-sm">2078680 Alberta Ltd.</p>
            <p className="text-gray-600">Employee: <strong>{emp.name}</strong></p>
            <p className="text-gray-500">Pay Period: {cur.start} ~ {cur.end}</p>
          </div>
          <div className="text-right space-y-0.5">
            <p className="text-gray-500">Date: {cur.end}</p>
            {emp.eiExempt && <p className="text-yellow-600 font-medium">* EI Exempt (shareholder-director)</p>}
          </div>
        </div>

        {/* Main table */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto print:hidden">
          <table className="text-xs border-collapse" style={{ minWidth: `${180 + thru * 72 + 300}px` }}>
            <thead>
              <tr className="bg-gray-800 text-white text-right">
                <th className="text-left px-3 py-2 font-semibold sticky left-0 bg-gray-800 min-w-[175px] z-10">DESCRIPTION</th>
                <th className="px-2 py-2 font-semibold min-w-[48px]">HRS</th>
                <th className="px-2 py-2 font-semibold min-w-[50px]">RATE</th>
                <th className="px-2 py-2 font-semibold min-w-[80px] bg-gray-700">AMOUNT</th>
                <th className="px-2 py-2 font-semibold min-w-[60px] bg-gray-600">YTD HRS</th>
                <th className="px-2 py-2 font-semibold min-w-[60px] bg-gray-600">YTD RATE</th>
                <th className="px-2 py-2 font-semibold min-w-[88px] bg-gray-600">YTD AMT</th>
                {visible.map((r) => (
                  <th key={r.n} className="px-2 py-2 font-semibold min-w-[72px] border-l border-gray-600">{fmtCol(r.end)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Wage */}
              <tr className="border-b border-gray-100 text-right">
                <td className="px-3 py-1.5 font-medium text-gray-700 text-left sticky left-0 bg-white z-10">Wage</td>
                <C v={cur.hours} zero="0" />
                <C v={cur.rate} />
                <C v={cur.regularPay} />
                <Y v={ytd.hours} zero="0" />
                <Y v={cur.rate} />
                <Y v={ytd.regularPay} bold />
                {visible.map((r) => (
                  <td key={r.n} className="px-2 py-1.5 text-right border-l border-gray-100 text-gray-600">
                    {fmtN(r.regularPay)}
                  </td>
                ))}
              </tr>

              {/* VacPay */}
              <tr className="border-b border-gray-100 text-right">
                <td className="px-3 py-1.5 font-medium text-gray-700 text-left sticky left-0 bg-white z-10">VacPay-Paid Out</td>
                <D /><D />
                <C v={cur.vacPay} />
                <Y v="-" /><Y v="-" />
                <Y v={ytd.vacPay} bold />
                {visible.map((r) => (
                  <td key={r.n} className="px-2 py-1.5 text-right border-l border-gray-100 text-gray-600">
                    {fmtN(r.vacPay)}
                  </td>
                ))}
              </tr>

              {/* Holiday Pay */}
              <tr className="border-b border-gray-100 text-right">
                <td className="px-3 py-1.5 font-medium text-gray-700 text-left sticky left-0 bg-white z-10">Holiday Pay</td>
                <D /><D />
                <C v={cur.holidayPay} zero="0.00" />
                <Y v="-" /><Y v="-" />
                <Y v={ytd.holidayPay} bold zero="0.00" />
                {visible.map((r) => (
                  <td key={r.n} className="px-2 py-1.5 text-right border-l border-gray-100 text-gray-600">
                    {fmtN(r.holidayPay)}
                  </td>
                ))}
              </tr>

              {/* Other Benefit */}
              <tr className="border-b border-gray-100 text-right">
                <td className="px-3 py-1.5 font-medium text-gray-700 text-left sticky left-0 bg-white z-10">Other Benefit</td>
                <D /><D />
                <C v={cur.otherBenefit} zero="0.00" />
                <Y v="-" /><Y v="-" />
                <Y v={ytd.otherBenefit} bold zero="0.00" />
                {visible.map((r) => (
                  <td key={r.n} className="px-2 py-1.5 text-right border-l border-gray-100 text-gray-600">
                    {fmtN(r.otherBenefit)}
                  </td>
                ))}
              </tr>

              {/* Total Gross */}
              <tr className="bg-blue-50 border-b-2 border-blue-200 text-right">
                <td className="px-3 py-1.5 text-left sticky left-0 bg-blue-50 z-10 border-b-2 border-blue-200"></td>
                <td className="px-2 py-1.5 font-semibold text-blue-800">{cur.hours || "-"}</td>
                <td className="px-2 py-1.5 font-semibold text-blue-800">{fmtN(cur.rate)}</td>
                <td className="px-2 py-1.5 font-bold text-blue-900 bg-blue-100">{fmtN(cur.totalGross)}</td>
                <td className="px-2 py-1.5 font-semibold text-blue-700 bg-blue-100">{ytd.hours || "-"}</td>
                <td className="px-2 py-1.5 text-blue-400 bg-blue-100">-</td>
                <td className="px-2 py-1.5 font-bold text-blue-900 bg-blue-100">{fmtN(ytd.totalGross)}</td>
                {visible.map((r) => (
                  <td key={r.n} className="px-2 py-1.5 text-right border-l border-blue-200 font-semibold text-blue-700">
                    {fmtN(r.totalGross)}
                  </td>
                ))}
              </tr>

              <tr><td colSpan={totalCols} className="h-1.5 bg-gray-50" /></tr>

              {/* Federal Income Tax — editable per period */}
              <tr className="border-b border-gray-100 text-right">
                <td className="px-3 py-1.5 font-medium text-gray-700 text-left sticky left-0 bg-white z-10">Federal Income Tax</td>
                <D /><D />
                <C v={cur.tax} cls="text-red-600" />
                <Y v="-" /><Y v="-" />
                <Y v={ytd.tax} bold cls="text-red-700" />
                {visible.map((r) => (
                  <E key={r.n} v={r.tax} onChange={(n) => setOverride(r.start, "tax", n)} />
                ))}
              </tr>

              {/* CPP-Employee — editable per period */}
              <tr className="border-b border-gray-100 text-right">
                <td className="px-3 py-1.5 font-medium text-gray-700 text-left sticky left-0 bg-white z-10">CPP-Employee</td>
                <D /><D />
                <C v={cur.cpp} cls="text-red-600" />
                <Y v="-" /><Y v="-" />
                <Y v={ytd.cpp} bold cls="text-red-700" />
                {visible.map((r) => (
                  <E key={r.n} v={r.cpp} onChange={(n) => setOverride(r.start, "cpp", n)} />
                ))}
              </tr>

              {/* EI-Employee — editable per period (dash for EI-exempt employees) */}
              <tr className="border-b-2 border-gray-300 text-right">
                <td className="px-3 py-1.5 font-medium text-gray-700 text-left sticky left-0 bg-white z-10">EI-Employee</td>
                <D /><D />
                <td className="px-2 py-1.5 text-right text-red-600">
                  {emp.eiExempt ? <span className="text-gray-400">0.00</span> : fmt(cur.ei)}
                </td>
                <Y v="-" /><Y v="-" />
                <td className="px-2 py-1.5 text-right bg-gray-50 font-semibold text-red-700">
                  {emp.eiExempt ? <span className="text-gray-400">0.00</span> : fmtN(ytd.ei)}
                </td>
                {visible.map((r) =>
                  emp.eiExempt
                    ? <td key={r.n} className="px-2 py-1.5 text-right border-l border-gray-100 text-gray-400">0.00</td>
                    : <E key={r.n} v={r.ei} onChange={(n) => setOverride(r.start, "ei", n)} />
                )}
              </tr>

              {/* Total Deductions (auto-computed) */}
              <tr className="bg-red-50 border-b-2 border-red-200 text-right">
                <td className="px-3 py-1.5 text-left sticky left-0 bg-red-50 z-10 border-b-2 border-red-200"></td>
                <D cls="text-gray-400" /><D cls="text-gray-400" />
                <td className="px-2 py-1.5 font-bold text-red-900 bg-red-100">{fmtN(cur.totalDed)}</td>
                <td className="px-2 py-1.5 text-gray-400 bg-red-100">-</td>
                <td className="px-2 py-1.5 text-gray-400 bg-red-100">-</td>
                <td className="px-2 py-1.5 font-bold text-red-900 bg-red-100">{fmtN(ytd.totalDed)}</td>
                {visible.map((r) => (
                  <td key={r.n} className="px-2 py-1.5 text-right border-l border-red-200 font-semibold text-red-700">
                    {fmtN(r.totalDed)}
                  </td>
                ))}
              </tr>

              {/* Net Pay (auto-computed) */}
              <tr className="bg-green-50 border-b-2 border-green-300 text-right">
                <td className="px-3 py-2 font-bold text-green-900 text-left sticky left-0 bg-green-50 z-10 border-b-2 border-green-300">Net Pay</td>
                <D cls="text-gray-400" /><D cls="text-gray-400" />
                <td className="px-2 py-2 font-bold text-green-900 text-sm bg-green-100">{fmtN(cur.netPay)}</td>
                <td className="px-2 py-2 text-gray-400 bg-green-100">-</td>
                <td className="px-2 py-2 text-gray-400 bg-green-100">-</td>
                <td className="px-2 py-2 font-bold text-green-900 text-sm bg-green-100">{fmtN(ytd.netPay)}</td>
                {visible.map((r) => (
                  <td key={r.n} className="px-2 py-2 text-right border-l border-green-200 font-semibold text-green-800">
                    {fmtN(r.netPay)}
                  </td>
                ))}
              </tr>

              <tr><td colSpan={totalCols} className="h-1.5 bg-gray-50" /></tr>

              {/* Vacation Earned */}
              <tr className="border-b border-gray-100 bg-amber-50 text-right">
                <td className="px-3 py-1.5 font-medium text-gray-700 text-left sticky left-0 bg-amber-50 z-10">Vacation Earned</td>
                <D cls="text-gray-400" /><D cls="text-gray-400" />
                <C v={cur.vacEarned} cls="text-amber-700" />
                <Y v="-" bg="bg-amber-100" /><Y v="-" bg="bg-amber-100" />
                <Y v={ytd.vacEarned} bold bg="bg-amber-100" cls="text-amber-700" />
                {visible.map((r) => (
                  <td key={r.n} className="px-2 py-1.5 text-right border-l border-gray-100 text-amber-600">{fmt(r.vacEarned)}</td>
                ))}
              </tr>

              {/* Vacation Paid */}
              <tr className="border-b border-gray-100 bg-amber-50 text-right">
                <td className="px-3 py-1.5 font-medium text-gray-700 text-left sticky left-0 bg-amber-50 z-10">Vacation Paid</td>
                <D cls="text-gray-400" /><D cls="text-gray-400" />
                <C v={cur.vacPaid} />
                <Y v="-" bg="bg-amber-100" /><Y v="-" bg="bg-amber-100" />
                <Y v={ytd.vacPaid} bold bg="bg-amber-100" />
                {visible.map((r) => (
                  <td key={r.n} className="px-2 py-1.5 text-right border-l border-gray-100 text-gray-500">{fmt(r.vacPaid)}</td>
                ))}
              </tr>

              {/* Vacation Balance */}
              <tr className="bg-amber-50 text-right">
                <td className="px-3 py-1.5 font-medium text-gray-700 text-left sticky left-0 bg-amber-50 z-10">Vacation Balance</td>
                <D cls="text-gray-400" /><D cls="text-gray-400" />
                <td className="px-2 py-1.5 text-gray-500">0.00</td>
                <Y v="-" bg="bg-amber-100" /><Y v="-" bg="bg-amber-100" />
                <Y v="0.00" bg="bg-amber-100" bold />
                {visible.map((r) => (
                  <td key={r.n} className="px-2 py-1.5 text-right border-l border-gray-100 text-gray-400">0.00</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-xs text-gray-400 text-center print:hidden">
          CRA 2025–2026 기준 · Kim / Jeong: EI Exempt (shareholder-director) · Tax / CPP / EI 셀을 클릭하여 수정 가능
        </p>

        {/* ── 급여 확인서 ─────────────────────────────────────────────── */}
        <div className="mt-6 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden" id="pay-cert">
          <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 print:hidden">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">급여 확인서 (인쇄 미리보기)</span>
          </div>
          <div className="p-8 text-xs font-sans">
            {/* Company */}
            <p className="font-bold text-sm mb-3">2078680 Alberta Ltd.</p>

            {/* Date */}
            <div className="flex justify-end mb-5">
              <span className="text-gray-600">Date: &nbsp; {dtLong(cur.end)}</span>
            </div>

            {/* Employee / SIN */}
            <div className="grid grid-cols-2 text-gray-400 mb-0.5">
              <span>Employee</span><span>SIN</span>
            </div>
            <div className="grid grid-cols-2 border-b border-gray-400 pb-1 mb-4">
              <span className="font-bold text-sm">{emp.name}</span>
              <span>{sins[emp.name] ?? emp.sin}</span>
            </div>

            {/* Pay period */}
            <div className="mb-5 text-gray-700">
              Pay period &nbsp; {cur.start} ~ {cur.end}
            </div>

            {/* Pay stub table */}
            <table className="w-full border-collapse text-xs">
              <colgroup>
                <col style={{width:"30%"}} />
                <col style={{width:"8%"}} />
                <col style={{width:"8%"}} />
                <col style={{width:"12%"}} />
                <col style={{width:"2%"}} />
                <col style={{width:"8%"}} />
                <col style={{width:"8%"}} />
                <col style={{width:"14%"}} />
                <col style={{width:"10%"}} />
              </colgroup>
              <thead>
                <tr>
                  <td colSpan={4} />
                  <td />
                  <td colSpan={4} className="text-right text-gray-500 pb-0.5">YTD AMOUNT</td>
                </tr>
                <tr className="border-b-2 border-gray-400">
                  <td className="font-bold py-1">DESCRIPTION</td>
                  <td className="text-right font-bold py-1">HOURS</td>
                  <td className="text-right font-bold py-1">RATE</td>
                  <td className="text-right font-bold py-1 bg-blue-50 px-1">AMOUNT</td>
                  <td />
                  <td className="text-right font-bold py-1">HOURS</td>
                  <td className="text-right font-bold py-1">RATE</td>
                  <td className="text-right font-bold py-1 bg-blue-50 px-1">AMOUNT</td>
                  <td />
                </tr>
              </thead>
              <tbody>
                {/* Wage */}
                <tr className="border-b border-gray-100">
                  <td className="py-0.5">Wage</td>
                  <td className="text-right py-0.5">{fmtN(cur.hours)}</td>
                  <td className="text-right py-0.5">{fmtN(cur.rate)}</td>
                  <td className="text-right py-0.5 bg-blue-50 px-1">{fmtN(cur.regularPay)}</td>
                  <td />
                  <td className="text-right py-0.5">{fmtN(ytd.hours)}</td>
                  <td className="text-right py-0.5">{fmtN(cur.rate)}</td>
                  <td className="text-right py-0.5 bg-blue-50 px-1">{fmtN(ytd.regularPay)}</td>
                  <td />
                </tr>
                {/* VacPay */}
                <tr className="border-b border-gray-100">
                  <td className="py-0.5">VacPay-Paid Out</td>
                  <td /><td />
                  <td className="text-right py-0.5 bg-blue-50 px-1">{fmtN(cur.vacPay)}</td>
                  <td />
                  <td /><td />
                  <td className="text-right py-0.5 bg-blue-50 px-1">{fmtN(ytd.vacPay)}</td>
                  <td />
                </tr>
                {/* Holiday Pay */}
                <tr className="border-b border-gray-100">
                  <td className="py-0.5">Holiday Pay</td>
                  <td /><td />
                  <td className="text-right py-0.5 bg-blue-50 px-1">{fmtN(cur.holidayPay)}</td>
                  <td />
                  <td /><td />
                  <td className="text-right py-0.5 bg-blue-50 px-1">{fmtN(ytd.holidayPay)}</td>
                  <td />
                </tr>
                {/* Other Benefit */}
                <tr className="border-b border-gray-100">
                  <td className="py-0.5">Other Benefit</td>
                  <td /><td />
                  <td className="text-right py-0.5 bg-blue-50 px-1">{fmtN(cur.otherBenefit)}</td>
                  <td />
                  <td /><td />
                  <td className="text-right py-0.5 bg-blue-50 px-1">{fmtN(ytd.otherBenefit)}</td>
                  <td />
                </tr>
                {/* Total Gross */}
                <tr className="border-t-2 border-b-2 border-blue-300 bg-blue-50">
                  <td className="py-1" />
                  <td className="text-right py-1 font-semibold">{fmtN(cur.hours)}</td>
                  <td className="text-right py-1 font-semibold">{fmtN(cur.rate)}</td>
                  <td className="text-right py-1 font-bold bg-blue-100 px-1">{fmtN(cur.totalGross)}</td>
                  <td />
                  <td className="text-right py-1 font-semibold">{fmtN(ytd.hours)}</td>
                  <td />
                  <td className="text-right py-1 font-bold bg-blue-100 px-1">{fmtN(ytd.totalGross)}</td>
                  <td />
                </tr>

                <tr><td colSpan={9} className="h-3" /></tr>

                {/* Taxes header */}
                <tr>
                  <td className="py-1 font-bold">Taxes</td>
                  <td /><td />
                  <td className="text-right py-1 font-bold px-1">AMOUNT</td>
                  <td />
                  <td /><td />
                  <td className="text-right py-1 font-bold px-1">YTD AMOUNT</td>
                  <td />
                </tr>
                {/* Federal Income Tax */}
                <tr className="border-b border-gray-100">
                  <td className="py-0.5">Federal Income Tax</td>
                  <td /><td />
                  <td className="text-right py-0.5 px-1 text-red-700">{fmtN(cur.tax)}</td>
                  <td />
                  <td /><td />
                  <td className="text-right py-0.5 px-1 text-red-700">{fmtN(ytd.tax)}</td>
                  <td />
                </tr>
                {/* CPP */}
                <tr className="border-b border-gray-100">
                  <td className="py-0.5">CPP-Employee</td>
                  <td /><td />
                  <td className="text-right py-0.5 px-1 text-red-700">{fmtN(cur.cpp)}</td>
                  <td />
                  <td /><td />
                  <td className="text-right py-0.5 px-1 text-red-700">{fmtN(ytd.cpp)}</td>
                  <td />
                </tr>
                {/* EI */}
                <tr className="border-b border-gray-100">
                  <td className="py-0.5">EI-Employee</td>
                  <td /><td />
                  <td className="text-right py-0.5 px-1 text-red-700">{fmtN(cur.ei)}</td>
                  <td />
                  <td /><td />
                  <td className="text-right py-0.5 px-1 text-red-700">{fmtN(ytd.ei)}</td>
                  <td />
                </tr>
                {/* Total Deductions */}
                <tr className="border-t-2 border-b-2 border-red-300 bg-red-50">
                  <td className="py-1" />
                  <td /><td />
                  <td className="text-right py-1 font-bold bg-red-100 px-1 text-red-900">{fmtN(cur.totalDed)}</td>
                  <td />
                  <td /><td />
                  <td className="text-right py-1 font-bold bg-red-100 px-1 text-red-900">{fmtN(ytd.totalDed)}</td>
                  <td />
                </tr>

                <tr><td colSpan={9} className="h-3" /></tr>

                {/* Net Pay */}
                <tr className="border-t-2 border-b-2 border-green-300 bg-green-50">
                  <td className="py-1.5 font-bold text-green-900">Net Pay</td>
                  <td /><td />
                  <td className="text-right py-1.5 font-bold bg-green-100 px-1 text-green-900">{fmtN(cur.netPay)}</td>
                  <td />
                  <td /><td />
                  <td className="text-right py-1.5 font-bold bg-green-100 px-1 text-green-900">{fmtN(ytd.netPay)}</td>
                  <td />
                </tr>

                <tr><td colSpan={9} className="h-3" /></tr>

                {/* Vacation section */}
                <tr>
                  <td className="py-0.5 font-bold" colSpan={9}>Vacation pay</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-0.5">Earned</td>
                  <td /><td />
                  <td className="text-right py-0.5 bg-amber-50 px-1">{fmtN(cur.vacEarned)}</td>
                  <td />
                  <td /><td />
                  <td className="text-right py-0.5 bg-amber-50 px-1">{fmtN(ytd.vacEarned)}</td>
                  <td />
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-0.5">Paid</td>
                  <td /><td />
                  <td className="text-right py-0.5 bg-amber-50 px-1">{fmtN(cur.vacPaid)}</td>
                  <td />
                  <td /><td />
                  <td className="text-right py-0.5 bg-amber-50 px-1">{fmtN(ytd.vacPaid)}</td>
                  <td />
                </tr>
                <tr>
                  <td className="py-0.5">Balance</td>
                  <td /><td />
                  <td className="text-right py-0.5 bg-amber-50 px-1">0.00</td>
                  <td />
                  <td /><td />
                  <td className="text-right py-0.5 bg-amber-50 px-1">0.00</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <style>{`
          @media print {
            body { background: white !important; }
            .print\\:hidden { display: none !important; }
            nav, header { display: none !important; }
            #pay-cert {
              box-shadow: none !important;
              border: none !important;
              border-radius: 0 !important;
              margin-top: 0 !important;
            }
          }
        `}</style>
      </div>
    </main>
  );
}
