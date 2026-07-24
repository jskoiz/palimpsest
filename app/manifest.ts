import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Palimpsest",
    short_name: "Palimpsest",
    description:
      "Palimpsest is a shared canvas edited with GPT Image 2—named for a surface rewritten while traces of what came before remain.",
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
