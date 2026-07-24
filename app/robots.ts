import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { siteUrlFromHeaders } from "@/lib/site-url";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const siteUrl = siteUrlFromHeaders(await headers());

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/debug"],
    },
    sitemap: new URL("/sitemap.xml", siteUrl).toString(),
    host: siteUrl.origin,
  };
}
