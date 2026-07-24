import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Palimpsest",
    short_name: "Palimpsest",
    description:
      "A shared canvas edited with GPT Image 2. Add to the image and explore every revision.",
    start_url: "/",
    display: "standalone",
    background_color: "#4f46d8",
    theme_color: "#21185e",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
