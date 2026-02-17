import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Velocity Brand Server Pvt. Ltd. - Event Management ERP",
  description: "ERP dashboard layout for an event management firm."
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
