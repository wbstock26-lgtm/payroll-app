"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import * as XLSX from "xlsx-js-style";
import { calculateBiweeklyPayroll, fmt } from "@/lib/tax-calculator";
import { Suspense } from "react";
import { loadSavedEntries, savePeriodEntriesRemote, syncFromServer, LIVE_CUTOFF, SavedPeriod } from "@/lib/payroll-store";

interface EmployeeDef {
  id: number;
  name: string;
  eiExempt: boolean;
  defaultHours: number;
  getRate: (period: string) => number;
  getDefaultTax: (period: string) => number;
}

// CRA payroll table values hardcoded from 2026 Excel payroll records.
// Kim & Jeong: EI exempt (shareholder-directors of 2078680 Alberta Ltd.)
// Nam rate: $21.63/hr before 2026-06-21, $22.63/hr from 2026-06-21
// Tax reduced from period starting 2026-10-25 (CRA table update)
const EMPLOYEES: EmployeeDef[] = [
  {
    id: 1,
    name: "Kim, Woo Jeon",
    eiExempt: true,
    defaultHours: 80,
    getRate: () => 25.00,
    getDefaultTax: (p) => p >= "2026-10-25" ? 246.57 : 265.41,
  },
  {
    id: 2,
    name: "Jeong, Jae Yeon",
    eiExempt: true,
    defaultHours: 80,
    getRate: () => 25.00,
    getDefaultTax: (p) => p >= "2026-10-25" ? 246.57 : 265.41,
  },
  {
    id: 3,
    name: "Lee, Sang Yeol",
    eiExempt: false,
    defaultHours: 80,
    getRate: () => 25.00,
    getDefaultTax: (p) => p >= "2026-10-25" ? 239.74 : 257.95,
  },
  {
    id: 4,
    name: "Nam, Young Gil",
    eiExempt: false,
    defaultHours: 75,
    getRate: (p) => p >= "2026-06-21" ? 22.63 : 21.63,
    getDefaultTax: (p) => p >= "2026-06-21" ? 193.93 : 178.07,
  },
];

const VACATION_RATE = 0.04;

// All pay periods for end-date lookup
const ALL_PERIODS = [
  { start: "2025-12-21", end: "2026-01-03" },
  { start: "2026-01-04", end: "2026-01-17" },
  { start: "2026-01-18", end: "2026-01-31" },
  { start: "2026-02-01", end: "2026-02-14" },
  { start: "2026-02-15", end: "2026-02-28" },
  { start: "2026-03-01", end: "2026-03-14" },
  { start: "2026-03-15", end: "2026-03-28" },
  { start: "2026-03-29", end: "2026-04-11" },
  { start: "2026-04-12", end: "2026-04-25" },
  { start: "2026-04-26", end: "2026-05-09" },
  { start: "2026-05-10", end: "2026-05-23" },
  { start: "2026-05-24", end: "2026-06-06" },
  { start: "2026-06-07", end: "2026-06-20" },
  { start: "2026-06-21", end: "2026-07-04" },
  { start: "2026-07-05", end: "2026-07-18" },
  { start: "2026-07-19", end: "2026-08-01" },
  { start: "2026-08-02", end: "2026-08-15" },
  { start: "2026-08-16", end: "2026-08-29" },
  { start: "2026-08-30", end: "2026-09-12" },
  { start: "2026-09-13", end: "2026-09-26" },
  { start: "2026-09-27", end: "2026-10-10" },
  { start: "2026-10-11", end: "2026-10-24" },
  { start: "2026-10-25", end: "2026-11-07" },
  { start: "2026-11-08", end: "2026-11-21" },
  { start: "2026-11-22", end: "2026-12-05" },
  { start: "2026-12-06", end: "2026-12-19" },
];

interface Hours {
  regular: string;
  holiday: string;
  otherBenefit: string;
}

function PayrollContent() {
  const params = useSearchParams();
  const period = params.get("period") ?? "";

  // Editable date range state
  const matchedPeriod = ALL_PERIODS.find((p) => p.start === period);
  const [startDate, setStartDate] = useState(period || "2026-01-04");
  const [endDate, setEndDate] = useState(matchedPeriod?.end ?? "2026-01-17");
  const periodDate = startDate || "2026-01-01";

  // Format date "2025-12-21" → "25/12/21"
  const fmtDate = (d: string) => {
    if (!d) return "";
    const [y, m, dd] = d.split("-");
    return `${y.slice(2)}/${m}/${dd}`;
  };
  const periodLabel = startDate && endDate ? `${fmtDate(startDate)}~${fmtDate(endDate)}` : "";

  const isLivePeriod = (startDate || "2026-01-01") >= LIVE_CUTOFF;
  const initHoursMap: Record<number, Hours> = Object.fromEntries(
    EMPLOYEES.map((e) => [e.id, { regular: isLivePeriod ? "" : String(e.defaultHours), holiday: "", otherBenefit: "" }])
  );
  const [hours, setHours] = useState<Record<number, Hours>>(initHoursMap);
  const [taxOverrides, setTaxOverrides] = useState<Record<number, string>>(
    Object.fromEntries(EMPLOYEES.map((e) => [e.id, ""]))
  );
  const [cppOverrides, setCppOverrides] = useState<Record<number, string>>(
    Object.fromEntries(EMPLOYEES.map((e) => [e.id, ""]))
  );
  const [eiOverrides, setEiOverrides] = useState<Record<number, string>>(
    Object.fromEntries(EMPLOYEES.map((e) => [e.id, ""]))
  );
  const [isSaved, setIsSaved] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [acctStatus, setAcctStatus] = useState<"idle" | "sending" | "ok" | "error">("idle");

  // 이전 기간의 tax를 기본값 힌트로 사용
  // 저장된 값이 있으면 그 값, 없으면 이전 기간의 CRA 기본값
  const prevTaxHint = useMemo(() => {
    const idx = ALL_PERIODS.findIndex((p) => p.start === startDate);
    if (idx <= 0) return null;
    const prevStart = ALL_PERIODS[idx - 1].start;
    const prev = loadSavedEntries()[prevStart];
    return Object.fromEntries(
      EMPLOYEES.map((e) => [
        e.id,
        prev?.[e.id]?.tax ?? e.getDefaultTax(prevStart),
      ])
    ) as Record<number, number>;
  }, [startDate]);

  // 이전 기간 저장 데이터 존재 여부
  const hasPrevData = useMemo(() => {
    const idx = ALL_PERIODS.findIndex((p) => p.start === startDate);
    if (idx <= 0) return false;
    const prevStart = ALL_PERIODS[idx - 1].start;
    return !!loadSavedEntries()[prevStart];
  }, [startDate]);

  // 이전 기간 데이터 복사
  const copyFromPrev = useCallback(() => {
    const idx = ALL_PERIODS.findIndex((p) => p.start === startDate);
    if (idx <= 0) return;
    const prevStart = ALL_PERIODS[idx - 1].start;
    const prev = loadSavedEntries()[prevStart];
    if (!prev) return;
    setHours(Object.fromEntries(
      EMPLOYEES.map((e) => [e.id, {
        regular: String(prev[e.id]?.regular ?? ""),
        holiday: String(prev[e.id]?.holiday || ""),
        otherBenefit: String(prev[e.id]?.otherBenefit || ""),
      }])
    ));
    setTaxOverrides(Object.fromEntries(
      EMPLOYEES.map((e) => [e.id, prev[e.id]?.taxOverride ?? ""])
    ));
    setIsSaved(false);
  }, [startDate]);

  // URL period 파라미터가 바뀌면 startDate를 동기화
  useEffect(() => {
    if (!period) return;
    setStartDate(period);
    const matched = ALL_PERIODS.find((p) => p.start === period);
    if (matched) setEndDate(matched.end);
  }, [period]);

  // Load this period: browser copy first (instant), then the database (source of truth)
  const [savedEntries, setSavedEntries] = useState(() => loadSavedEntries());
  useEffect(() => {
    syncFromServer().then((merged) =>
      // Only replace when the database differs for this period, so typing is never reset
      setSavedEntries((prev) =>
        JSON.stringify(prev[startDate]) === JSON.stringify(merged[startDate]) ? prev : merged));
  }, [startDate]);

  useEffect(() => {
    const entries = savedEntries;
    const saved = entries[startDate];
    const live = startDate >= LIVE_CUTOFF;
    if (saved) {
      setHours(Object.fromEntries(
        EMPLOYEES.map((e) => [e.id, {
          regular: String(saved[e.id]?.regular ?? (live ? "" : e.defaultHours)),
          holiday: String(saved[e.id]?.holiday || ""),
          otherBenefit: String(saved[e.id]?.otherBenefit || ""),
        }])
      ));
      setTaxOverrides(Object.fromEntries(EMPLOYEES.map((e) => [e.id, saved[e.id]?.taxOverride ?? ""])));
      setCppOverrides(Object.fromEntries(EMPLOYEES.map((e) => [e.id, ""])));
      setEiOverrides(Object.fromEntries(EMPLOYEES.map((e) => [e.id, ""])));
      setIsSaved(true);
    } else {
      setHours(Object.fromEntries(
        EMPLOYEES.map((e) => [e.id, {
          regular: live ? "" : String(e.defaultHours),
          holiday: "",
          otherBenefit: "",
        }])
      ));
      setTaxOverrides(Object.fromEntries(EMPLOYEES.map((e) => [e.id, ""])));
      setCppOverrides(Object.fromEntries(EMPLOYEES.map((e) => [e.id, ""])));
      setEiOverrides(Object.fromEntries(EMPLOYEES.map((e) => [e.id, ""])));
      setIsSaved(false);
    }
  }, [startDate, savedEntries]);

  const update = useCallback((id: number, field: keyof Hours, value: string) => {
    setHours((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
    setIsSaved(false);
  }, []);

  const rows = useMemo(() => {
    return EMPLOYEES.map((emp) => {
      const h = hours[emp.id];
      const rate = emp.getRate(periodDate);
      const regular = parseFloat(h.regular || "0");
      const holidayHrs = parseFloat(h.holiday || "0");
      const otherBenefit = parseFloat(h.otherBenefit || "0");

      const regularPay = regular * rate;
      const holidayPay = Math.round(holidayHrs * rate * 100) / 100;
      const vacationPay = Math.round((regularPay + holidayPay) * VACATION_RATE * 100) / 100;
      const totalGross = Math.round((regularPay + holidayPay + vacationPay + otherBenefit) * 100) / 100;

      const calc = calculateBiweeklyPayroll(totalGross, emp.eiExempt, periodDate);

      // Tax: manual override → 이전 기간 tax → CRA table default (0 if no hours)
      const taxOv = taxOverrides[emp.id];
      const tax = totalGross === 0 ? 0
        : taxOv !== "" ? parseFloat(taxOv)
        : prevTaxHint?.[emp.id] ?? emp.getDefaultTax(periodDate);

      // CPP / EI: manual override → calculated value
      const cppOv = cppOverrides[emp.id];
      const cpp = cppOv !== "" ? parseFloat(cppOv) : calc.cpp;

      const eiOv = eiOverrides[emp.id];
      const ei = emp.eiExempt ? 0 : (eiOv !== "" ? parseFloat(eiOv) : calc.ei);

      const totalDeduction = Math.round((tax + cpp + ei) * 100) / 100;
      const netPay = Math.round((totalGross - totalDeduction) * 100) / 100;
      const employerEI = Math.round(ei * 1.4 * 100) / 100;

      return {
        ...emp,
        rate,
        regular,
        regularPay,
        holidayPay,
        otherBenefit,
        vacationPay,
        totalGross,
        tax,
        cpp,
        ei,
        totalDeduction,
        netPay,
        employerCPP: cpp,
        employerEI,
      };
    });
  }, [hours, taxOverrides, cppOverrides, eiOverrides, periodDate]);

  const totals = useMemo(() => ({
    regularPay:     rows.reduce((s, r) => s + r.regularPay, 0),
    holidayPay:     rows.reduce((s, r) => s + r.holidayPay, 0),
    otherBenefit:   rows.reduce((s, r) => s + r.otherBenefit, 0),
    vacationPay:    rows.reduce((s, r) => s + r.vacationPay, 0),
    totalGross:     rows.reduce((s, r) => s + r.totalGross, 0),
    tax:            rows.reduce((s, r) => s + r.tax, 0),
    cpp:            rows.reduce((s, r) => s + r.cpp, 0),
    ei:             rows.reduce((s, r) => s + r.ei, 0),
    totalDeduction: rows.reduce((s, r) => s + r.totalDeduction, 0),
    netPay:         rows.reduce((s, r) => s + r.netPay, 0),
    employerCPP:    rows.reduce((s, r) => s + r.employerCPP, 0),
    employerEI:     rows.reduce((s, r) => s + r.employerEI, 0),
  }), [rows]);

  const companyContrib = Math.round((totals.employerCPP + totals.employerEI) * 100) / 100;
  const payableToCRA = Math.round((totals.totalDeduction + companyContrib) * 100) / 100;

  function handleSave() {
    const data: SavedPeriod = Object.fromEntries(
      rows.map((row) => [row.id, {
        regular: row.regular,
        holiday: parseFloat(hours[row.id]?.holiday || "0"),
        otherBenefit: row.otherBenefit,
        taxOverride: taxOverrides[row.id] ?? "",
        rate: row.rate,
        regularPay: row.regularPay,
        holidayPay: row.holidayPay,
        vacationPay: row.vacationPay,
        totalGross: row.totalGross,
        tax: row.tax,
        cpp: row.cpp,
        ei: row.ei,
        totalDeduction: row.totalDeduction,
        netPay: row.netPay,
        employerCPP: row.employerCPP,
        employerEI: row.employerEI,
      }])
    );
    setSaveError(false);
    savePeriodEntriesRemote(startDate, data).then((ok) => {
      if (!ok) {
        setSaveError(true);
        setIsSaved(false);
        alert("⚠️ 급여 데이터를 데이터베이스에 저장하지 못했습니다.\n이 브라우저에는 임시로 남아 있고, 다음에 급여 화면을 열 때 다시 저장을 시도합니다.\n급여 서버가 실행 중인지 확인한 뒤 다시 💾 저장을 눌러 주세요.");
        return;
      }
      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 2500);
    });
  }

  async function sendToAccounting() {
    setAcctStatus("sending");
    // ATB account id = 25; one Salary entry per employee
    const entries = rows.map((row) => ({
      accountId: 25,
      date: endDate,
      category: "Salary",
      payee: row.name,
      withdrawal_amount: Math.round(row.netPay * 100) / 100,
      withdrawal_gst: 0,
      deposit_amount: 0,
      deposit_gst: 0,
    }));
    try {
      const results = await Promise.all(
        entries.map((payload) =>
          fetch("/api/accounting", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        )
      );
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        setAcctStatus("ok");
        setTimeout(() => setAcctStatus("idle"), 3000);
      } else {
        alert(`⚠️ ${failed.length}개 항목 등록 실패 (${results.length - failed.length}개는 성공)`);
        setAcctStatus("error");
        setTimeout(() => setAcctStatus("idle"), 3000);
      }
    } catch {
      alert("⚠️ 회계장부 서버에 연결할 수 없습니다 (127.0.0.1:8765).");
      setAcctStatus("error");
      setTimeout(() => setAcctStatus("idle"), 3000);
    }
  }

  function downloadPayStubs() {
    const currentIdx = ALL_PERIODS.findIndex((p) => p.start === startDate);
    const activePeriods = currentIdx >= 0 ? ALL_PERIODS.slice(0, currentIdx + 1) : ALL_PERIODS;
    const thru = activePeriods.length;

    const colLetter = (n: number): string => {
      let s = "";
      while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
      return s;
    };
    const KC = colLetter(11);
    const LC = colLetter(10 + thru);
    const pEnd = (d: string) => d.slice(5, 10);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const dtLong = (d: string) => {
      const [y, m, dd] = d.split("-");
      return `${months[parseInt(m) - 1]} ${parseInt(dd)}, ${y}`;
    };
    const sumN = (arr: number[]) => Math.round(arr.reduce((s, v) => s + v, 0) * 100) / 100;

    type PD = {
      hours: number; rate: number; regularPay: number; holidayPay: number;
      otherBenefit: number; vacPay: number; totalGross: number;
      tax: number; cpp: number; ei: number; totalDed: number; netPay: number;
      vacEarned: number; vacPaid: number;
    };

    function calcPeriod(emp: EmployeeDef, p: { start: string; end: string }): PD {
      const sv = savedEntries[p.start]?.[emp.id];
      if (sv && sv.netPay !== undefined) {
        const vp = sv.vacationPay ?? 0;
        return {
          hours: sv.regular ?? 0, rate: sv.rate ?? emp.getRate(p.start),
          regularPay: sv.regularPay ?? 0, holidayPay: sv.holidayPay ?? 0,
          otherBenefit: sv.otherBenefit ?? 0, vacPay: vp,
          totalGross: sv.totalGross ?? 0, tax: sv.tax ?? 0,
          cpp: sv.cpp ?? 0, ei: sv.ei ?? 0,
          totalDed: sv.totalDeduction ?? 0, netPay: sv.netPay ?? 0,
          vacEarned: vp, vacPaid: -vp,
        };
      }
      const rate = emp.getRate(p.start);
      const h = emp.defaultHours;
      const reg = h * rate;
      const vac = Math.round(reg * VACATION_RATE * 100) / 100;
      const gross = Math.round((reg + vac) * 100) / 100;
      const cr = calculateBiweeklyPayroll(gross, emp.eiExempt, p.start);
      const tax = emp.getDefaultTax(p.start);
      const cpp = cr.cpp;
      const ei = emp.eiExempt ? 0 : cr.ei;
      const ded = Math.round((tax + cpp + ei) * 100) / 100;
      const net = Math.round((gross - ded) * 100) / 100;
      return {
        hours: h, rate, regularPay: reg, holidayPay: 0,
        otherBenefit: 0, vacPay: vac, totalGross: gross,
        tax, cpp, ei, totalDed: ded, netPay: net,
        vacEarned: vac, vacPaid: -vac,
      };
    }

    // Pre-compute period data for all 4 employees
    const allEmpData = EMPLOYEES.map((emp) => {
      const curRow = rows.find((r) => r.id === emp.id)!;
      const pdata: PD[] = activePeriods.map((p) => {
        if (p.start === startDate) {
          const vp = curRow.vacationPay;
          return {
            hours: curRow.regular, rate: curRow.rate,
            regularPay: curRow.regularPay, holidayPay: curRow.holidayPay,
            otherBenefit: curRow.otherBenefit, vacPay: vp,
            totalGross: curRow.totalGross, tax: curRow.tax,
            cpp: curRow.cpp, ei: curRow.ei,
            totalDed: curRow.totalDeduction, netPay: curRow.netPay,
            vacEarned: vp, vacPaid: -vp,
          };
        }
        return calcPeriod(emp, p);
      });
      const cur = pdata[pdata.length - 1];
      return {
        emp, cur, pdata,
        ytdH:   sumN(pdata.map(d => d.hours)),
        ytdReg: sumN(pdata.map(d => d.regularPay)),
        ytdHol: sumN(pdata.map(d => d.holidayPay)),
        ytdOth: sumN(pdata.map(d => d.otherBenefit)),
        ytdVac: sumN(pdata.map(d => d.vacPay)),
        ytdGrs: sumN(pdata.map(d => d.totalGross)),
        ytdTax: sumN(pdata.map(d => d.tax)),
        ytdCpp: sumN(pdata.map(d => d.cpp)),
        ytdEi:  sumN(pdata.map(d => d.ei)),
        ytdDed: sumN(pdata.map(d => d.totalDed)),
        ytdNet: sumN(pdata.map(d => d.netPay)),
        ytdVE:  sumN(pdata.map(d => d.vacEarned)),
        ytdVP:  sumN(pdata.map(d => d.vacPaid)),
      };
    });

    type Cell = string | number;
    const N = thru;
    const blank = (): Cell[] => Array(10 + N).fill("");
    const R = (
      desc: Cell, cH: Cell, cR: Cell, cA: Cell,
      yH: Cell, yR: Cell, yA: Cell,
      cols: Cell[]
    ): Cell[] => [desc, cH, cR, cA, "", yH, yR, yA, "", "", ...cols];

    // Company header (3 rows) + 4 × 35-row employee blocks (29 data + 6 separator)
    const allData: Cell[][] = [
      ["2078680 Alberta Ltd.", ...Array(9 + N).fill("")],
      blank(), blank(),
    ];

    for (const { emp, cur, pdata, ytdH, ytdReg, ytdHol, ytdOth, ytdVac, ytdGrs, ytdTax, ytdCpp, ytdEi, ytdDed, ytdNet, ytdVE, ytdVP } of allEmpData) {
      allData.push(
        ["", "", "", "", "", "", "Date: ", dtLong(endDate), "", "", ...activePeriods.map(p => pEnd(p.end))],
        blank(), blank(),
        ["Employee ", "", "", "", "", "", "SIN", "", "", "", ...Array(N).fill("")],
        [emp.name,   "", "", "", "", "", "",    "", "", "", ...Array(N).fill("")],
        blank(), blank(),
        ["Pay period", `${startDate} ~ ${endDate}`, ...Array(8 + N).fill("")],
        blank(),
        ["", "", "", "AMOUNT", "", "", "", "YTD AMOUNT", ...Array(2 + N).fill("")],
        ["DESCRIPTION", "HOURS", "RATE", "AMOUNT", "", "HOURS", "RATE", "AMOUNT", "", "", ...Array(N).fill("")],
        R("Wage",             cur.hours, cur.rate, cur.regularPay,  ytdH,  cur.rate, ytdReg, pdata.map(d => d.regularPay)),
        R("VacPay-Paid Out",  "",        "",        cur.vacPay,      "",    "",        ytdVac, pdata.map(d => d.vacPay)),
        R("Holiday Pay",      "",        "",        cur.holidayPay,  "",    "",        ytdHol, pdata.map(d => d.holidayPay)),
        R("Other Benefit",    "",        "",        cur.otherBenefit,"",    "",        ytdOth, pdata.map(d => d.otherBenefit)),
        R("",                 cur.hours, cur.rate,  cur.totalGross,  ytdH,  "",        ytdGrs, pdata.map(d => d.totalGross)),
        blank(),
        ["Taxes", "", "", "AMOUNT", "", "", "", "YTD AMOUNT", ...Array(2 + N).fill("")],
        R("Federal Income Tax","",       "",        cur.tax,         "",    "",        ytdTax, pdata.map(d => d.tax)),
        R("CPP-Employee",      "",       "",        cur.cpp,         "",    "",        ytdCpp, pdata.map(d => d.cpp)),
        R("EI-Employee", "", "", emp.eiExempt ? 0 : cur.ei, "", "", emp.eiExempt ? 0 : ytdEi,
          pdata.map(d => (emp.eiExempt ? 0 : d.ei) as Cell)),
        R("",                 "",        "",        cur.totalDed,    "",    "",        ytdDed, pdata.map(d => d.totalDed)),
        blank(),
        R("Net Pay",          "",        "",        cur.netPay,      "",    "",        ytdNet, pdata.map(d => d.netPay)),
        blank(),
        ["Vacation pay", ...Array(9 + N).fill("")],
        R("Earned",  "", "", cur.vacEarned, "", "", ytdVE, pdata.map(d => d.vacEarned)),
        R("Paid",    "", "", cur.vacPaid,   "", "", ytdVP, pdata.map(d => d.vacPaid)),
        R("Balance", "", "", 0,             "", "", 0,     pdata.map(() => 0 as Cell)),
        blank(), blank(), blank(), blank(), blank(), blank(),
      );
    }

    const ws = XLSX.utils.aoa_to_sheet(allData as unknown as unknown[][]);

    // Row constants (1-indexed, relative to each employee block; employee ei adds offset ei*35)
    const rW=15, rV=16, rOT=17, rH=18, rG=19;
    const rTx=22, rCP=23, rEI=24, rD=25, rN=27;
    const rVE=30, rVP=31, rVB=32;
    const dataRows = [rW,rV,rOT,rH,rG,rTx,rCP,rEI,rD,rN,rVE,rVP,rVB];
    const boldSet = new Set([rG,rD,rN]);

    const setF = (addr: string, f: string, v: number | string) => {
      ws[addr] = { ...(ws[addr] ?? {}), t: typeof v === "number" ? "n" : "s", f, v };
    };
    const thin = { style: "thin", color: { rgb: "000000" } };
    const BORDER = { top: thin, bottom: thin, left: thin, right: thin };
    const NUM = "#,##0.00";
    const applyS = (addr: string, s: Record<string, unknown>) => {
      if (ws[addr] && typeof ws[addr] === "object") {
        (ws[addr] as Record<string, unknown>).s = s;
      } else {
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

    for (let ei = 0; ei < allEmpData.length; ei++) {
      const { emp, cur, ytdReg, ytdHol, ytdOth, ytdVac, ytdGrs, ytdTax, ytdCpp, ytdEi, ytdDed, ytdNet, ytdVE, ytdVP } = allEmpData[ei];
      const o = ei * 35;
      const sr = (row: number) => `SUM(${KC}${row+o}:${LC}${row+o})`;

      // Current period (D column) formulas
      setF(`D${rW+o}`,  `B${rW+o}*C${rW+o}`,                                    cur.regularPay);
      setF(`D${rV+o}`,  `(D${rW+o}+D${rOT+o})*0.04`,                           cur.vacPay);
      setF(`D${rG+o}`,  `D${rW+o}+D${rV+o}+D${rOT+o}+D${rH+o}`,              cur.totalGross);
      setF(`D${rD+o}`,  `D${rTx+o}+D${rCP+o}+D${rEI+o}`,                      cur.totalDed);
      setF(`D${rN+o}`,  `D${rG+o}-D${rD+o}`,                                    cur.netPay);
      setF(`D${rVE+o}`, `D${rW+o}*0.04`,                                         cur.vacEarned);
      setF(`D${rVP+o}`, `-D${rVE+o}`,                                             cur.vacPaid);
      setF(`D${rVB+o}`, `D${rVE+o}+D${rVP+o}`,                                  0);

      // YTD (H column) formulas — SUM across period columns
      setF(`H${rW+o}`,  sr(rW),                                                  ytdReg);
      setF(`H${rV+o}`,  `(H${rW+o}+H${rOT+o})*0.04`,                          ytdVac);
      setF(`H${rOT+o}`, sr(rOT),                                                 ytdHol);
      setF(`H${rH+o}`,  sr(rH),                                                  ytdOth);
      setF(`H${rG+o}`,  `H${rW+o}+H${rV+o}+H${rOT+o}+H${rH+o}`,           ytdGrs);
      setF(`H${rTx+o}`, sr(rTx),                                                 ytdTax);
      setF(`H${rCP+o}`, sr(rCP),                                                 ytdCpp);
      if (!emp.eiExempt) setF(`H${rEI+o}`, sr(rEI), ytdEi);
      else ws[`H${rEI+o}`] = { ...(ws[`H${rEI+o}`] ?? {}), t: "n", v: 0 };
      setF(`H${rD+o}`,  `H${rTx+o}+H${rCP+o}+H${rEI+o}`,                    ytdDed);
      setF(`H${rN+o}`,  `H${rG+o}-H${rD+o}`,                                  ytdNet);
      setF(`H${rVE+o}`, sr(rVE),                                                 ytdVE);
      setF(`H${rVP+o}`, sr(rVP),                                                 ytdVP);
      setF(`H${rVB+o}`, `H${rVE+o}+H${rVP+o}`,                                0);

      // Last period column = $D$ reference (current period)
      const curPeriodRows: [number, number | string][] = [
        [rW, cur.regularPay], [rV,  cur.vacPay],
        [rOT,cur.holidayPay], [rH,  cur.otherBenefit],
        [rG, cur.totalGross], [rTx, cur.tax],
        [rCP,cur.cpp],        [rD,  cur.totalDed],
        [rN, cur.netPay],     [rVE, cur.vacEarned],
        [rVP,cur.vacPaid],    [rVB, 0],
      ];
      for (const [row, val] of curPeriodRows) {
        setF(`${LC}${row+o}`, `$D$${row+o}`, val);
      }
      if (!emp.eiExempt) setF(`${LC}${rEI+o}`, `$D$${rEI+o}`, cur.ei);
      else ws[`${LC}${rEI+o}`] = { ...(ws[`${LC}${rEI+o}`] ?? {}), t: "n", v: 0 };

      // Apply styles
      for (let p = 0; p < thru; p++) applyS(`${colLetter(11+p)}${4+o}`, sHdr(true));
      applyS(`A${14+o}`, sHdr());
      for (const col of ["B","C","D","F","G","H"]) applyS(`${col}${14+o}`, sHdr(true));
      for (let p = 0; p < thru; p++) applyS(`${colLetter(11+p)}${14+o}`, sHdr(true));
      for (const r of dataRows) {
        const bold = boldSet.has(r);
        applyS(`A${r+o}`, sTxt(bold));
        for (const col of ["B","C","D"]) applyS(`${col}${r+o}`, sNum(bold));
        for (const col of ["F","G","H"]) applyS(`${col}${r+o}`, sNum(bold));
        for (let p = 0; p < thru; p++) applyS(`${colLetter(11+p)}${r+o}`, sNum(bold));
      }
    }

    ws["!cols"] = [
      { wch: 22 }, { wch: 8 }, { wch: 8 }, { wch: 12 },
      { wch: 2 },  { wch: 8 }, { wch: 10 },{ wch: 14 },
      { wch: 2 },  { wch: 2 },
      ...activePeriods.map(() => ({ wch: 10 })),
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Pay Stubs");
    XLSX.writeFile(wb, `PayStub_${startDate}_${endDate}.xlsx`);
  }

  return (
    <main className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-full mx-auto">
        <div className="flex items-center justify-between mb-4">
          <div>
            <Link href="/home" className="text-xs text-blue-600 hover:underline">← 홈으로</Link>
            <h1 className="text-xl font-bold text-gray-900 mt-0.5">
              Payroll — {periodLabel || period || "기간 미선택"}
            </h1>
          </div>
          <div className="flex gap-2">
            <button
              onClick={sendToAccounting}
              disabled={acctStatus === "sending" || totals.netPay === 0}
              title={`ATB 계좌에 Salary 항목 등록 — ${endDate} · $${fmt(totals.netPay)}`}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                acctStatus === "ok" ? "bg-green-600 text-white"
                : acctStatus === "error" ? "bg-red-600 text-white"
                : acctStatus === "sending" ? "bg-purple-400 text-white cursor-wait"
                : "bg-purple-600 text-white hover:bg-purple-700"
              } disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed`}
            >
              {acctStatus === "ok" ? "✓ 회계장부 등록됨"
                : acctStatus === "error" ? "⚠️ 등록 실패"
                : acctStatus === "sending" ? "⏳ 등록 중…"
                : "📒 회계장부 등록"}
            </button>
            <button
              onClick={copyFromPrev}
              disabled={!hasPrevData}
              title={hasPrevData ? "이전 기간 데이터를 현재 기간에 복사" : "이전 기간 저장 데이터 없음"}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition bg-amber-500 text-white hover:bg-amber-600 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed"
            >
              📋 이전 기간 복사
            </button>
            <button
              onClick={handleSave}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${isSaved ? "bg-green-600 text-white" : saveError ? "bg-red-600 text-white hover:bg-red-700" : "bg-blue-600 text-white hover:bg-blue-700"}`}
            >
              {isSaved ? "✓ 저장됨" : saveError ? "⚠️ 저장 실패 — 다시 저장" : "💾 저장"}
            </button>
            <button
              onClick={downloadPayStubs}
              disabled={totals.netPay === 0}
              title="4명 개인 급여 명세서 Excel 다운로드"
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition bg-green-700 text-white hover:bg-green-800 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed"
            >
              📥 명세서 Excel
            </button>
            <button
              onClick={() => window.print()}
              className="bg-gray-800 text-white px-3 py-1.5 rounded-lg text-xs hover:bg-gray-700"
            >
              인쇄
            </button>
          </div>
        </div>

        {/* 기간 입력 */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">급여 기간 (Pay Period)</h2>
          <div className="flex items-center gap-3 flex-wrap">
            <div>
              <label className="text-xs text-gray-500 block mb-1">시작일 (Start)</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  const matched = ALL_PERIODS.find((p) => p.start === e.target.value);
                  if (matched) setEndDate(matched.end);
                }}
                className="border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
            <div className="text-gray-400 mt-4">~</div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">종료일 (End)</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
            {periodLabel && (
              <div className="mt-4 px-3 py-1.5 bg-blue-50 rounded-lg text-sm font-semibold text-blue-800">
                {periodLabel}
              </div>
            )}
          </div>
        </div>

        {/* 시간 입력 */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">근무 시간 입력</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {EMPLOYEES.map((emp) => {
              const rate = emp.getRate(periodDate);
              return (
                <div key={emp.id} className="border border-gray-100 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-gray-800">
                      {emp.name}
                      <span className="text-gray-400 text-xs ml-1">${rate.toFixed(2)}/hr</span>
                    </p>
                    {emp.eiExempt && (
                      <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded">EI Exempt</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-2">
                    <div>
                      <label className="text-xs text-gray-500 block mb-0.5">Regular (hrs)</label>
                      <input
                        type="number"
                        value={hours[emp.id].regular}
                        onChange={(e) => update(emp.id, "regular", e.target.value)}
                        className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-0.5">Holiday (hrs)</label>
                      <input
                        type="number"
                        value={hours[emp.id].holiday}
                        onChange={(e) => update(emp.id, "holiday", e.target.value)}
                        placeholder="0"
                        className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-0.5">Other Benefit ($)</label>
                      <input
                        type="number"
                        value={hours[emp.id].otherBenefit}
                        onChange={(e) => update(emp.id, "otherBenefit", e.target.value)}
                        placeholder="0"
                        className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <div>
                      <label className="text-xs text-gray-500 block mb-0.5">
                        TAX override ($)
                        <span className="text-gray-400 ml-1">
                          ({fmt(prevTaxHint?.[emp.id] ?? emp.getDefaultTax(periodDate))})
                        </span>
                      </label>
                      <input
                        type="number"
                        value={taxOverrides[emp.id]}
                        onChange={(e) => setTaxOverrides((prev) => ({ ...prev, [emp.id]: e.target.value }))}
                        placeholder="auto"
                        className="w-full border border-orange-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-orange-400"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-0.5">CPP override ($)</label>
                      <input
                        type="number"
                        value={cppOverrides[emp.id]}
                        onChange={(e) => setCppOverrides((prev) => ({ ...prev, [emp.id]: e.target.value }))}
                        placeholder="auto"
                        className="w-full border border-purple-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-purple-400"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 block mb-0.5">EI override ($)</label>
                      <input
                        type="number"
                        value={eiOverrides[emp.id]}
                        onChange={(e) => setEiOverrides((prev) => ({ ...prev, [emp.id]: e.target.value }))}
                        placeholder={emp.eiExempt ? "exempt" : "auto"}
                        disabled={emp.eiExempt}
                        className="w-full border border-teal-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-teal-400 disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 페이롤 테이블 */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto mb-4">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-gray-600 min-w-[140px]">EMPLOYEE</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600">HRS</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600">RATE</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600">REGULAR PAY</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600">HOLIDAY</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600">OTHER</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600">VACATION(4%)</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600 bg-blue-50">TOTAL GROSS</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600">TAX</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600">CPP</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600">EI</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600 bg-red-50">TOTAL DED.</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600 bg-green-50">NET PAY</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium text-gray-800">
                    {row.name}
                    {row.eiExempt && <span className="ml-1 text-yellow-600 text-xs">*</span>}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-600">{row.regular}</td>
                  <td className="px-3 py-2 text-right text-gray-600">{fmt(row.rate)}</td>
                  <td className="px-3 py-2 text-right">{fmt(row.regularPay)}</td>
                  <td className="px-3 py-2 text-right">{row.holidayPay > 0 ? fmt(row.holidayPay) : "-"}</td>
                  <td className="px-3 py-2 text-right">{row.otherBenefit > 0 ? fmt(row.otherBenefit) : "-"}</td>
                  <td className="px-3 py-2 text-right">{fmt(row.vacationPay)}</td>
                  <td className="px-3 py-2 text-right font-semibold bg-blue-50">{fmt(row.totalGross)}</td>
                  <td className="px-3 py-2 text-right">{fmt(row.tax)}</td>
                  <td className="px-3 py-2 text-right">{fmt(row.cpp)}</td>
                  <td className="px-3 py-2 text-right">{row.ei > 0 ? fmt(row.ei) : "-"}</td>
                  <td className="px-3 py-2 text-right font-semibold bg-red-50">{fmt(row.totalDeduction)}</td>
                  <td className="px-3 py-2 text-right font-semibold bg-green-50">{fmt(row.netPay)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-100 border-t-2 border-gray-300">
              <tr>
                <td className="px-3 py-2 font-bold text-gray-800" colSpan={3}>Grand Total</td>
                <td className="px-3 py-2 text-right font-bold">{fmt(totals.regularPay)}</td>
                <td className="px-3 py-2 text-right font-bold">{totals.holidayPay > 0 ? fmt(totals.holidayPay) : "-"}</td>
                <td className="px-3 py-2 text-right font-bold">{totals.otherBenefit > 0 ? fmt(totals.otherBenefit) : "-"}</td>
                <td className="px-3 py-2 text-right font-bold">{fmt(totals.vacationPay)}</td>
                <td className="px-3 py-2 text-right font-bold bg-blue-100">{fmt(totals.totalGross)}</td>
                <td className="px-3 py-2 text-right font-bold">{fmt(totals.tax)}</td>
                <td className="px-3 py-2 text-right font-bold">{fmt(totals.cpp)}</td>
                <td className="px-3 py-2 text-right font-bold">{fmt(totals.ei)}</td>
                <td className="px-3 py-2 text-right font-bold bg-red-100">{fmt(totals.totalDeduction)}</td>
                <td className="px-3 py-2 text-right font-bold bg-green-100">{fmt(totals.netPay)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* PAYABLE TO CRA */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">PAYABLE TO CRA</h2>
          <div className="max-w-xs">
            <table className="text-xs w-full">
              <tbody>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-600">Employee Deductions (TAX + CPP + EI)</td>
                  <td className="py-1.5 text-right font-medium w-28">{fmt(totals.totalDeduction)}</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-500 pl-3">↳ Income Tax</td>
                  <td className="py-1.5 text-right text-gray-500">{fmt(totals.tax)}</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-500 pl-3">↳ Employee CPP</td>
                  <td className="py-1.5 text-right text-gray-500">{fmt(totals.cpp)}</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-500 pl-3">↳ Employee EI</td>
                  <td className="py-1.5 text-right text-gray-500">{fmt(totals.ei)}</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-600">Company Contribution</td>
                  <td className="py-1.5 text-right font-medium">{fmt(companyContrib)}</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-500 pl-3">↳ Employer CPP</td>
                  <td className="py-1.5 text-right text-gray-500">{fmt(totals.employerCPP)}</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-500 pl-3">↳ Employer EI (×1.4)</td>
                  <td className="py-1.5 text-right text-gray-500">{fmt(totals.employerEI)}</td>
                </tr>
                <tr className="bg-blue-50">
                  <td className="py-2 font-bold text-blue-900">Total Payable to CRA</td>
                  <td className="py-2 text-right font-bold text-blue-900">{fmt(payableToCRA)}</td>
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

export default function PayrollPage() {
  return (
    <Suspense fallback={<div className="p-8 text-gray-500">Loading...</div>}>
      <PayrollContent />
    </Suspense>
  );
}
