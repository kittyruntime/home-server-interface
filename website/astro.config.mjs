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
      // The dev setup page links the local dev server on purpose.
      plugins: [starlightLinksValidator({ errorOnLocalLinks: false })],
      sidebar: [
        {
          label: "Guide",
          items: [
            "guide/install",
            { label: "Features", items: [{ autogenerate: { directory: "guide/features" } }] },
            "guide/manage-without-hsi",
          ],
        },
        { label: "Reference", items: ["reference/configuration", "reference/storage-plans"] },
        { label: "Development", items: ["development/architecture", "development/setup", "development/design-system"] },
      ],
    }),
  ],
})
