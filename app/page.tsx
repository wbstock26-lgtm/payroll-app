"use client";

import Link from "next/link";

export default function WelcomePage() {
  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden"
      style={{
        background: "linear-gradient(135deg, #1a0a00 0%, #3d1200 40%, #6b1f00 70%, #8b2500 100%)",
      }}
    >
      {/* Background pattern */}
      <div
        className="absolute inset-0 opacity-10"
        style={{
          backgroundImage:
            "radial-gradient(circle at 20% 50%, #ff6b35 0%, transparent 50%), radial-gradient(circle at 80% 20%, #ff9a3c 0%, transparent 40%), radial-gradient(circle at 60% 80%, #c0392b 0%, transparent 40%)",
        }}
      />

      {/* Deer silhouette decorative circles */}
      <div className="absolute top-10 right-10 w-64 h-64 rounded-full opacity-5 border-2 border-orange-300" />
      <div className="absolute top-20 right-20 w-44 h-44 rounded-full opacity-5 border border-orange-300" />
      <div className="absolute bottom-10 left-10 w-48 h-48 rounded-full opacity-5 border-2 border-orange-300" />

      {/* Main content */}
      <div className="relative z-10 text-center px-6 max-w-2xl">
        {/* Logo / Icon */}
        <div className="mb-8 flex justify-center">
          <div
            className="w-28 h-28 rounded-full flex items-center justify-center shadow-2xl"
            style={{ background: "rgba(255,255,255,0.08)", backdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.15)" }}
          >
            <span className="text-6xl select-none">🦌</span>
          </div>
        </div>

        {/* Store name */}
        <h1 className="text-4xl md:text-5xl font-bold text-white mb-2 tracking-wide" style={{ textShadow: "0 2px 20px rgba(0,0,0,0.5)" }}>
          Little Red Deer Store
        </h1>
        <p className="text-lg md:text-xl text-orange-200 mb-1 font-light tracking-wider">
          에 오신 걸 환영합니다
        </p>
        <div className="w-16 h-0.5 mx-auto my-6" style={{ background: "linear-gradient(90deg, transparent, #ff9a3c, transparent)" }} />
        <p className="text-sm text-orange-300 mb-12 opacity-80 tracking-widest uppercase">
          2078680 Alberta Ltd.
        </p>

        {/* Payroll button */}
        <Link href="/home">
          <button
            className="group relative px-16 py-5 rounded-2xl text-lg font-bold tracking-widest uppercase transition-all duration-300 hover:scale-105 active:scale-95"
            style={{
              background: "linear-gradient(135deg, #ff6b35, #e8471a)",
              color: "#fff",
              boxShadow: "0 8px 32px rgba(255, 107, 53, 0.45), 0 2px 8px rgba(0,0,0,0.3)",
            }}
          >
            <span className="relative z-10 flex items-center gap-3">
              <span>💼</span>
              <span>Payroll</span>
              <span className="group-hover:translate-x-1 transition-transform duration-200">→</span>
            </span>
          </button>
        </Link>

        <p className="mt-10 text-xs text-orange-400 opacity-50 tracking-wider">
          CRA 2025–2026 Payroll System
        </p>
      </div>
    </main>
  );
}
