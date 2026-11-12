export const adminMaintenanceLinks = [
  {
    href: "/enrichment-queue",
    label: "Enrichment Queue",
    description: "Review proposed updates to donor and contact information.",
  },
  {
    href: "/data-cleanup",
    label: "Data Cleanup",
    description: "Resolve missing fields, possible duplicates, and research items.",
  },
  {
    href: "/payment-intermediaries",
    label: "Payment Intermediaries",
    description: "Maintain entities that route payments on behalf of donors.",
  },
  {
    href: "/fundable-projects",
    label: "Fundable Projects",
    description: "Maintain project designations, fundraising goals, and progress.",
  },
] as const;
