// Server-only: copy payroll.db after every save, both next to the app and into OneDrive,
// so a disk failure on this PC does not lose payroll data.
import fs from "fs";
import os from "os";
import path from "path";

const DB_PATH = path.join(process.cwd(), "prisma", "payroll.db");
const LOCAL_DIR = path.join(process.cwd(), "prisma", "backups");
const ONEDRIVE_ROOT = process.env.OneDrive || path.join(os.homedir(), "OneDrive");
const CLOUD_DIR = path.join(ONEDRIVE_ROOT, "Little Red Deer Store Backups", "payroll");
const MAX_BACKUPS = 30;

function copyInto(dir: string, file: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(DB_PATH, path.join(dir, file));
  // Keep only the newest MAX_BACKUPS automatic copies ("payroll-<timestamp>.db")
  const auto = fs.readdirSync(dir).filter((f) => /^payroll-\d{4}-\d{2}-\d{2}T/.test(f)).sort();
  if (auto.length > MAX_BACKUPS) {
    auto.slice(0, auto.length - MAX_BACKUPS).forEach((f) => fs.unlinkSync(path.join(dir, f)));
  }
}

export function backupPayrollDb() {
  if (!fs.existsSync(DB_PATH)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = `payroll-${ts}.db`;
  for (const dir of [LOCAL_DIR, CLOUD_DIR]) {
    try { copyInto(dir, file); } catch (err) { console.error(`[backup] ${dir}:`, err); }
  }
}
