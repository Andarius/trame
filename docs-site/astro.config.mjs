// @ts-check
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import starlight from '@astrojs/starlight';

// ```mermaid fences → <pre class="mermaid"> so expressive-code skips them; rendered client-side (see head script).
function remarkMermaid() {
	const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const walk = (node) => {
		if (!node.children) return;
		node.children.forEach((child, i) => {
			if (child.type === 'code' && child.lang === 'mermaid') {
				node.children[i] = { type: 'html', value: `<pre class="mermaid">${esc(child.value)}</pre>` };
			} else walk(child);
		});
	};
	return walk;
}

const mermaidScript = `
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
const srcs = new WeakMap();
async function render() {
	const nodes = [...document.querySelectorAll('pre.mermaid')];
	if (!nodes.length) return;
	const dark = document.documentElement.dataset.theme !== 'light';
	const fontFamily = 'ui-sans-serif, system-ui, sans-serif';
	mermaid.initialize({
		startOnLoad: false,
		theme: 'base',
		// htmlLabels off: site CSS breaks foreignObject label measurement (clipped text)
		flowchart: { htmlLabels: false },
		themeVariables: dark
			? { darkMode: true, background: '#0c0d10', primaryColor: '#2e2019', primaryTextColor: '#e8e6e3',
				primaryBorderColor: '#c98a63', lineColor: '#7a7f8e', secondaryColor: '#16181d',
				tertiaryColor: '#16181d', fontFamily }
			: { primaryColor: '#f4e4d8', primaryTextColor: '#1a1a1a', primaryBorderColor: '#a86740',
				lineColor: '#555', fontFamily },
	});
	for (const n of nodes) {
		if (!srcs.has(n)) srcs.set(n, n.textContent);
		n.removeAttribute('data-processed');
		n.textContent = srcs.get(n);
	}
	await mermaid.run({ nodes });
}
render();
new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
`;

// https://astro.build/config
export default defineConfig({
	// On Pages PAGES_BASE='/trame'; unset locally → served at root.
	site: 'https://andarius.github.io',
	base: process.env.PAGES_BASE || '/',
	markdown: { processor: unified({ remarkPlugins: [remarkMermaid] }) },
	integrations: [
		starlight({
			title: 'Trame',
			description: 'Documentation for Trame, the local-first session tracker.',
			customCss: ['./src/styles/custom.css'],
			editLink: { baseUrl: 'https://github.com/Andarius/trame/edit/master/docs-site/' },
			tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
			head: [{ tag: 'script', attrs: { type: 'module' }, content: mermaidScript }],
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/Andarius/trame' },
			],
			sidebar: [
				{
					label: 'Architecture',
					items: [
						{ label: 'Data model', slug: 'data-model' },
						{ label: 'Hub API & sync', slug: 'sync-walkthrough' },
					],
				},
				{
					label: 'Releases',
					collapsed: true,
					items: [{ autogenerate: { directory: 'releases' } }],
				},
			],
		}),
	],
});
