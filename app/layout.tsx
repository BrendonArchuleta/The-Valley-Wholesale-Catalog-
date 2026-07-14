import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Valley Wholesale — Product Catalog",
  description:
    "Search 3,055 wholesale products, build an order, and send it directly to your Valley sales rep.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
