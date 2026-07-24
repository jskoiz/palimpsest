import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { siteUrlFromHeaders } from "@/lib/site-url";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const metadataBase = siteUrlFromHeaders(requestHeaders);
  const title = "Palimpsest";
  const description =
    "Palimpsest is a shared canvas edited with GPT Image 2—named for a surface rewritten while traces of what came before remain.";

  return {
    metadataBase,
    title: {
      default: title,
      template: "%s | Palimpsest",
    },
    description,
    applicationName: "Palimpsest",
    alternates: {
      canonical: "/",
    },
    category: "art",
    manifest: "/manifest.webmanifest",
    icons: {
      icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
      shortcut: "/icon.svg",
      apple: "/apple-touch-icon.png",
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
        "max-video-preview": -1,
      },
    },
    openGraph: {
      type: "website",
      title,
      description,
      url: "/",
      siteName: "Palimpsest",
      locale: "en_US",
      images: [
        {
          url: "/og.png",
          width: 1200,
          height: 630,
          alt: "Purple Palimpsest social card with its GPT Image 2 description and the meaning of palimpsest",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og.png"],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#21185e",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
