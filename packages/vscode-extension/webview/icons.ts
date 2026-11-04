/**
 * Lucide-style line icons built as SVG DOM nodes (no `innerHTML`, so the
 * webview CSP stays strict). Size them with CSS `width`/`height`.
 */

export type IconName =
	| "plus"
	| "history"
	| "settings"
	| "arrowUp"
	| "arrowRight"
	| "stop"
	| "chevronDown"
	| "chevronRight"
	| "back"
	| "copy"
	| "check"
	| "search"
	| "terminal"
	| "file"
	| "pencil"
	| "trash"
	| "globe"
	| "bot"
	| "eyeOff"
	| "wrench"
	| "brain"
	| "plan"
	| "shrink"
	| "eraser"
	| "handoff"
	| "python"
	| "close"
	| "mic"
	| "chevronUp"
	| "bash"
	| "plusGlobe"
	| "reply"
	| "zap"
	| "timer"
	| "layers";

const SVG_NS = "http://www.w3.org/2000/svg";

const PATHS: Record<IconName, string> = {
	plus: "M5 12h14M12 5v14",
	history: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2",
	settings:
		"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
	arrowUp: "M12 19V5M5 12l7-7 7 7",
	arrowRight: "M5 12h14M12 5l7 7-7 7",
	stop: "M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
	chevronDown: "m6 9 6 6 6-6",
	chevronUp: "m18 15-6-6-6 6",
	chevronRight: "m9 18 6-6-6-6",
	back: "M19 12H5M12 19l-7-7 7-7",
	copy: "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2zM4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
	check: "M20 6 9 17l-5-5",
	search: "M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0zM21 21l-4.3-4.3",
	terminal: "m4 17 6-6-6-6M12 19h8",
	file: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7zM14 2v4a2 2 0 0 0 2 2h4",
	pencil:
		"M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5zM15 5l4 4",
	trash: "M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6",
	globe: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0zM12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20",
	bot: "M12 8V4H8M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM2 14h2M20 14h2M15 13v2M9 13v2",
	eyeOff:
		"M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49M14.084 14.158a3 3 0 0 1-4.242-4.242M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143M2 2l20 20",
	wrench:
		"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
	brain: "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18zM12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18zM15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4M17.599 6.5a3 3 0 0 0 .399-1.375M6.003 5.125A3 3 0 0 0 6.401 6.5M3.477 10.896a4 4 0 0 1 .585-.396M19.938 10.5a4 4 0 0 1 .585.396M6 18a4 4 0 0 1-1.967-.516M19.967 17.484A4 4 0 0 1 18 18",
	plan: "M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01",
	shrink:
		"m15 15 6 6m-6-6v4.8m0-4.8h4.8M9 19.8V15m0 0H4.2M9 15l-6 6M15 4.2V9m0 0h4.8M15 9l6-6M9 4.2V9m0 0H4.2M9 9 3 3",
	eraser: "m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7M5 11l9 9",
	handoff: "m16 3 4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16",
	// The Python logo's two interlocking snakes, as an outline.
	python:
		"M12 2c-3 0-4 1.3-4 3v2h4v1H5c-2 0-3 1.5-3 4s1 4 3 4h2v-2.5c0-1.9 1.6-3.5 3.5-3.5h3c1.4 0 2.5-1.1 2.5-2.5V5c0-1.7-1-3-4-3zM12 22c3 0 4-1.3 4-3v-2h-4v-1h7c2 0 3-1.5 3-4s-1-4-3-4h-2v2.5c0 1.9-1.6 3.5-3.5 3.5h-3C9.1 14 8 15.1 8 16.5V19c0 1.7 1 3 4 3zM10 4.5h.01M14 19.5h.01",
	close: "M18 6 6 18M6 6l12 12",
	mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3",
	// A globe with a plus at its top-right corner: a new chat without a workspace.
	plusGlobe:
		"M18.88 12.61A8 8 0 1 1 12.39 6.12M3 14h16M11 6a12.2 12.2 0 0 1 0 16M11 6a12.2 12.2 0 0 0 0 16M19 2v6M16 5h6",
	reply: "m9 17-5-5 5-5M20 18v-2a4 4 0 0 0-4-4H4",
	zap: "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z",
	// A stopwatch: the scope checkpoint (how long MarIA Code has been working).
	timer: "M10 2h4M12 14l3-3M20 14a8 8 0 1 1-16 0 8 8 0 0 1 16 0z",
	// Stacked sheets (Lucide "layers"): the background tasks a chat left running.
	layers:
		"M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83zM2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17",
	// The GNU Bash logo, black-and-white icon-only variant (Wikimedia Commons
	// "Bash_Logo_black_and_white_icon_only.svg"): a hexagon with `$_` on its face.
	bash: "M73.85,18.52l-28.64-17a10.79,10.79,0,0,0-11,0l-28.64,17A11.42,11.42,0,0,0,0,28.36v34a11.42,11.42,0,0,0,5.52,9.84l28.64,17a10.79,10.79,0,0,0,11,0l28.64-17a11.42,11.42,0,0,0,5.52-9.84v-34A11.42,11.42,0,0,0,73.85,18.52ZM51.67,71.61l0,2.44a0.9,0.9,0,0,1-.42.75l-1.45.83c-0.23.12-.42,0-0.42-0.32l0-2.4a4.71,4.71,0,0,1-3.3.32,0.44,0.44,0,0,1-.16-0.54l0.52-2.21A0.92,0.92,0,0,1,46.73,70a0.58,0.58,0,0,1,.14-0.1,0.29,0.29,0,0,1,.23,0,4,4,0,0,0,3-.38,4,4,0,0,0,2.24-3.43c0-1.24-.68-1.76-2.32-1.77-2.08,0-4-.4-4.05-3.47a8.89,8.89,0,0,1,3.36-6.8l0-2.47a0.89,0.89,0,0,1,.42-0.76l1.4-.89c0.23-.12.42,0,0.42,0.33l0,2.47a4.56,4.56,0,0,1,2.74-.33,0.44,0.44,0,0,1,.18.57L54,55.16a0.94,0.94,0,0,1-.25.44,0.58,0.58,0,0,1-.14.11,0.33,0.33,0,0,1-.21,0,3.63,3.63,0,0,0-2.64.43,3.32,3.32,0,0,0-2,2.94c0,1.12.59,1.46,2.57,1.5,2.65,0,3.79,1.2,3.82,3.86A9.48,9.48,0,0,1,51.67,71.61Zm15-4.11a0.57,0.57,0,0,1-.22.55l-7.24,4.4a0.21,0.21,0,0,1-.34-0.21V70.37a0.52,0.52,0,0,1,.33-0.46l7.13-4.27a0.21,0.21,0,0,1,.34.21V67.5Zm5-41.81L44.57,42.43c-3.38,2-5.87,4.19-5.87,8.26V84.07c0,2.44,1,4,2.5,4.48a8.77,8.77,0,0,1-1.5.15,8.87,8.87,0,0,1-4.52-1.25l-28.64-17A9.42,9.42,0,0,1,2,62.36v-34a9.42,9.42,0,0,1,4.54-8.1l28.64-17a8.83,8.83,0,0,1,9,0l28.64,17a9.36,9.36,0,0,1,4.4,6.55C76.29,24.79,74.15,24.23,71.66,25.69Z",
};

/** Icons drawn as filled shapes instead of strokes. */
const FILLED: Partial<Record<IconName, true>> = { stop: true, bash: true };
/** Icons drawn on their own canvas instead of Lucide's 24×24 grid. */
const VIEW_BOXES: Partial<Record<IconName, string>> = { bash: "0 0 79.37 90.71" };

export function icon(name: IconName): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	const filled = FILLED[name] === true;
	const attrs: Record<string, string> = {
		class: `icon icon-${name}`,
		width: "16",
		height: "16",
		viewBox: VIEW_BOXES[name] ?? "0 0 24 24",
		fill: filled ? "currentColor" : "none",
		stroke: filled ? "none" : "currentColor",
		"stroke-width": "2",
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
		"aria-hidden": "true",
	};
	for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
	const path = document.createElementNS(SVG_NS, "path");
	path.setAttribute("d", PATHS[name]);
	svg.append(path);
	return svg;
}
