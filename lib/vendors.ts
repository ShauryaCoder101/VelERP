export type VendorSummary = {
  id: number;
  companyName: string;
};

export const seedVendors: VendorSummary[] = [
  { id: 1, companyName: "Apex Stageworks" },
  { id: 2, companyName: "Pulse Audio Co." },
  { id: 3, companyName: "Lumen Lights" }
];
