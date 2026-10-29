# @eutaxy/site

**Purpose.** The documentation site, [eutaxy.dev](https://eutaxy.dev):
VitePress pages for the guide, the platforms and the reference, and the
`pages` workflow that deploys them to GitHub Pages from `main`. Never
published to npm.

**Public surface.** None; it is pages. `pnpm --filter @eutaxy/site dev`
serves it locally, `build` writes `.vitepress/dist`. The Design and Roadmap
pages include `docs/design.md` and `docs/roadmap.md` as written. SEO
(canonical URLs, Open Graph, JSON-LD, sitemap) lives in
`.vitepress/config.ts`; `og.svg` is the source of `public/og.png`.

**May import.** `vitepress` only (a dev dependency), and it reads
`packages/eutaxy/package.json` for the version in the nav. Its Markdown is
outside Biome, whose Markdown formatter rewrites YAML front matter.
