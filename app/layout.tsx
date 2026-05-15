import type { Metadata } from "next";
import { Boogaloo, Share_Tech_Mono } from "next/font/google";
import "./globals.css";

const boogaloo = Boogaloo({
  weight: "400",
  variable: "--font-display",
  subsets: ["latin"],
});

const shareTechMono = Share_Tech_Mono({
  weight: "400",
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AUX BATTLE",
  description: "The ultimate music bracket showdown",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${boogaloo.variable} ${shareTechMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-display">{children}</body>
    </html>
  );
}
