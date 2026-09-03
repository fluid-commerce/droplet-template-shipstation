import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ShipStation Droplet",
  description: "ShipStation fulfillment for the Fluid platform",
  icons: { icon: "/icon.svg", apple: "/icon.png" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="h-full antialiased">{children}</body>
    </html>
  );
}
