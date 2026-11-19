"use client";

import dynamic from "next/dynamic";

// SSR disabled to avoid td-nesting hydration mismatch on first render
const PayStubClient = dynamic(
  () => import("./PayStubClient"),
  { ssr: false, loading: () => <div className="p-8 text-gray-500">Loading...</div> }
);

export default function PayStubPage() {
  return <PayStubClient />;
}
