"use client";

import { useMemo, useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { calculateBiweeklyPayroll, fmt } from "@/lib/tax-calculator";
import { generatePeriods, SUPPORTED_YEARS } from "@/lib/periods";
import { syncFromServer, LIVE_CUTOFF, SavedEntries } from "@/lib/payroll-store";

interface EmployeeDef {
  id: number;
  name: string;
  eiExempt: boolean;
  defaultHours: number;
  getRate: (period: string) => number;
  getDefaultTax: (period: string) => number;
}

const EMPLOYEES: EmployeeDef[] = [
  {
    id: 1, name: "Kim, Woo Jeon", eiExempt: true, defaultHours: 80,
    getRate: () => 25.00,
    getDefaultTax: (p) => p >= "2026-10-25" ? 246.57 : 265.41,
  },
  {
    id: 2, name: "Jeong, Jae Yeon", eiExempt: true, defaultHours: 80,
    getRate: () => 25.00,
    getDefaultTax: (p) => p >= "2026-10-25" ? 246.57 : 265.41,
  },
  {
    id: 3, name: "Lee, Sang Yeol", eiExempt: false, defaultHours: 80,
    getRate: () => 25.00,
    getDefaultTax: (p) => p >= "2026-10-25" ? 239.74 : 257.95,
  },
  {
    id: 4, name: "Nam, Young Gil", eiExempt: false, defaultHours: 75,
    getRate: (p) => p >= "2026-06-21" ? 22.63 : 21.63,
    getDefaultTax: (p) => p >= "2026-06-21" ? 193.93 : 178.07,
  },
];

// Periods are generated dynamically per year via generatePeriods()

const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const VACATION_RATE = 0.04;

const PERIOD_ABSENCES: Record<string, number[]> = {
  "2026-09-27": [4],
};

function calcRow(emp: EmployeeDef, regularHrs: number, periodDate: string) {
  const rate = emp.getRate(periodDate);
  const regularPay = regularHrs * rate;
  const vacationPay = regularPay * VACATION_RATE;
  const totalGross = regularPay + vacationPay;
  if (totalGross === 0) {
    return { rate, regularHrs, regularPay: 0, vacationPay: 0, totalGross: 0, tax: 0, cpp: 0, ei: 0, totalDeduction: 0, netPay: 0, employerCPP: 0, employerEI: 0 };
  }
  const calc = calculateBiweeklyPayroll(totalGross, emp.eiExempt, periodDate);
  const tax = emp.getDefaultTax(periodDate);
  const totalDeduction = Math.round((tax + calc.cpp + calc.ei) * 100) / 100;
  const netPay = Math.round((totalGross - totalDeduction) * 100) / 100;
  return {
    rate, regularHrs, regularPay, vacationPay, totalGross,
    tax, cpp: calc.cpp, ei: calc.ei, totalDeduction, netPay,
    employerCPP: calc.cpp, employerEI: Math.round(calc.ei * 1.4 * 100) / 100,
  };
}

type RowData = ReturnType<typeof calcRow>;

function sumRows(rows: RowData[]) {
  return rows.reduce((acc, r) => ({
    regularPay:     acc.regularPay + r.regularPay,
    vacationPay:    acc.vacationPay + r.vacationPay,
    totalGross:     acc.totalGross + r.totalGross,
    tax:            acc.tax + r.tax,
    cpp:            acc.cpp + r.cpp,
    ei:             acc.ei + r.ei,
    totalDeduction: acc.totalDeduction + r.totalDeduction,
    netPay:         acc.netPay + r.netPay,
    employerCPP:    acc.employerCPP + r.employerCPP,
    employerEI:     acc.employerEI + r.employerEI,
  }), { regularPay: 0, vacationPay: 0, totalGross: 0, tax: 0, cpp: 0, ei: 0, totalDeduction: 0, netPay: 0, employerCPP: 0, employerEI: 0 });
}

function r2(n: number) { return Math.round(n * 100) / 100; }

function buildMonthlyData(year: number, savedEntries: SavedEntries) {
  const ALL_PERIODS = generatePeriods(year);
  return Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    const periods = ALL_PERIODS.filter((p) => p.month === month);
    const periodRows = periods.map((period) => {
      const isLive = period.start >= LIVE_CUTOFF;
      const saved = savedEntries[period.start];
      const empRows = EMPLOYEES.map((emp) => {
        if (isLive) {
          if (saved && saved[emp.id]) {
            const s = saved[emp.id];
            return { emp, rate: s.rate, regularHrs: s.regular, regularPay: s.regularPay, vacationPay: s.vacationPay,
              totalGross: s.totalGross, tax: s.tax, cpp: s.cpp, ei: s.ei,
              totalDeduction: s.totalDeduction, netPay: s.netPay, employerCPP: s.employerCPP, employerEI: s.employerEI };
          }
          return { emp, ...calcRow(emp, 0, period.start) };
        }
        const absentIds = PERIOD_ABSENCES[period.start] ?? [];
        const hrs = absentIds.includes(emp.id) ? 0 : emp.defaultHours;
        return { emp, ...calcRow(emp, hrs, period.start) };
      });
      return { period, empRows, totals: sumRows(empRows) };
    });
    const allRows = periodRows.flatMap((pr) => pr.empRows as RowData[]);
    const monthTotal = sumRows(allRows);
    return { month, periods: periodRows, monthTotal };
  });
}

// ── Component ─────────────────────────────────────────────────────────────────
function AnnualContent() {
  const params = useSearchParams();
  const yearParam = parseInt(params.get("y") ?? "2026");
  const [selectedYear, setSelectedYear] = useState(yearParam);
  const [savedEntries, setSavedEntries] = useState<SavedEntries>({});

  useEffect(() => {
    syncFromServer().then(setSavedEntries);
  }, [selectedYear]);

  const monthlyData = useMemo(() => buildMonthlyData(selectedYear, savedEntries), [selectedYear, savedEntries]);

  const yearTotal = useMemo(() => {
    const all = monthlyData.flatMap((m) => m.periods.flatMap((p) => p.empRows as RowData[]));
    return sumRows(all);
  }, [monthlyData]);

  const TH = ({ children, right = false }: { children: React.ReactNode; right?: boolean }) => (
    <th className={`border border-gray-400 px-1 py-0.5 text-xs font-bold bg-gray-200 whitespace-nowrap ${right ? "text-right" : "text-center"}`}>
      {children}
    </th>
  );

  const TD = ({ children, right = false, bold = false, bg = "" }: { children: React.ReactNode; right?: boolean; bold?: boolean; bg?: string }) => (
    <td className={`border border-gray-300 px-1 py-0.5 text-xs whitespace-nowrap ${right ? "text-right" : ""} ${bold ? "font-bold" : ""} ${bg}`}>
      {children}
    </td>
  );

  return (
    <main className="bg-white min-h-screen p-4 print:p-2">
      {/* Nav bar – hidden on print */}
      <div className="flex items-center justify-between mb-4 print:hidden">
        <div>
          <Link href="/home" className="text-xs text-blue-600 hover:underline">← 홈으로</Link>
          <h1 className="text-xl font-bold text-gray-900 mt-0.5">
            2078680 Alberta Ltd. — {selectedYear} Annual Payroll
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg px-2 py-1">
            {SUPPORTED_YEARS.map((y) => (
              <button
                key={y}
                onClick={() => setSelectedYear(y)}
                className={`px-3 py-1 rounded-md text-sm font-semibold transition ${
                  selectedYear === y ? "bg-white text-blue-700 shadow-sm" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {y}
              </button>
            ))}
          </div>
          <button
            onClick={() => window.print()}
            className="bg-gray-800 text-white px-4 py-2 rounded-lg text-sm hover:bg-gray-700"
          >
            🖨 인쇄 / Print
          </button>
        </div>
      </div>

      {/* Print header */}
      <div className="hidden print:block text-center mb-4">
        <div className="text-lg font-bold">2078680 Alberta Ltd.</div>
        <div className="text-sm">{selectedYear} Annual Payroll Summary</div>
      </div>

      <style>{`
        @media print {
          @page { size: landscape; margin: 8mm; }
          .page-break { page-break-before: always; }
          body { font-size: 8px; }
        }
      `}</style>

      {/* ── Monthly sections ── */}
      {monthlyData.map(({ month, periods, monthTotal }, idx) => {
        const empContrib = r2(monthTotal.employerCPP + monthTotal.employerEI);
        const craTotal   = r2(monthTotal.totalDeduction + empContrib);

        return (
          <div key={month} className={idx > 0 ? "mt-8 page-break" : ""}>
            <div className="bg-gray-800 text-white px-3 py-1.5 text-sm font-bold mb-1">
              {idx + 1}-26 &nbsp; {MONTH_NAMES[month].toUpperCase()} 2026
            </div>

            <div className="overflow-x-auto">
              <table className="border-collapse w-full">
                <thead>
                  <tr>
                    <TH>DATE</TH>
                    <TH>EMPLOYEE</TH>
                    <TH right>HRS</TH>
                    <TH right>RATE</TH>
                    <TH right>REGULAR PAY</TH>
                    <TH right>VACATION PAY ($)</TH>
                    <TH right>OVER TIME</TH>
                    <TH right>HOLIDAY PAY</TH>
                    <TH right>OTHER TAXABLE BENEFIT</TH>
                    <TH right>TOTAL GROSS</TH>
                    <TH right>TAX</TH>
                    <TH right>CPP</TH>
                    <TH right>EI</TH>
                    <TH right>TOTAL DEDUCTION</TH>
                    <TH right>NET PAY</TH>
                  </tr>
                </thead>
                <tbody>
                  {periods.map(({ period, empRows }) =>
                    empRows.map(({ emp, ...row }, ei) => (
                      <tr key={`${period.start}-${emp.id}`} className={row.totalGross === 0 ? "opacity-40" : ""}>
                        <TD>{ei === 0 ? period.label : ""}</TD>
                        <TD>{emp.name}</TD>
                        <TD right>{row.totalGross > 0 ? row.regularHrs : ""}</TD>
                        <TD right>{row.totalGross > 0 ? fmt(row.rate) : ""}</TD>
                        <TD right>{row.totalGross > 0 ? fmt(row.regularPay) : "-"}</TD>
                        <TD right>{row.totalGross > 0 ? fmt(row.vacationPay) : "-"}</TD>
                        <TD right> - </TD>
                        <TD right> - </TD>
                        <TD right> - </TD>
                        <TD right bold bg={row.totalGross > 0 ? "bg-blue-50" : ""}>{row.totalGross > 0 ? fmt(row.totalGross) : "-"}</TD>
                        <TD right>{row.totalGross > 0 ? fmt(row.tax) : "-"}</TD>
                        <TD right>{row.totalGross > 0 ? fmt(row.cpp) : "-"}</TD>
                        <TD right>{row.ei > 0 ? fmt(row.ei) : "-"}</TD>
                        <TD right bold bg={row.totalGross > 0 ? "bg-red-50" : ""}>{row.totalGross > 0 ? fmt(row.totalDeduction) : "-"}</TD>
                        <TD right bold bg={row.totalGross > 0 ? "bg-green-50" : ""}>{row.totalGross > 0 ? fmt(row.netPay) : "-"}</TD>
                      </tr>
                    ))
                  )}
                  <tr className="bg-gray-700 text-white">
                    <td className="border border-gray-500 px-1 py-1 text-xs font-bold text-center" colSpan={4}>Grand Total</td>
                    <td className="border border-gray-500 px-1 py-1 text-xs font-bold text-right">{fmt(monthTotal.regularPay)}</td>
                    <td className="border border-gray-500 px-1 py-1 text-xs font-bold text-right">{fmt(monthTotal.vacationPay)}</td>
                    <td className="border border-gray-500 px-1 py-1 text-xs font-bold text-right"> - </td>
                    <td className="border border-gray-500 px-1 py-1 text-xs font-bold text-right"> - </td>
                    <td className="border border-gray-500 px-1 py-1 text-xs font-bold text-right"> - </td>
                    <td className="border border-gray-500 px-1 py-1 text-xs font-bold text-right bg-blue-800">{fmt(monthTotal.totalGross)}</td>
                    <td className="border border-gray-500 px-1 py-1 text-xs font-bold text-right">{fmt(monthTotal.tax)}</td>
                    <td className="border border-gray-500 px-1 py-1 text-xs font-bold text-right">{fmt(monthTotal.cpp)}</td>
                    <td className="border border-gray-500 px-1 py-1 text-xs font-bold text-right">{fmt(monthTotal.ei)}</td>
                    <td className="border border-gray-500 px-1 py-1 text-xs font-bold text-right bg-red-800">{fmt(monthTotal.totalDeduction)}</td>
                    <td className="border border-gray-500 px-1 py-1 text-xs font-bold text-right bg-green-800">{fmt(monthTotal.netPay)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Gross Payroll + CRA */}
            <div className="mt-2 flex gap-8 flex-wrap items-start">
              <div className="text-xs mt-1">
                <span className="font-bold">GROSS PAYROLL FOR {MONTH_NAMES[month].toUpperCase()} 2026:</span>
                <span className="ml-2 font-bold text-blue-700">${fmt(monthTotal.totalGross)}</span>
              </div>

              <div className="border border-gray-300">
                <table className="text-xs border-collapse">
                  <thead>
                    <tr>
                      <th className="border border-gray-300 px-2 py-0.5 bg-gray-200 text-left" colSpan={5}>
                        PAYABLE TO CRA FOR {MONTH_NAMES[month].toUpperCase()} 2026
                      </th>
                    </tr>
                    <tr>
                      <th className="border border-gray-300 px-2 py-0.5 bg-gray-100 w-36"></th>
                      <th className="border border-gray-300 px-3 py-0.5 bg-gray-100 text-right">CPP</th>
                      <th className="border border-gray-300 px-3 py-0.5 bg-gray-100 text-right">EI</th>
                      <th className="border border-gray-300 px-3 py-0.5 bg-gray-100 text-right">TAX</th>
                      <th className="border border-gray-300 px-3 py-0.5 bg-gray-100 text-right">TOTAL</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="border border-gray-300 px-2 py-0.5">Deducted amount</td>
                      <td className="border border-gray-300 px-3 py-0.5 text-right">{fmt(monthTotal.cpp)}</td>
                      <td className="border border-gray-300 px-3 py-0.5 text-right">{fmt(monthTotal.ei)}</td>
                      <td className="border border-gray-300 px-3 py-0.5 text-right">{fmt(monthTotal.tax)}</td>
                      <td className="border border-gray-300 px-3 py-0.5 text-right font-medium">{fmt(monthTotal.totalDeduction)}</td>
                    </tr>
                    <tr>
                      <td className="border border-gray-300 px-2 py-0.5">Company contribution</td>
                      <td className="border border-gray-300 px-3 py-0.5 text-right">{fmt(monthTotal.employerCPP)}</td>
                      <td className="border border-gray-300 px-3 py-0.5 text-right">{fmt(monthTotal.employerEI)}</td>
                      <td className="border border-gray-300 px-3 py-0.5 text-right"></td>
                      <td className="border border-gray-300 px-3 py-0.5 text-right font-medium">{fmt(empContrib)}</td>
                    </tr>
                    <tr className="bg-yellow-50 font-bold">
                      <td className="border border-gray-400 px-2 py-0.5">Total</td>
                      <td className="border border-gray-400 px-3 py-0.5 text-right">{fmt(r2(monthTotal.cpp * 2))}</td>
                      <td className="border border-gray-400 px-3 py-0.5 text-right">{fmt(r2(monthTotal.ei + monthTotal.employerEI))}</td>
                      <td className="border border-gray-400 px-3 py-0.5 text-right">{fmt(monthTotal.tax)}</td>
                      <td className="border border-gray-400 px-3 py-0.5 text-right text-blue-900">{fmt(craTotal)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })}

      {/* ── Annual Summary ── */}
      <div className="mt-10 page-break">
        <div className="bg-gray-900 text-white px-3 py-2 text-sm font-bold mb-2">
          ANNUAL SUMMARY — 2026
        </div>

        <div className="overflow-x-auto mb-6">
          <table className="border-collapse text-xs w-full">
            <thead>
              <tr className="bg-gray-200">
                <TH>MONTH</TH>
                <TH right>GROSS PAYROLL</TH>
                <TH right>TAX</TH>
                <TH right>CPP (Emp)</TH>
                <TH right>EI (Emp)</TH>
                <TH right>TOTAL DEDUCTION</TH>
                <TH right>NET PAY</TH>
                <TH right>CPP (Employer)</TH>
                <TH right>EI (Employer ×1.4)</TH>
                <TH right>PAYABLE TO CRA</TH>
              </tr>
            </thead>
            <tbody>
              {monthlyData.map(({ month, monthTotal }) => {
                const empC = r2(monthTotal.employerCPP + monthTotal.employerEI);
                return (
                  <tr key={month} className={monthTotal.totalGross === 0 ? "text-gray-300" : ""}>
                    <TD bold>{MONTH_NAMES[month]}</TD>
                    <TD right bold bg="bg-blue-50">{monthTotal.totalGross > 0 ? fmt(monthTotal.totalGross) : "-"}</TD>
                    <TD right>{monthTotal.totalGross > 0 ? fmt(monthTotal.tax) : "-"}</TD>
                    <TD right>{monthTotal.totalGross > 0 ? fmt(monthTotal.cpp) : "-"}</TD>
                    <TD right>{monthTotal.totalGross > 0 ? fmt(monthTotal.ei) : "-"}</TD>
                    <TD right bold bg="bg-red-50">{monthTotal.totalGross > 0 ? fmt(monthTotal.totalDeduction) : "-"}</TD>
                    <TD right bold bg="bg-green-50">{monthTotal.totalGross > 0 ? fmt(monthTotal.netPay) : "-"}</TD>
                    <TD right>{monthTotal.totalGross > 0 ? fmt(monthTotal.employerCPP) : "-"}</TD>
                    <TD right>{monthTotal.totalGross > 0 ? fmt(monthTotal.employerEI) : "-"}</TD>
                    <TD right bold bg="bg-yellow-50">{monthTotal.totalGross > 0 ? fmt(r2(monthTotal.totalDeduction + empC)) : "-"}</TD>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-gray-800 text-white font-bold">
                <td className="border border-gray-600 px-1 py-1.5 text-xs">ANNUAL TOTAL</td>
                <td className="border border-gray-600 px-1 py-1.5 text-xs text-right bg-blue-800">{fmt(yearTotal.totalGross)}</td>
                <td className="border border-gray-600 px-1 py-1.5 text-xs text-right">{fmt(yearTotal.tax)}</td>
                <td className="border border-gray-600 px-1 py-1.5 text-xs text-right">{fmt(yearTotal.cpp)}</td>
                <td className="border border-gray-600 px-1 py-1.5 text-xs text-right">{fmt(yearTotal.ei)}</td>
                <td className="border border-gray-600 px-1 py-1.5 text-xs text-right bg-red-800">{fmt(yearTotal.totalDeduction)}</td>
                <td className="border border-gray-600 px-1 py-1.5 text-xs text-right bg-green-800">{fmt(yearTotal.netPay)}</td>
                <td className="border border-gray-600 px-1 py-1.5 text-xs text-right">{fmt(yearTotal.employerCPP)}</td>
                <td className="border border-gray-600 px-1 py-1.5 text-xs text-right">{fmt(yearTotal.employerEI)}</td>
                <td className="border border-gray-600 px-1 py-1.5 text-xs text-right bg-yellow-700">
                  {fmt(r2(yearTotal.totalDeduction + yearTotal.employerCPP + yearTotal.employerEI))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Annual CRA table */}
        <div className="border border-gray-300 inline-block">
          <table className="text-xs border-collapse">
            <thead>
              <tr>
                <th className="border border-gray-300 px-3 py-1 bg-gray-200 text-left" colSpan={5}>
                  ANNUAL PAYABLE TO CRA — 2026
                </th>
              </tr>
              <tr>
                <th className="border border-gray-300 px-3 py-1 bg-gray-100 w-40"></th>
                <th className="border border-gray-300 px-3 py-1 bg-gray-100 text-right">CPP</th>
                <th className="border border-gray-300 px-3 py-1 bg-gray-100 text-right">EI</th>
                <th className="border border-gray-300 px-3 py-1 bg-gray-100 text-right">TAX</th>
                <th className="border border-gray-300 px-3 py-1 bg-gray-100 text-right">TOTAL</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="border border-gray-300 px-3 py-1">Deducted amount</td>
                <td className="border border-gray-300 px-3 py-1 text-right">{fmt(yearTotal.cpp)}</td>
                <td className="border border-gray-300 px-3 py-1 text-right">{fmt(yearTotal.ei)}</td>
                <td className="border border-gray-300 px-3 py-1 text-right">{fmt(yearTotal.tax)}</td>
                <td className="border border-gray-300 px-3 py-1 text-right font-bold">{fmt(yearTotal.totalDeduction)}</td>
              </tr>
              <tr>
                <td className="border border-gray-300 px-3 py-1">Company contribution</td>
                <td className="border border-gray-300 px-3 py-1 text-right">{fmt(yearTotal.employerCPP)}</td>
                <td className="border border-gray-300 px-3 py-1 text-right">{fmt(yearTotal.employerEI)}</td>
                <td className="border border-gray-300 px-3 py-1 text-right"></td>
                <td className="border border-gray-300 px-3 py-1 text-right font-bold">
                  {fmt(r2(yearTotal.employerCPP + yearTotal.employerEI))}
                </td>
              </tr>
              <tr className="bg-yellow-100 font-bold">
                <td className="border border-gray-400 px-3 py-1.5">Total</td>
                <td className="border border-gray-400 px-3 py-1.5 text-right">{fmt(r2(yearTotal.cpp * 2))}</td>
                <td className="border border-gray-400 px-3 py-1.5 text-right">{fmt(r2(yearTotal.ei + yearTotal.employerEI))}</td>
                <td className="border border-gray-400 px-3 py-1.5 text-right">{fmt(yearTotal.tax)}</td>
                <td className="border border-gray-400 px-3 py-1.5 text-right text-blue-900 text-sm">
                  {fmt(r2(yearTotal.totalDeduction + yearTotal.employerCPP + yearTotal.employerEI))}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="mt-4 text-xs text-gray-400 space-y-0.5">
          <p>* Kim, Woo Jeon &amp; Jeong, Jae Yeon: EI exempt (shareholder-directors of 2078680 Alberta Ltd.)</p>
          <p>* Nam, Young Gil: rate $21.63/hr (P1–P13) → $22.63/hr (P14+, from 2026-06-21)</p>
          <p>* Income tax change: P24+ (from 2026-11-08) — Kim/Jeong $246.57, Lee $239.74</p>
          <p>* EI rate: 1.63% (P1–P22) → 1.64% (P24+, from 2026-11-08). Employer EI = Employee EI × 1.4</p>
        </div>
      </div>
    </main>
  );
}

export default function AnnualPage() {
  return (
    <Suspense fallback={<div className="p-8 text-gray-500">Loading...</div>}>
      <AnnualContent />
    </Suspense>
  );
}
