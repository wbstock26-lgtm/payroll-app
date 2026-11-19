"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { generatePeriods, SUPPORTED_YEARS } from "@/lib/periods";

const NAV_CARDS = [
  { href: (y: number, p: string) => `/payroll?period=${p}`, icon: "💰", label: "급여 계산", desc: "Pay Period 입력 및 계산", color: "from-orange-500 to-red-500" },
  { href: (y: number) => `/month?y=${y}`, icon: "📅", label: "월간 합산", desc: "한 달 전체 기간 합산 · CRA 납부액", color: "from-blue-500 to-indigo-500" },
  { href: (y: number) => `/annual?y=${y}`, icon: "📊", label: "연간 합산", desc: `연간 급여 합산 및 인쇄`, color: "from-emerald-500 to-teal-500" },
  { href: (y: number) => `/paystub?y=${y}`, icon: "🧾", label: "개인별 명세서", desc: "직원별 YTD 명세 · Excel 출력", color: "from-purple-500 to-violet-500" },
  { href: () => `/employees`, icon: "👥", label: "직원 관리", desc: "시급 및 직원 정보 수정", color: "from-slate-500 to-gray-600" },
  { href: (y: number) => `/accountant?y=${y}`, icon: "📋", label: "회계사 제출 자료", desc: "연간 급여 요약 · Excel 출력", color: "from-amber-500 to-yellow-500" },
];

export default function HomePage() {
  const [year, setYear] = useState(2026);
  const [currentMonth, setCurrentMonth] = useState(11);
  useEffect(() => { setCurrentMonth(new Date().getMonth() + 1); }, []);

  const PAY_PERIODS = generatePeriods(year);
  const [selected, setSelected] = useState(PAY_PERIODS[PAY_PERIODS.length - 1].start);

  const handleYearChange = (y: number) => {
    setYear(y);
    const periods = generatePeriods(y);
    setSelected(periods[periods.length - 1].start);
  };

  const selectedPeriod =
    generatePeriods(year).find((p) => p.start === selected) ??
    generatePeriods(year)[generatePeriods(year).length - 1];

  const getHref = (card: typeof NAV_CARDS[number]) => {
    return card.href(year, selectedPeriod.start);
  };

  return (
    <main className="min-h-screen bg-[#f4f5f8] text-slate-900">
      {/* Top bar */}
      <div
        className="sticky top-0 z-20 flex items-center justify-between px-6 py-3 border-b border-gray-200"
        style={{ background: "rgba(255,255,255,0.85)", backdropFilter: "blur(12px)" }}
      >
        {/* Logo = Home: back to the shared start screen (회계장부 / 급여 관리) */}
        <a
          href="http://127.0.0.1:8765/"
          title="처음 화면으로 (회계장부 / 급여 관리)"
          className="flex items-center gap-2 group rounded-xl px-2 py-1 -mx-2 -my-1 hover:bg-gray-100 transition"
        >
          <span className="text-xl">🦌</span>
          <div>
            <p className="text-xs font-bold text-red-700 tracking-wider leading-none">Little Red Deer Store</p>
            <p className="text-[10px] text-gray-500 leading-none mt-0.5">2078680 Alberta Ltd.</p>
          </div>
        </a>

        {/* Year selector */}
        <div className="flex items-center gap-1 bg-gray-100 border border-gray-200 rounded-xl px-3 py-1.5">
          <span className="text-xs text-gray-500 mr-2">Year</span>
          {SUPPORTED_YEARS.map((y) => (
            <button
              key={y}
              onClick={() => handleYearChange(y)}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition ${
                year === y
                  ? "bg-orange-500 text-white shadow-md shadow-orange-500/30"
                  : "text-gray-600 hover:text-gray-900 hover:bg-white"
              }`}
            >
              {y}
            </button>
          ))}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">Payroll Manager</h1>
          <p className="text-gray-500 text-sm mt-1">Bi-Weekly · 26 periods per year</p>
        </div>

        {/* Pay Period selector */}
        <div className="bg-white border border-gray-200 rounded-2xl p-5 mb-8 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-700 tracking-wide uppercase">Pay Period 선택</h2>
            <span className="text-xs text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full">{year}년</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PAY_PERIODS.map((p) => (
              <Link key={p.start} href={`/payroll?period=${p.start}`}>
                <button
                  onClick={() => setSelected(p.start)}
                  className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all ${
                    selected === p.start
                      ? "bg-orange-500 text-white shadow-md shadow-orange-500/30 scale-105"
                      : "bg-gray-50 text-gray-600 hover:bg-orange-50 hover:text-orange-700 border border-gray-200 hover:border-orange-200"
                  }`}
                >
                  <span className="opacity-50 mr-0.5">{p.n}.</span>{p.label}
                </button>
              </Link>
            ))}
          </div>
        </div>

        {/* Navigation cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {NAV_CARDS.map((card) => (
            <Link key={card.label} href={getHref(card)}>
              <div className="group relative bg-white border border-gray-200 rounded-2xl p-5 shadow-sm hover:shadow-md hover:-translate-y-0.5 hover:border-gray-300 transition-all duration-200 cursor-pointer overflow-hidden">
                {/* Gradient accent */}
                <div className={`absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r ${card.color} opacity-70 group-hover:opacity-100 transition-opacity`} />
                <div className="flex items-start gap-4">
                  <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-xl bg-gradient-to-br ${card.color} shadow-lg flex-shrink-0`}>
                    {card.icon}
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-semibold text-slate-900 text-sm mb-0.5 group-hover:text-orange-600 transition-colors">{card.label}</h3>
                    <p className="text-gray-500 text-xs leading-relaxed">{card.desc}</p>
                  </div>
                </div>
                <div className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-300 group-hover:text-gray-500 group-hover:translate-x-0.5 transition-all">›</div>
              </div>
            </Link>
          ))}
        </div>

        <p className="mt-8 text-center text-xs text-gray-500">
          CRA 2025–2026 기준 &nbsp;·&nbsp; 세액은 CRA Payroll Deductions Online Calculator로 확인하세요.
        </p>
      </div>
    </main>
  );
}
