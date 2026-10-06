import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import starlightLinksValidator from "starlight-links-validator"

export default defineConfig({
  site: "https://kittyruntime.github.io",
  base: "/home-server-interface",
  integrations: [
    starlight({
      title: "Home Server Interface",
      description: "A modern home server dashboard for self-hosting apps, media and storage.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/kittyruntime/home-server-interface" }],
      editLink: { baseUrl: "https://github.com/kittyruntime/home-server-interface/edit/main/website/" },
      plugins: [starlightLinksValidator()],
      sidebar: [],
    }),
  ],
})
