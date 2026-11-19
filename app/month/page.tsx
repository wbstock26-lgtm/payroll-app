"use client";

import { useState, useMemo, useCallback, useEffect, Suspense } from "react";
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

// ALL_PERIODS is now generated dynamically per year via generatePeriods()

const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const VACATION_RATE = 0.04;

// Employee IDs with 0 default hours for specific periods (confirmed absences)
const PERIOD_ABSENCES: Record<string, number[]> = {
  "2026-09-27": [4], // Nam, Young Gil absent 26/09/27~26/10/10
};

interface Hours {
  regular: string;
  holiday: string;
  otherBenefit: string;
}

function calcRow(emp: EmployeeDef, h: Hours, periodDate: string, taxOverride: string) {
  const rate = emp.getRate(periodDate);
  const regular = parseFloat(h.regular || "0");
  const holidayHrs = parseFloat(h.holiday || "0");
  const otherBenefit = parseFloat(h.otherBenefit || "0");
  const regularPay = regular * rate;
  const holidayPay = holidayHrs * rate;
  const vacationPay = (regularPay + holidayPay) * VACATION_RATE;
  const totalGross = regularPay + vacationPay + holidayPay + otherBenefit;
  const calc = calculateBiweeklyPayroll(totalGross, emp.eiExempt, periodDate);
  // If no hours worked, all deductions are zero
  const tax = totalGross === 0 ? 0
    : taxOverride !== "" ? parseFloat(taxOverride)
    : emp.getDefaultTax(periodDate);
  const totalDeduction = Math.round((tax + calc.cpp + calc.ei) * 100) / 100;
  const netPay = Math.round((totalGross - totalDeduction) * 100) / 100;
  const employerEI = Math.round(calc.ei * 1.4 * 100) / 100;
  return {
    rate, regular, regularPay, vacationPay, holidayPay, otherBenefit,
    totalGross, tax, cpp: calc.cpp, ei: calc.ei, totalDeduction, netPay,
    employerCPP: calc.cpp, employerEI,
  };
}

type RowData = ReturnType<typeof calcRow>;

function sumRows(rows: RowData[]) {
  return {
    regularPay:     rows.reduce((s, r) => s + r.regularPay, 0),
    vacationPay:    rows.reduce((s, r) => s + r.vacationPay, 0),
    holidayPay:     rows.reduce((s, r) => s + r.holidayPay, 0),
    otherBenefit:   rows.reduce((s, r) => s + r.otherBenefit, 0),
    totalGross:     rows.reduce((s, r) => s + r.totalGross, 0),
    tax:            rows.reduce((s, r) => s + r.tax, 0),
    cpp:            rows.reduce((s, r) => s + r.cpp, 0),
    ei:             rows.reduce((s, r) => s + r.ei, 0),
    totalDeduction: rows.reduce((s, r) => s + r.totalDeduction, 0),
    netPay:         rows.reduce((s, r) => s + r.netPay, 0),
    employerCPP:    rows.reduce((s, r) => s + r.employerCPP, 0),
    employerEI:     rows.reduce((s, r) => s + r.employerEI, 0),
  };
}

function MonthContent() {
  const params = useSearchParams();
  const monthParam = parseInt(params.get("m") ?? "10");
  const yearParam = parseInt(params.get("y") ?? "2026");
  const [selectedYear, setSelectedYear] = useState(yearParam);
  const [selectedMonth, setSelectedMonth] = useState(monthParam);

  const ALL_PERIODS = generatePeriods(selectedYear);
  const monthPeriods = ALL_PERIODS.filter((p) => p.month === selectedMonth);

  // State: hours and tax overrides per period per employee
  const initHours = useCallback((periods: typeof ALL_PERIODS) => {
    const state: Record<string, Record<number, Hours>> = {};
    for (const p of periods) {
      const absentIds = PERIOD_ABSENCES[p.start] ?? [];
      const isLive = p.start >= LIVE_CUTOFF;
      state[p.start] = Object.fromEntries(
        EMPLOYEES.map((e) => [e.id, {
          regular: isLive ? "" : (absentIds.includes(e.id) ? "0" : String(e.defaultHours)),
          holiday: "",
          otherBenefit: "",
        }])
      );
    }
    return state;
  }, []);

  const initOverrides = useCallback((periods: typeof ALL_PERIODS) => {
    const state: Record<string, Record<number, string>> = {};
    for (const p of periods) {
      state[p.start] = Object.fromEntries(EMPLOYEES.map((e) => [e.id, ""]));
    }
    return state;
  }, []);

  const [hours, setHours] = useState<Record<string, Record<number, Hours>>>(() =>
    initHours(ALL_PERIODS.filter((p) => p.month === monthParam))
  );
  const [taxOverrides, setTaxOverrides] = useState<Record<string, Record<number, string>>>(() =>
    initOverrides(ALL_PERIODS.filter((p) => p.month === monthParam))
  );
  const [savedEntries, setSavedEntries] = useState<SavedEntries>({});

  useEffect(() => {
    syncFromServer().then(setSavedEntries);
  }, [selectedMonth, selectedYear]);

  const handleMonthChange = (m: number) => {
    setSelectedMonth(m);
    const newPeriods = generatePeriods(selectedYear).filter((p) => p.month === m);
    setHours(initHours(newPeriods));
    setTaxOverrides(initOverrides(newPeriods));
  };

  const handleYearChange = (y: number) => {
    setSelectedYear(y);
    const newPeriods = generatePeriods(y).filter((p) => p.month === selectedMonth);
    setHours(initHours(newPeriods));
    setTaxOverrides(initOverrides(newPeriods));
  };

  const updateHours = useCallback((periodStart: string, empId: number, field: keyof Hours, value: string) => {
    setHours((prev) => ({
      ...prev,
      [periodStart]: { ...prev[periodStart], [empId]: { ...prev[periodStart][empId], [field]: value } },
    }));
  }, []);

  const updateTax = useCallback((periodStart: string, empId: number, value: string) => {
    setTaxOverrides((prev) => ({
      ...prev,
      [periodStart]: { ...prev[periodStart], [empId]: value },
    }));
  }, []);

  const zeroRow = (emp: EmployeeDef, periodStart: string): RowData => ({
    rate: emp.getRate(periodStart),
    regular: 0, regularPay: 0, vacationPay: 0, holidayPay: 0, otherBenefit: 0,
    totalGross: 0, tax: 0, cpp: 0, ei: 0, totalDeduction: 0, netPay: 0,
    employerCPP: 0, employerEI: 0,
  });

  const periodData = useMemo(() => {
    return monthPeriods.map((period) => {
      const isLive = period.start >= LIVE_CUTOFF;
      const saved = savedEntries[period.start];
      if (isLive) {
        if (saved) {
          const rows = EMPLOYEES.map((emp) => ({
            emp,
            rate: saved[emp.id]?.rate ?? emp.getRate(period.start),
            regular: saved[emp.id]?.regular ?? 0,
            regularPay: saved[emp.id]?.regularPay ?? 0,
            vacationPay: saved[emp.id]?.vacationPay ?? 0,
            holidayPay: saved[emp.id]?.holidayPay ?? 0,
            otherBenefit: saved[emp.id]?.otherBenefit ?? 0,
            totalGross: saved[emp.id]?.totalGross ?? 0,
            tax: saved[emp.id]?.tax ?? 0,
            cpp: saved[emp.id]?.cpp ?? 0,
            ei: saved[emp.id]?.ei ?? 0,
            totalDeduction: saved[emp.id]?.totalDeduction ?? 0,
            netPay: saved[emp.id]?.netPay ?? 0,
            employerCPP: saved[emp.id]?.employerCPP ?? 0,
            employerEI: saved[emp.id]?.employerEI ?? 0,
          }));
          return { period, rows, totals: sumRows(rows.map(({ emp: _, ...r }) => r)), isLive, hasSaved: true };
        } else {
          const rows = EMPLOYEES.map((emp) => ({ emp, ...zeroRow(emp, period.start) }));
          return { period, rows, totals: sumRows(rows.map(({ emp: _, ...r }) => r)), isLive, hasSaved: false };
        }
      }
      const periodHours = hours[period.start] ?? {};
      const periodOverrides = taxOverrides[period.start] ?? {};
      const rows = EMPLOYEES.map((emp) => ({
        emp,
        ...calcRow(emp, periodHours[emp.id] ?? { regular: String(emp.defaultHours), holiday: "", otherBenefit: "" },
          period.start, periodOverrides[emp.id] ?? ""),
      }));
      return { period, rows, totals: sumRows(rows.map(({ emp: _, ...r }) => r)), isLive: false, hasSaved: null };
    });
  }, [monthPeriods, hours, taxOverrides, savedEntries]);

  const grandTotal = useMemo(() => {
    const allRows = periodData.flatMap((pd) => pd.rows.map(({ emp: _, ...r }) => r));
    return sumRows(allRows);
  }, [periodData]);

  const grandEmployerContrib = Math.round((grandTotal.employerCPP + grandTotal.employerEI) * 100) / 100;
  const grandPayableCRA = Math.round((grandTotal.totalDeduction + grandEmployerContrib) * 100) / 100;

  return (
    <main className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-full mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <Link href="/home" className="text-xs text-blue-600 hover:underline">← 홈으로</Link>
            <h1 className="text-xl font-bold text-gray-900 mt-0.5">
              Monthly Payroll — {String(selectedMonth).padStart(2, "0")}-{String(selectedYear).slice(2)}
              <span className="text-gray-400 text-sm ml-2 font-normal">({MONTH_NAMES[selectedMonth]} {selectedYear})</span>
            </h1>
          </div>
          <button onClick={() => window.print()} className="bg-gray-800 text-white px-3 py-1.5 rounded-lg text-xs hover:bg-gray-700">
            인쇄
          </button>
        </div>

        {/* Year + Month selector */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-3 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs text-gray-500 font-medium">연도:</span>
            {SUPPORTED_YEARS.map((y) => (
              <button
                key={y}
                onClick={() => handleYearChange(y)}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition ${
                  selectedYear === y ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {y}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <button
                key={m}
                onClick={() => handleMonthChange(m)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  selectedMonth === m ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {String(m).padStart(2, "0")}-{String(selectedYear).slice(2)}
              </button>
            ))}
          </div>
        </div>

        {/* Per-period tables */}
        {periodData.map(({ period, rows, totals, isLive, hasSaved }) => (
          <div key={period.start} className="mb-4">
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-gray-700">Period {period.n}: {period.label}</span>
                  {isLive && !hasSaved && (
                    <span className="text-xs text-orange-500 font-medium">⚠ 미입력</span>
                  )}
                  {isLive && hasSaved && (
                    <span className="text-xs text-green-600 font-medium">✓ 저장됨</span>
                  )}
                </div>
                <Link href={`/payroll?period=${period.start}`} className="text-xs text-blue-600 hover:underline">
                  {isLive && !hasSaved ? "급여 입력 →" : "상세 입력 →"}
                </Link>
              </div>
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold text-gray-600 min-w-[130px]">EMPLOYEE</th>
                    <th className="text-right px-3 py-2 font-semibold text-gray-600">HRS</th>
                    <th className="text-right px-3 py-2 font-semibold text-gray-600">RATE</th>
                    <th className="text-right px-3 py-2 font-semibold text-gray-600">REGULAR</th>
                    <th className="text-right px-3 py-2 font-semibold text-gray-600">VACATION</th>
                    <th className="text-right px-3 py-2 font-semibold text-gray-600">HOLIDAY</th>
                    <th className="text-right px-3 py-2 font-semibold text-gray-600">OTHER</th>
                    <th className="text-right px-3 py-2 font-semibold text-gray-600 bg-blue-50">TOTAL GROSS</th>
                    <th className="text-right px-3 py-2 font-semibold text-gray-600">TAX</th>
                    <th className="text-right px-3 py-2 font-semibold text-gray-600">CPP</th>
                    <th className="text-right px-3 py-2 font-semibold text-gray-600">EI</th>
                    <th className="text-right px-3 py-2 font-semibold text-gray-600 bg-red-50">TOTAL DED.</th>
                    <th className="text-right px-3 py-2 font-semibold text-gray-600 bg-green-50">NET PAY</th>
                    <th className="px-2 py-2 text-gray-400 text-xs">HRS</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ emp, ...row }) => (
                    <tr key={emp.id} className={`border-b border-gray-50 hover:bg-gray-50 ${isLive && !hasSaved ? "opacity-50" : ""}`}>
                      <td className="px-3 py-1.5 font-medium text-gray-800 text-xs">
                        {emp.name}
                        {emp.eiExempt && <span className="ml-1 text-yellow-500 text-xs">*</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-600">{isLive && !hasSaved ? "-" : (row.regular || "0")}</td>
                      <td className="px-3 py-1.5 text-right text-gray-600">{fmt(row.rate)}</td>
                      <td className="px-3 py-1.5 text-right">{row.regular > 0 ? fmt(row.regularPay) : "-"}</td>
                      <td className="px-3 py-1.5 text-right">{row.regular > 0 ? fmt(row.vacationPay) : "-"}</td>
                      <td className="px-3 py-1.5 text-right">{row.holidayPay > 0 ? fmt(row.holidayPay) : "-"}</td>
                      <td className="px-3 py-1.5 text-right">{row.otherBenefit > 0 ? fmt(row.otherBenefit) : "-"}</td>
                      <td className="px-3 py-1.5 text-right font-semibold bg-blue-50">{row.totalGross > 0 ? fmt(row.totalGross) : "-"}</td>
                      <td className="px-3 py-1.5 text-right">{row.totalGross > 0 ? fmt(row.tax) : "-"}</td>
                      <td className="px-3 py-1.5 text-right">{row.totalGross > 0 ? fmt(row.cpp) : "-"}</td>
                      <td className="px-3 py-1.5 text-right">{row.ei > 0 ? fmt(row.ei) : "-"}</td>
                      <td className="px-3 py-1.5 text-right font-semibold bg-red-50">{row.totalGross > 0 ? fmt(row.totalDeduction) : "-"}</td>
                      <td className="px-3 py-1.5 text-right font-semibold bg-green-50">{row.totalGross > 0 ? fmt(row.netPay) : "-"}</td>
                      <td className="px-2 py-1.5">
                        {!isLive && (
                          <input
                            type="number"
                            value={hours[period.start]?.[emp.id]?.regular ?? String(emp.defaultHours)}
                            onChange={(e) => updateHours(period.start, emp.id, "regular", e.target.value)}
                            className="w-12 border border-gray-200 rounded px-1 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 text-center"
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-100 border-t-2 border-gray-300">
                  <tr>
                    <td className="px-3 py-1.5 font-bold text-gray-700 text-xs" colSpan={3}>Period Total</td>
                    <td className="px-3 py-1.5 text-right font-bold text-xs">{fmt(totals.regularPay)}</td>
                    <td className="px-3 py-1.5 text-right font-bold text-xs">{fmt(totals.vacationPay)}</td>
                    <td className="px-3 py-1.5 text-right font-bold text-xs">{totals.holidayPay > 0 ? fmt(totals.holidayPay) : "-"}</td>
                    <td className="px-3 py-1.5 text-right font-bold text-xs">{totals.otherBenefit > 0 ? fmt(totals.otherBenefit) : "-"}</td>
                    <td className="px-3 py-1.5 text-right font-bold text-xs bg-blue-100">{fmt(totals.totalGross)}</td>
                    <td className="px-3 py-1.5 text-right font-bold text-xs">{fmt(totals.tax)}</td>
                    <td className="px-3 py-1.5 text-right font-bold text-xs">{fmt(totals.cpp)}</td>
                    <td className="px-3 py-1.5 text-right font-bold text-xs">{fmt(totals.ei)}</td>
                    <td className="px-3 py-1.5 text-right font-bold text-xs bg-red-100">{fmt(totals.totalDeduction)}</td>
                    <td className="px-3 py-1.5 text-right font-bold text-xs bg-green-100">{fmt(totals.netPay)}</td>
                    <td className="px-2 py-1.5"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        ))}

        {/* Grand Total */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto mb-4">
          <table className="w-full text-xs">
            <tbody>
              <tr className="bg-gray-800 text-white">
                <td className="px-3 py-2 font-bold" colSpan={7}>Grand Total — {String(selectedMonth).padStart(2, "0")}-26</td>
                <td className="px-3 py-2 text-right font-bold bg-blue-700">{fmt(grandTotal.totalGross)}</td>
                <td className="px-3 py-2 text-right font-bold">{fmt(grandTotal.tax)}</td>
                <td className="px-3 py-2 text-right font-bold">{fmt(grandTotal.cpp)}</td>
                <td className="px-3 py-2 text-right font-bold">{fmt(grandTotal.ei)}</td>
                <td className="px-3 py-2 text-right font-bold bg-red-700">{fmt(grandTotal.totalDeduction)}</td>
                <td className="px-3 py-2 text-right font-bold bg-green-700">{fmt(grandTotal.netPay)}</td>
                <td className="px-2 py-2"></td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* PAYABLE TO CRA - Monthly */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">
            PAYABLE TO CRA — {String(selectedMonth).padStart(2, "0")}-26
          </h2>
          <div className="max-w-xs">
            <table className="text-xs w-full">
              <tbody>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-600">Employee Deductions</td>
                  <td className="py-1.5 text-right font-medium w-28">{fmt(grandTotal.totalDeduction)}</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-500 pl-3">↳ Income Tax</td>
                  <td className="py-1.5 text-right text-gray-500">{fmt(grandTotal.tax)}</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-500 pl-3">↳ Employee CPP</td>
                  <td className="py-1.5 text-right text-gray-500">{fmt(grandTotal.cpp)}</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-500 pl-3">↳ Employee EI</td>
                  <td className="py-1.5 text-right text-gray-500">{fmt(grandTotal.ei)}</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-600">Company Contribution</td>
                  <td className="py-1.5 text-right font-medium">{fmt(grandEmployerContrib)}</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-500 pl-3">↳ Employer CPP</td>
                  <td className="py-1.5 text-right text-gray-500">{fmt(grandTotal.employerCPP)}</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-500 pl-3">↳ Employer EI (×1.4)</td>
                  <td className="py-1.5 text-right text-gray-500">{fmt(grandTotal.employerEI)}</td>
                </tr>
                <tr className="bg-blue-50">
                  <td className="py-2 font-bold text-blue-900">Total Payable to CRA</td>
                  <td className="py-2 text-right font-bold text-blue-900">{fmt(grandPayableCRA)}</td>
                </tr>
              </tbody>
            </table>
            <p className="text-xs text-gray-400 mt-2">* Kim, Jeong: EI exempt (shareholder-directors)</p>
          </div>
        </div>
      </div>
    </main>
  );
}

export default function MonthPage() {
  return (
    <Suspense fallback={<div className="p-8 text-gray-500">Loading...</div>}>
      <MonthContent />
    </Suspense>
  );
}
