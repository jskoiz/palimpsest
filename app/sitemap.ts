import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { siteUrlFromHeaders } from "@/lib/site-url";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = siteUrlFromHeaders(await headers());

  return [
    {
      url: siteUrl.origin,
      changeFrequency: "daily",
      priority: 1,
    },
  ];
}
