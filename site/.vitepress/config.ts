import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig, type HeadConfig, type PageData } from "vitepress";

const origin = "https://eutaxy.dev";
const repo = "https://github.com/Kaisenwerk/eutaxy";
const npm = "https://www.npmjs.com/package/eutaxy";
const description =
  "Eutaxy finds the bugs that crashes, retries and concurrency cause in Cloudflare Workers by deterministic simulation, and proves your TypeScript core in Lean 4 and Z3.";
const ogImage = `${origin}/og.png`;

/** The published package's version, so the nav never names a stale release. */
const version = (
  JSON.parse(
    readFileSync(new URL("../../packages/eutaxy/package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

/** `guide/index.md` is served at `/guide/` and `guide/specs.md` at `/guide/specs` (clean URLs). */
function pageUrl(relativePath: string): string {
  const path = relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "");
  return `${origin}/${path}`;
}

/** Canonical URL, Open Graph and Twitter tags, and structured data for one page. */
function seoHead(page: PageData): HeadConfig[] {
  const url = pageUrl(page.relativePath);
  const home = page.relativePath === "index.md";
  const title = home ? page.title : `${page.title} | Eutaxy`;
  const pageDescription = page.description || description;
  const website = { "@type": "WebSite", "@id": `${origin}/#website`, url: `${origin}/` };
  const structured = home
    ? [
        { ...website, name: "Eutaxy", description, inLanguage: "en-US" },
        {
          "@type": "SoftwareApplication",
          "@id": `${origin}/#software`,
          name: "Eutaxy",
          description,
          url: `${origin}/`,
          applicationCategory: "DeveloperApplication",
          operatingSystem: "Node.js 24",
          license: "https://www.apache.org/licenses/LICENSE-2.0",
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          sameAs: [repo, npm],
        },
      ]
    : [
        {
          "@type": "TechArticle",
          headline: page.title,
          description: pageDescription,
          url,
          inLanguage: "en-US",
          isPartOf: { "@id": `${origin}/#website` },
          about: { "@id": `${origin}/#software` },
          ...(page.lastUpdated ? { dateModified: new Date(page.lastUpdated).toISOString() } : {}),
        },
        {
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Eutaxy", item: `${origin}/` },
            { "@type": "ListItem", position: 2, name: page.title, item: url },
          ],
        },
      ];
  return [
    ["link", { rel: "canonical", href: url }],
    ["meta", { property: "og:type", content: home ? "website" : "article" }],
    ["meta", { property: "og:url", content: url }],
    ["meta", { property: "og:title", content: title }],
    ["meta", { property: "og:description", content: pageDescription }],
    ["meta", { name: "twitter:title", content: title }],
    ["meta", { name: "twitter:description", content: pageDescription }],
    [
      "script",
      { type: "application/ld+json" },
      JSON.stringify({ "@context": "https://schema.org", "@graph": structured }),
    ],
  ];
}

/** Pages that include a file from `docs/`: their date is that file's last commit, not the wrapper's. */
const includedFrom: Readonly<Record<string, string>> = {
  "reference/design.md": "docs/design.md",
  "reference/roadmap.md": "docs/roadmap.md",
};

/** The last commit time of a repository file in milliseconds, or undefined outside git history. */
function lastCommitted(file: string): number | undefined {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%ct", "--", file], {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
    }).trim();
    return out ? Number(out) * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export default defineConfig({
  lang: "en-US",
  title: "Eutaxy",
  titleTemplate: ":title | Eutaxy",
  description,
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: origin },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }],
    ["meta", { name: "theme-color", content: "#0f766e" }],
    ["meta", { property: "og:site_name", content: "Eutaxy" }],
    ["meta", { property: "og:locale", content: "en_US" }],
    ["meta", { property: "og:image", content: ogImage }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    [
      "meta",
      {
        property: "og:image:alt",
        content: "Eutaxy: deterministic simulation and formal proof for Cloudflare Workers",
      },
    ],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: ogImage }],
  ],
  transformPageData(page) {
    const included = includedFrom[page.relativePath];
    const committed = included === undefined ? undefined : lastCommitted(included);
    if (committed !== undefined) page.lastUpdated = committed;
    page.frontmatter["head"] = [...(page.frontmatter["head"] ?? []), ...seoHead(page)];
  },
  // GitHub Pages already answers 404.html with status 404; this keeps it out of indexes either way.
  transformHead({ pageData }) {
    return pageData.isNotFound ? [["meta", { name: "robots", content: "noindex" }]] : [];
  },
  themeConfig: {
    logo: { light: "/logo-light.svg", dark: "/logo-dark.svg", alt: "" },
    nav: [
      { text: "Guide", link: "/guide/what-is-eutaxy", activeMatch: "^/guide/" },
      { text: "Platforms", link: "/platforms/cloudflare", activeMatch: "^/platforms/" },
      { text: "Reference", link: "/reference/cli", activeMatch: "^/reference/" },
      {
        text: `v${version}`,
        items: [
          { text: "Changelog", link: `${repo}/blob/main/CHANGELOG.md` },
          { text: "npm", link: npm },
          { text: "Contributing", link: `${repo}/blob/main/CONTRIBUTING.md` },
        ],
      },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "What is Eutaxy?", link: "/guide/what-is-eutaxy" },
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "Scenarios", link: "/guide/scenarios" },
          { text: "Invariants", link: "/guide/invariants" },
          { text: "Faults and exploration", link: "/guide/faults" },
          { text: "Specs", link: "/guide/specs" },
          { text: "Provers", link: "/guide/provers" },
          { text: "Verdicts", link: "/guide/verdicts" },
        ],
      },
      {
        text: "Platforms",
        items: [
          { text: "Cloudflare Workers", link: "/platforms/cloudflare" },
          { text: "AWS Lambda", link: "/platforms/aws" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "CLI", link: "/reference/cli" },
          { text: "Design", link: "/reference/design" },
          { text: "Roadmap", link: "/reference/roadmap" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: repo, ariaLabel: "Eutaxy on GitHub" },
      { icon: "npm", link: npm, ariaLabel: "eutaxy on npm" },
    ],
    editLink: {
      // Serialized into the client bundle as source text, so it may not use this module's names.
      pattern: ({ filePath }) =>
        `https://github.com/Kaisenwerk/eutaxy/edit/main/${
          filePath.startsWith("reference/design.") || filePath.startsWith("reference/roadmap.")
            ? `docs/${filePath.slice("reference/".length)}`
            : `site/${filePath}`
        }`,
      text: "Edit this page on GitHub",
    },
    search: { provider: "local" },
    outline: { level: [2, 3] },
    footer: {
      message: `Released under the <a href="${repo}/blob/main/LICENSE">Apache-2.0 License</a>.`,
    },
  },
});
