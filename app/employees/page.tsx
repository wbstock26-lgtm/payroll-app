"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { loadEmployees, saveEmployees } from "@/lib/employee-store";

// ── Excel export ──────────────────────────────────────────────────────────────
async function exportEmployeeExcel(employees: Employee[]) {
  const XLSX = await import("xlsx-js-style" as never) as typeof import("xlsx");

  const thin = { style: "thin", color: { rgb: "000000" } };
  const BORDER = { top: thin, bottom: thin, left: thin, right: thin };

  const sHdr = (): Record<string, unknown> => ({
    font: { bold: true, sz: 11 },
    border: BORDER,
    alignment: { horizontal: "center", vertical: "center" },
  });
  const sCell = (center?: boolean): Record<string, unknown> => ({
    font: { sz: 11 },
    border: BORDER,
    alignment: { horizontal: center ? "center" : "left", vertical: "center" },
  });

  const ws: Record<string, unknown> = {};

  const put = (r: number, c: number, v: string | number, s: Record<string, unknown>) => {
    const col = String.fromCharCode(65 + c);
    ws[`${col}${r + 1}`] = { t: typeof v === "number" ? "n" : "s", v, s };
  };

  // 3 blank rows, then header at row 4 (index 3), data rows 5–14 (index 4–13)
  const HDR = 3; // 0-based
  put(HDR, 0, "NO",      sHdr());
  put(HDR, 1, "NAME",    sHdr());
  put(HDR, 2, "SIN",     sHdr());
  put(HDR, 3, "DOB",     sHdr());
  put(HDR, 4, "ADDRESS", sHdr());

  for (let i = 0; i < 10; i++) {
    const emp = employees[i];
    const r = HDR + 1 + i;
    put(r, 0, i + 1,            sCell(true));
    put(r, 1, emp?.name    ?? "", sCell(true));
    put(r, 2, emp?.sin     ?? "", sCell(true));
    put(r, 3, emp?.dob     ?? "", sCell(true));
    put(r, 4, emp?.address ?? "", sCell(true));
  }

  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: HDR + 10, c: 4 } });
  ws["!cols"] = [
    { wch: 8 },   // A NO
    { wch: 22 },  // B NAME
    { wch: 15 },  // C SIN
    { wch: 12 },  // D DOB
    { wch: 42 },  // E ADDRESS
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "EMPLOYEE INFORMATION");
  XLSX.writeFile(wb, "Employee_List.xlsx");
}

interface Employee {
  id: number;
  name: string;
  sin: string;
  dob: string;
  address: string;
  hourlyRate: number;
}

const initialEmployees: Employee[] = [
  { id: 1, name: "Kim, Woo Jeon",   sin: "660 252 867", dob: "", address: "265 Royal Elm Road NW Calgary T3G-0G8",    hourlyRate: 25.00 },
  { id: 2, name: "Jeong, Jae Yeon", sin: "660 372 434", dob: "", address: "62 Valley Creek RD NW Calgary T3B-5V1",    hourlyRate: 25.00 },
  { id: 3, name: "Lee, Sang Yeol",  sin: "658 318 993", dob: "", address: "#132 Hampstead Green NW Calgary T3A-6H2",  hourlyRate: 25.00 },
  { id: 4, name: "Nam, Young Gil",  sin: "954 661 179", dob: "", address: "208 Edgeland Rise NW Calgary T3A-4E9",     hourlyRate: 22.63 },
];

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[]>(initialEmployees);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const loaded = useRef(false);
  const skipNextSave = useRef(false);

  // Load from the payroll database (first run: moves this browser's list into the database)
  useEffect(() => {
    loadEmployees().then(({ list }) => {
      // No list anywhere yet → show the built-in defaults; they are saved on the first edit.
      // (Never write defaults automatically: another browser may still hold the real, edited list.)
      if (list) { skipNextSave.current = true; setEmployees(list); }
      loaded.current = true;
    });
  }, []);

  // Every change is written to the database
  useEffect(() => {
    if (!loaded.current) return;
    if (skipNextSave.current) { skipNextSave.current = false; return; }
    setSaveState("saving");
    saveEmployees(employees).then((ok) => {
      setSaveState(ok ? "saved" : "error");
      if (ok) setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 2500);
    });
  }, [employees]);
  const [showForm, setShowForm] = useState(false);
  const emptyForm = { name: "", sin: "", dob: "", address: "", hourlyRate: "" };
  const [form, setForm] = useState(emptyForm);

  function handleSave() {
    if (!form.name || !form.hourlyRate) return;
    if (editing) {
      setEmployees(employees.map((e) =>
        e.id === editing.id
          ? { ...e, name: form.name, sin: form.sin, dob: form.dob, address: form.address, hourlyRate: Number(form.hourlyRate) }
          : e
      ));
      setEditing(null);
    } else {
      setEmployees([...employees, {
        id: Date.now(),
        name: form.name,
        sin: form.sin,
        dob: form.dob,
        address: form.address,
        hourlyRate: Number(form.hourlyRate),
      }]);
    }
    setForm(emptyForm);
    setShowForm(false);
  }

  function handleEdit(emp: Employee) {
    setEditing(emp);
    setForm({ name: emp.name, sin: emp.sin, dob: emp.dob, address: emp.address, hourlyRate: String(emp.hourlyRate) });
    setShowForm(true);
  }

  function handleDelete(id: number) {
    setEmployees(employees.filter((e) => e.id !== id));
  }

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <Link href="/home" className="text-sm text-blue-600 hover:underline">← 홈으로</Link>
            <h1 className="text-2xl font-bold text-gray-900 mt-1">직원 관리</h1>
            {saveState === "saved" && <p className="text-xs text-green-700 mt-1">✓ 데이터베이스에 저장됨</p>}
            {saveState === "saving" && <p className="text-xs text-gray-500 mt-1">저장 중…</p>}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => exportEmployeeExcel(employees)}
              className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition text-sm"
            >
              📥 Excel 출력
            </button>
            <button
              onClick={() => { setShowForm(true); setEditing(null); setForm(emptyForm); }}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition text-sm"
            >
              + 직원 추가
            </button>
          </div>
        </div>

        {saveState === "error" && (
          <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            ⚠️ 직원 정보를 데이터베이스에 저장하지 못했습니다. 급여 서버가 실행 중인지 확인한 뒤 다시 수정하거나 새로고침해 주세요.
            (지금 내용은 이 브라우저에 임시로 남아 있습니다.)
          </div>
        )}

        {showForm && (
          <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6 shadow-sm">
            <h2 className="font-semibold text-gray-800 mb-4">{editing ? "직원 수정" : "직원 추가"}</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">이름 (Last, First)</label>
                <input
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Kim, Woo Jeon"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">SIN</label>
                <input
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={form.sin}
                  onChange={(e) => setForm({ ...form, sin: e.target.value })}
                  placeholder="000 000 000"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">생년월일 (DOB)</label>
                <input
                  type="date"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={form.dob}
                  onChange={(e) => setForm({ ...form, dob: e.target.value })}
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm text-gray-600 mb-1">주소 (Address)</label>
                <input
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  placeholder="123 Main St NW Calgary T2X-0A1"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">시급 (CAD/hr)</label>
                <input
                  type="number"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={form.hourlyRate}
                  onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })}
                  placeholder="25.00"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-4">
              <button onClick={handleSave} className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700">
                저장
              </button>
              <button onClick={() => setShowForm(false)} className="border border-gray-300 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
                취소
              </button>
            </div>
          </div>
        )}

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-center px-4 py-3 font-medium text-gray-600 w-10">NO</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">NAME</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">SIN</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">DOB</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">ADDRESS</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">RATE</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {employees.map((emp, idx) => (
                <tr key={emp.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-3 text-center text-gray-400">{idx + 1}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{emp.name}</td>
                  <td className="px-4 py-3 text-gray-600 font-mono">{emp.sin}</td>
                  <td className="px-4 py-3 text-gray-500">{emp.dob || "—"}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{emp.address}</td>
                  <td className="px-4 py-3 text-right text-gray-900">${emp.hourlyRate.toFixed(2)}/hr</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button onClick={() => handleEdit(emp)} className="text-blue-600 text-sm hover:underline mr-3">수정</button>
                    <button onClick={() => handleDelete(emp.id)} className="text-red-500 text-sm hover:underline">삭제</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
