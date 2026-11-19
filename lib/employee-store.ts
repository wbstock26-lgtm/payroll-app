// Employee list: the payroll database is the source of truth; the browser keeps a cache copy.

export interface StoredEmployee {
  id: number;
  name: string;
  sin: string;
  dob: string;
  address: string;
  hourlyRate: number;
}

const LS_KEY = "payroll-employees";
const LS_SINS = "payroll-employee-sins";

function cacheLocally(list: StoredEmployee[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
    const sins: Record<string, string> = {};
    list.forEach((e) => { sins[e.name] = e.sin; });
    localStorage.setItem(LS_SINS, JSON.stringify(sins));
  } catch {}
}

function readLocal(): StoredEmployee[] | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as StoredEmployee[]) : null;
  } catch { return null; }
}

/** Save to the database (and cache in the browser). Returns true only if the server saved it. */
export async function saveEmployees(list: StoredEmployee[]): Promise<boolean> {
  cacheLocally(list);
  try {
    const res = await fetch("/api/employees", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employees: list }),
    });
    if (!res.ok) return false;
    const j = await res.json().catch(() => ({}));
    return j.ok === true;
  } catch { return false; }
}

/**
 * Load employees. Order: database → (first run) the list this browser had before → null.
 * A list found only in this browser is copied into the database automatically.
 */
export async function loadEmployees(): Promise<{ list: StoredEmployee[] | null; fromServer: boolean }> {
  try {
    const res = await fetch("/api/employees", { cache: "no-store" });
    if (res.ok) {
      const { employees } = (await res.json()) as { employees: StoredEmployee[] | null };
      if (employees) { cacheLocally(employees); return { list: employees, fromServer: true }; }
      const local = readLocal();
      if (local) await saveEmployees(local); // one-time move from browser to database
      return { list: local, fromServer: true };
    }
  } catch {}
  return { list: readLocal(), fromServer: false };
}

/** SIN lookup by employee name (for pay stubs). */
export async function loadEmployeeSins(): Promise<Record<string, string>> {
  const { list } = await loadEmployees();
  const sins: Record<string, string> = {};
  (list || []).forEach((e) => { sins[e.name] = e.sin; });
  if (Object.keys(sins).length) return sins;
  try { return JSON.parse(localStorage.getItem(LS_SINS) || "{}"); } catch { return {}; }
}
