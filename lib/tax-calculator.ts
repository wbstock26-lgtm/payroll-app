// Canada / Alberta Bi-Weekly Payroll Calculator (CRA Formula Method)
// EI rate: 1.63% through Oct 2026, 1.64% from Nov 2026 (period 23+)
// Employer EI = Employee EI × 1.4

const PAY_PERIODS = 26;

const CPP = {
  employeeRate: 0.0595,
  maxPensionableEarnings: 68500,
  basicExemption: 3500,
};

// EI rate: 1.63% (Jan–Oct 2026), 1.64% (Nov 2026+)
function getEIRate(periodDate: string): number {
  return periodDate >= "2026-11-08" ? 0.0164 : 0.0163;
}

const MAX_INSURABLE = 63200;

const FEDERAL_BRACKETS = [
  { min: 0,      max: 57375,  rate: 0.15  },
  { min: 57375,  max: 114750, rate: 0.205 },
  { min: 114750, max: 158519, rate: 0.26  },
  { min: 158519, max: 220000, rate: 0.29  },
  { min: 220000, max: Infinity, rate: 0.33 },
];

const AB_BRACKETS = [
  { min: 0,      max: 148269, rate: 0.10 },
  { min: 148269, max: 177922, rate: 0.12 },
  { min: 177922, max: 237230, rate: 0.13 },
  { min: 237230, max: 355845, rate: 0.14 },
  { min: 355845, max: Infinity, rate: 0.15 },
];

const FEDERAL_BPA = 15705;
const AB_BPA = 21003;

function bracketTax(income: number, brackets: typeof FEDERAL_BRACKETS): number {
  let tax = 0;
  for (const b of brackets) {
    if (income <= b.min) break;
    tax += (Math.min(income, b.max) - b.min) * b.rate;
  }
  return tax;
}

export function calculateBiweeklyPayroll(
  biweeklyGross: number,
  eiExempt = false,
  periodDate = "2026-01-01"
) {
  const annualGross = biweeklyGross * PAY_PERIODS;

  // CPP (employee = employer, same rate)
  const pensionable = Math.max(0, Math.min(annualGross, CPP.maxPensionableEarnings) - CPP.basicExemption);
  const annualCPP = pensionable * CPP.employeeRate;

  // EI
  const eiRate = getEIRate(periodDate);
  const annualEI = eiExempt ? 0 : Math.min(annualGross, MAX_INSURABLE) * eiRate;

  // Federal income tax
  const fedTaxable = Math.max(0, annualGross - FEDERAL_BPA);
  const fedGross = bracketTax(fedTaxable, FEDERAL_BRACKETS);
  const fedCredit = (annualCPP + annualEI) * 0.15;
  const annualFedTax = Math.max(0, fedGross - fedCredit);

  // Alberta provincial tax
  const abTaxable = Math.max(0, annualGross - AB_BPA);
  const abGross = bracketTax(abTaxable, AB_BRACKETS);
  const abCredit = (annualCPP + annualEI) * 0.10;
  const annualABTax = Math.max(0, abGross - abCredit);

  const r = (n: number) => Math.round(n * 100) / 100;

  const tax = r((annualFedTax + annualABTax) / PAY_PERIODS);
  const cpp = r(annualCPP / PAY_PERIODS);
  const ei = r(annualEI / PAY_PERIODS);
  const employerCPP = cpp;
  const employerEI = r(ei * 1.4);

  const totalDeduction = r(tax + cpp + ei);
  const netPay = r(biweeklyGross - totalDeduction);
  const employerCost = r(biweeklyGross + employerCPP + employerEI);

  return { tax, cpp, ei, employerCPP, employerEI, totalDeduction, netPay, employerCost };
}

export function fmt(amount: number): string {
  return amount.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
