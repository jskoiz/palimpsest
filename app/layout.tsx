import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);
  const title = "Palimpsest";
  const description =
    "A live communal canvas where people create non-overlapping AI edits in parallel and every accepted change becomes part of an immutable public history.";

  return {
    metadataBase,
    title,
    description,
    applicationName: "Palimpsest",
    keywords: [
      "collaborative art",
      "AI image editing",
      "shared canvas",
      "GPT-5.6",
      "OpenAI",
    ],
    icons: {
      icon: "/og.png",
      shortcut: "/og.png",
    },
    openGraph: {
      type: "website",
      title,
      description,
      url: "/",
      siteName: "Palimpsest",
      images: [
        {
          url: "/og.png",
          width: 1536,
          height: 1024,
          alt: "Palimpsest artwork and revision timeline",
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
  themeColor: "#141210",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
