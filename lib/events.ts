export type EventItem = {
  id: string;
  companyName: string;
  eventName: string;
  pocName: string;
  pocPhone: string;
  phase: "Ideation" | "Pitching" | "Bidding" | "Preparation" | "Ongoing" | "Finished";
  fromDate: string;
  toDate: string;
  vendorIds: string[];
  artistIds: string[];
};

export const seedEvents: EventItem[] = [
  {
    id: "1",
    companyName: "Velocity Events",
    eventName: "Annual Gala",
    pocName: "S. Nair",
    pocPhone: "+91 98765 43210",
    status: "Active",
    fromDate: "2026-02-10",
    toDate: "2026-02-12",
    vendorIds: ["1", "2"]
  },
  {
    id: "2",
    companyName: "Velocity Events",
    eventName: "Product Launch",
    pocName: "R. Mehta",
    pocPhone: "+91 91234 56789",
    status: "Inactive",
    fromDate: "2025-12-05",
    toDate: "2025-12-06",
    vendorIds: ["2", "3"]
  }
];
