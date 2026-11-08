// Four small inline SVG images for the sample note, embedded as data URIs so the
// bundle has no external requests.

const font = 'font-family="system-ui, sans-serif" font-size="13"';

const rack = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220" viewBox="0 0 360 220">
<rect width="360" height="220" fill="#f4f1ea"/>
<rect x="60" y="20" width="240" height="180" fill="none" stroke="#5b5346" stroke-width="3"/>
<rect x="80" y="34" width="200" height="22" rx="3" fill="#3b6e8f"/><text x="180" y="50" text-anchor="middle" fill="#fff" ${font}>Switch</text>
<rect x="80" y="62" width="200" height="22" rx="3" fill="#24323d"/><text x="180" y="78" text-anchor="middle" fill="#fff" ${font}>Router</text>
<line x1="60" y1="98" x2="300" y2="98" stroke="#5b5346" stroke-width="3"/>
<rect x="80" y="108" width="90" height="34" rx="4" fill="#8a8f98"/><text x="125" y="130" text-anchor="middle" fill="#fff" ${font}>Mini PC</text>
<rect x="190" y="108" width="90" height="34" rx="4" fill="#6b5b95"/><text x="235" y="130" text-anchor="middle" fill="#fff" ${font}>Drives</text>
<line x1="60" y1="152" x2="300" y2="152" stroke="#5b5346" stroke-width="3"/>
<rect x="120" y="160" width="120" height="36" rx="4" fill="#2f2f2f"/><text x="180" y="183" text-anchor="middle" fill="#fff" ${font}>UPS</text>
</svg>`;

const network = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200" viewBox="0 0 360 200">
<rect width="360" height="200" fill="#eef4f7"/>
<g ${font} text-anchor="middle">
<circle cx="180" cy="28" r="20" fill="#9cc3d5"/><text x="180" y="33">ISP</text>
<rect x="135" y="68" width="90" height="26" rx="4" fill="#24323d"/><text x="180" y="86" fill="#fff">Router</text>
<rect x="135" y="114" width="90" height="26" rx="4" fill="#3b6e8f"/><text x="180" y="132" fill="#fff">Switch</text>
<rect x="20" y="162" width="100" height="26" rx="4" fill="#8a8f98"/><text x="70" y="180" fill="#fff">Proxmox</text>
<rect x="130" y="162" width="100" height="26" rx="4" fill="#5f9e6e"/><text x="180" y="180" fill="#fff">AP 1</text>
<rect x="240" y="162" width="100" height="26" rx="4" fill="#5f9e6e"/><text x="290" y="180" fill="#fff">AP 2</text>
</g>
<g stroke="#24323d" stroke-width="2"><line x1="180" y1="48" x2="180" y2="68"/><line x1="180" y1="94" x2="180" y2="114"/>
<line x1="180" y1="140" x2="70" y2="162"/><line x1="180" y1="140" x2="180" y2="162"/><line x1="180" y1="140" x2="290" y2="162"/></g>
</svg>`;

const power = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200" viewBox="0 0 360 200">
<rect width="360" height="200" fill="#fbf7f0"/>
<g ${font}>
<line x1="50" y1="170" x2="340" y2="170" stroke="#5b5346"/>
<rect x="80" y="30" width="70" height="140" fill="#c0504d"/><text x="115" y="24" text-anchor="middle">95 W</text>
<rect x="210" y="146" width="70" height="24" fill="#5f9e6e"/><text x="245" y="140" text-anchor="middle">22 W</text>
<text x="115" y="188" text-anchor="middle">Before</text><text x="245" y="188" text-anchor="middle">After</text>
</g>
</svg>`;

const dashboard = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="180" viewBox="0 0 360 180">
<rect width="360" height="180" fill="#1e2329"/>
<g ${font} fill="#e8e8e8">
<rect x="14" y="14" width="102" height="70" rx="6" fill="#2b323a"/><text x="24" y="36">Uptime</text><text x="24" y="66" font-size="22" fill="#7fd18b">100%</text>
<rect x="129" y="14" width="102" height="70" rx="6" fill="#2b323a"/><text x="139" y="36">Pool used</text><text x="139" y="66" font-size="22" fill="#f2c96d">41%</text>
<rect x="244" y="14" width="102" height="70" rx="6" fill="#2b323a"/><text x="254" y="36">Backup age</text><text x="254" y="66" font-size="22" fill="#7fd18b">6 h</text>
<rect x="14" y="96" width="332" height="70" rx="6" fill="#2b323a"/>
</g>
<polyline fill="none" stroke="#6db3f2" stroke-width="2" points="24,150 60,140 96,146 132,128 168,134 204,118 240,124 276,110 312,116 336,104"/>
</svg>`;

const svgs: Record<string, string> = { rack, network, power, dashboard };

export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Replace `{{img:name}}` placeholders in the sample note with SVG data URIs. */
export function fillImages(html: string): string {
  return html.replace(/\{\{img:(\w+)\}\}/g, (_match, name: string) => {
    const svg = svgs[name];
    if (!svg) throw new Error(`Unknown sample image: ${name}`);
    return svgDataUri(svg);
  });
}
