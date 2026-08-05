import "./globals.css";
import type { ReactNode } from "react";
import { IBM_Plex_Sans, IBM_Plex_Serif, IBM_Plex_Mono } from "next/font/google";

/* Three registers of one superfamily: sans for interface, serif for headings,
   mono for figures. Shared skeleton, so they set together without clashing.
   Self-hosted by next/font — no third-party request on first paint. */

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-sans"
});

const serif = IBM_Plex_Serif({
  subsets: ["latin"],
  weight: ["600"],
  display: "swap",
  variable: "--font-serif"
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["500"],
  display: "swap",
  variable: "--font-mono"
});

export const metadata = {
  title: "Velocity ERP",
  description: "Operations, sales and finance system for Velocity Brand Server Pvt. Ltd."
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff"
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
