/**
 * The empty chat's goodbye on the first prompt: MarIA turns her face to the
 * user, winks, and flies into the header mark while the conversation fades in.
 *
 * It only paints an overlay: the prompt is posted before it starts and nothing
 * here waits on the host. The logo is one flat drawing, so a WebGL2 shader
 * animates it as a 2.5D rig: the face turns almost rigidly (a sideways swing
 * plus a long-lens rotation of its plane, so it never bulges or squashes), the
 * hair around it trails on a spring, the head tilts
 * around the neck, and the wink slides her upper eyelid (the liner and its
 * lashes) down onto the lower lash line while the brow dips, the cheek rises and
 * the mouth corner lifts. The rig's landmarks are coordinates in
 * `maria-logo.png` (480 px square); a new logo needs them measured again.
 *
 * One clock drives everything (rig, flight, captions, conversation, header
 * mark), so the whole goodbye lasts `TOTAL_MS`. Without WebGL2 the logo flies
 * without the face animation; with reduced motion the captions just fade.
 */
import { h } from "../dom";

/** Last frame, ms after the send. */
const TOTAL_MS = 2950;
const LOGO_PX = 480;
/** `maria-mark.png` (the header mark) is this square of `maria-logo.png`. */
const MARK_CROP: Crop = { x: 124, y: 105, size: 280 };
const FULL_CROP: Crop = { x: 0, y: 0, size: LOGO_PX };

/** Head turn towards the user (radians of the face plane), tilt and chin lift at full pose. */
const TURN_YAW = 0.18;
const TURN_ROLL = -0.045;
const TURN_NOD = 0.05;
/** Extra tilt (radians, towards her winking eye) while she winks. */
const WINK_TILT = 0.03;

interface Crop {
	x: number;
	y: number;
	size: number;
}

interface Pose {
	yaw: number;
	hairYaw: number;
	roll: number;
	nod: number;
	/** 0 open … 1 her left eye closed. */
	wink: number;
	/** Brow dip and cheek raise around the wink. */
	squint: number;
	smile: number;
	/** 1 shows the title and the Unicaja symbol around her, 0 fades them. */
	surround: number;
}

/** What the goodbye animates; every element stays owned by the caller. */
export interface FarewellScene {
	/** The empty chat's logo: it is hidden while its double plays. */
	brand: HTMLElement;
	/** The empty chat's container, hidden while the goodbye plays. */
	empty: HTMLElement;
	/** Title, hint and prompts under the logo: they fade out. */
	captions: readonly HTMLElement[];
	/** The conversation, faded in as she leaves. */
	conversation: readonly HTMLElement[];
	/** The header mark she lands on. */
	mark: HTMLElement;
	onDone: () => void;
}

let logoImage: Promise<HTMLImageElement> | undefined;
let decodedLogo: HTMLImageElement | undefined;

function loadLogo(): Promise<HTMLImageElement> {
	logoImage ??= (async () => {
		const image = new Image();
		image.src = MARIA_LOGO_URL;
		await image.decode();
		decodedLogo = image;
		return image;
	})();
	return logoImage;
}

/** Decodes the logo ahead of the send, so the first frame paints at once. */
export function preloadFarewell(): void {
	// A failed decode surfaces again in `playFarewell`, which then skips the face animation.
	loadLogo().catch(() => undefined);
}

export function playFarewell(scene: FarewellScene): void {
	const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
	const overlay = h("div", { className: "farewell", ariaHidden: "true" });
	const brandRect = scene.brand.getBoundingClientRect();
	// With reduced motion the logo just fades with the captions.
	const captions = (reduced ? [scene.brand, ...scene.captions] : scene.captions)
		.filter(element => !element.hidden && element.getClientRects().length > 0)
		.map(element => captionDouble(element));
	overlay.append(...captions.map(caption => caption.element));
	document.body.append(overlay);
	scene.empty.style.visibility = "hidden";
	for (const element of scene.conversation) element.style.opacity = "0";

	let stage: LogoStage | undefined;
	let fallback: HTMLElement | undefined;
	// Without WebGL2 (or the decoded logo) the plain logo flies, without the face animation.
	const useFallback = () => {
		stage?.dispose();
		stage = undefined;
		overlay.querySelector(".farewell-canvas")?.remove();
		fallback = h("div", { className: "empty-brand farewell-fallback" });
		overlay.append(fallback);
	};
	if (!reduced) {
		const canvas = h("canvas", { className: "farewell-canvas" });
		overlay.append(canvas);
		stage = LogoStage.create(canvas);
		if (!stage) useFallback();
		else if (decodedLogo) stage.upload(decodedLogo);
		else loadLogo().then(image => stage?.upload(image), useFallback);
	}
	// Stiff enough that the trailing hair never stretches visibly, loose enough to settle with a sway.
	const hairSpring = new Spring(24, 0.45);
	const markStyle = {
		opacity: scene.mark.style.opacity,
		transform: scene.mark.style.transform,
		filter: scene.mark.style.filter,
	};
	let target: DOMRect | undefined;
	let landsOnMark = false;

	const start = performance.now();
	const total = reduced ? 420 : TOTAL_MS;
	const frame = () => {
		const t = performance.now() - start;
		if (t >= total) {
			finish();
			return;
		}
		for (const [index, caption] of captions.entries()) caption.render(t - index * 45, reduced);
		if (reduced) {
			for (const element of scene.conversation) element.style.opacity = String(ease(range(t, 120, 420)));
			requestAnimationFrame(frame);
			return;
		}
		for (const element of scene.conversation) element.style.opacity = String(minimumJerk(range(t, 1450, 2100)));

		// The flight heads for wherever the header mark is when it starts; without one she rises and fades.
		if (t >= FLIGHT_START && !target) {
			const rect = scene.mark.getBoundingClientRect();
			landsOnMark = rect.width > 0 && rect.height > 0;
			const size = brandRect.width * 0.3;
			target = landsOnMark
				? rect
				: new DOMRect(
						brandRect.left + (brandRect.width - size) / 2,
						brandRect.top - brandRect.height * 0.4,
						size,
						size,
					);
			if (landsOnMark) scene.mark.style.opacity = "0";
		}
		const flight = flightAt(t, brandRect, target);
		const landing = range(t, 2470, 2620);
		const alpha = landsOnMark ? 1 - landing : 1 - minimumJerk(range(t, 1900, 2560));
		if (landsOnMark) {
			scene.mark.style.opacity = String(landing);
			const pulse = range(t, 2560, TOTAL_MS);
			const swell = Math.sin(Math.PI * pulse) * (1 - pulse * 0.35);
			scene.mark.style.transform = pulse > 0 ? `scale(${1 + 0.2 * swell})` : markStyle.transform;
			scene.mark.style.filter =
				pulse > 0 ? `drop-shadow(0 0 ${(5 * swell).toFixed(2)}px var(--omp-accent))` : markStyle.filter;
		}

		if (stage) {
			stage.draw(flight.rect, flight.crop, poseAt(t, hairSpring), alpha);
		} else if (fallback) {
			const { rect } = flight;
			Object.assign(fallback.style, {
				left: `${rect.x}px`,
				top: `${rect.y}px`,
				width: `${rect.size}px`,
				height: `${rect.size}px`,
				opacity: String(alpha),
			});
		}
		requestAnimationFrame(frame);
	};

	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		stage?.dispose();
		stage = undefined;
		overlay.remove();
		Object.assign(scene.mark.style, markStyle);
		for (const element of scene.conversation) element.style.opacity = "";
		scene.empty.style.visibility = "";
		// A prompt that left the chat empty (a command without messages): the logo comes back.
		if (!scene.empty.hidden)
			scene.empty.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: "ease-out" });
		scene.onDone();
	};
	// The first frame paints now, in the same frame the empty chat hides.
	frame();
}

const FLIGHT_START = 1420;
const FLIGHT_END = 2560;

/** Where the logo is drawn (CSS px) and which square of it shows, `t` ms after the send. */
function flightAt(
	t: number,
	from: DOMRect,
	to: DOMRect | undefined,
): { rect: { x: number; y: number; size: number }; crop: Crop } {
	// A breath in before she leaves.
	const anticipation = 1 + 0.035 * Math.sin(Math.PI * range(t, 1300, 1560));
	const start = { x: from.x + from.width / 2, y: from.y + from.height / 2, size: from.width * anticipation };
	if (!to || t <= FLIGHT_START) {
		return { rect: square(start.x, start.y, start.size), crop: FULL_CROP };
	}
	const p = easeInOutCubic(range(t, FLIGHT_START, FLIGHT_END));
	const end = { x: to.x + to.width / 2, y: to.y + to.height / 2, size: to.width };
	// A gentle arc: she lifts first, then glides into the header from below.
	const c1 = { x: start.x, y: start.y - Math.min(40, from.height * 0.25) };
	const c2 = { x: end.x + (start.x - end.x) * 0.2, y: end.y + (start.y - end.y) * 0.35 };
	const x = bezier(start.x, c1.x, c2.x, end.x, p);
	const y = bezier(start.y, c1.y, c2.y, end.y, p);
	// Size and crop shrink exponentially together, so her head only ever gets smaller on
	// screen, and lag the travel a little, so she leaves at full size and shrinks on approach.
	const shrink = p ** 1.6;
	const size = start.size * (end.size / start.size) ** shrink;
	const cropSize = FULL_CROP.size * (MARK_CROP.size / FULL_CROP.size) ** shrink;
	const centre = {
		x: lerp(FULL_CROP.x + FULL_CROP.size / 2, MARK_CROP.x + MARK_CROP.size / 2, shrink),
		y: lerp(FULL_CROP.y + FULL_CROP.size / 2, MARK_CROP.y + MARK_CROP.size / 2, shrink),
	};
	return {
		rect: square(x, y, size),
		crop: { x: centre.x - cropSize / 2, y: centre.y - cropSize / 2, size: cropSize },
	};
}

function poseAt(t: number, hair: Spring): Pose {
	// She turns to the user, holds while she winks, and turns back as she flies home.
	const turn = minimumJerk(range(t, 60, 760)) * (1 - minimumJerk(range(t, 1400, 2080)));
	const yaw = TURN_YAW * turn;
	const squint = minimumJerk(range(t, 790, 960)) - minimumJerk(range(t, 1200, 1420));
	return {
		yaw,
		hairYaw: hair.follow(yaw, t),
		// The head dips a touch towards the winking eye.
		roll: TURN_ROLL * turn + WINK_TILT * squint,
		nod: TURN_NOD * minimumJerk(range(t, 120, 820)) * (1 - minimumJerk(range(t, 1400, 2080))),
		// A wink closes fast, holds a beat and opens a little slower.
		wink: minimumJerk(range(t, 830, 940)) - minimumJerk(range(t, 1170, 1340)),
		squint,
		smile: minimumJerk(range(t, 430, 900)) * (1 - minimumJerk(range(t, 1500, 2000))),
		surround: 1 - minimumJerk(range(t, FLIGHT_START, 1850)),
	};
}

/** A clone of a caption at its place, fading up and out. */
function captionDouble(source: HTMLElement): { element: HTMLElement; render: (t: number, reduced: boolean) => void } {
	const rect = source.getBoundingClientRect();
	const element = source.cloneNode(true) as HTMLElement;
	element.classList.add("farewell-caption");
	Object.assign(element.style, {
		left: `${rect.left}px`,
		top: `${rect.top}px`,
		width: `${rect.width}px`,
		height: `${rect.height}px`,
	});
	return {
		element,
		render(t, reduced) {
			const p = ease(range(t, 0, reduced ? 220 : 420));
			element.style.opacity = String(1 - p);
			if (!reduced) {
				element.style.transform = `translateY(${(-8 * p).toFixed(2)}px)`;
				element.style.filter = `blur(${(3 * p).toFixed(2)}px)`;
			}
		},
	};
}

/** Damped spring (`omega` rad/s, `zeta` damping ratio) stepped at 1 ms, so frame rate never changes the motion. */
class Spring {
	#value = 0;
	#velocity = 0;
	#time = 0;
	constructor(
		private readonly omega: number,
		private readonly zeta: number,
	) {}

	follow(target: number, t: number): number {
		const steps = Math.min(4000, Math.max(0, Math.floor(t - this.#time)));
		for (let i = 0; i < steps; i++) {
			const acceleration =
				this.omega * this.omega * (target - this.#value) - 2 * this.zeta * this.omega * this.#velocity;
			this.#velocity += acceleration * 0.001;
			this.#value += this.#velocity * 0.001;
		}
		this.#time += steps;
		return this.#value;
	}
}

const VERTEX_SHADER = `#version 300 es
uniform vec4 uRect;
out vec2 vUv;
void main() {
	vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
	vUv = corner;
	gl_Position = vec4(mix(uRect.xy, uRect.zw, corner), 0.0, 1.0);
}`;

// Logo px, y down. Her left eye is the open one on the viewer's right; its
// frame runs from the inner corner (s along the eye, t across it, down), and
// the curves sample t every 4 px of s: the lid crease, the top of the liner,
// the liner's lower edge (the top of the opening) and the lower lash line.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uLogo;
uniform vec3 uCrop;
uniform float uYaw;
uniform float uHairYaw;
uniform float uRoll;
uniform float uNod;
uniform float uWink;
uniform float uSquint;
uniform float uSmile;
uniform float uSurround;
uniform float uAlpha;

in vec2 vUv;
out vec4 outColor;

const float LOGO = 480.0;
// The face turns almost rigidly: it swings sideways as one piece and its plane
// rotates under a long lens (a few percent of foreshortening, never a bulge), so
// her features keep their proportions; only the hair around the face trails.
const float SWING = 70.0;
const float FOCAL = 520.0;
const vec2 FACE = vec2(212.0, 255.0);
const float LIFT = 30.0;
const vec2 NECK = vec2(242.0, 338.0);
const vec2 NOSE = vec2(186.0, 266.0);
const vec2 FEATURES = vec2(205.0, 250.0);

const vec2 EYE = vec2(201.0, 236.0);
const vec2 EYE_S = vec2(0.872, -0.49);
const vec2 EYE_T = vec2(0.49, 0.872);
const float LID_TOP[13] = float[13](-5.0, -6.0, -8.5, -9.5, -10.5, -10.0, -9.0, -9.0, -8.5, -7.5, -6.0, -4.5, -1.0);
const float OPENING[13] = float[13](-2.0, -1.0, -3.0, -4.5, -4.5, -4.0, -3.0, -2.5, -1.5, -0.5, 1.5, 3.0, 2.5);
const float LASHES[13] = float[13](-2.0, -1.0, 5.5, 6.5, 7.5, 9.0, 9.5, 9.5, 8.5, 7.5, 5.0, 3.5, 2.5);

const vec2 BROW = vec2(212.0, 204.0);
const vec2 CHEEK = vec2(225.0, 238.0);
const vec2 MOUTH_CORNER = vec2(215.0, 277.0);
const vec2 SKIN = vec2(240.0, 256.0);

float curve(float c[13], float s) {
	float f = clamp(s / 4.0, 0.0, 12.0);
	int i = int(min(floor(f), 11.0));
	return mix(c[i], c[i + 1], f - float(i));
}

// How much a point belongs to the head: the hair, face and headphones, fading out
// down the neck (below the chin) so the collar and shoulders stay put.
float headWeight(vec2 p) {
	float inside = 1.0 - smoothstep(0.86, 1.12, length((p - vec2(255.0, 226.0)) / vec2(178.0, 150.0)));
	return inside * (1.0 - smoothstep(322.0, 352.0, p.y));
}

// The face, skull and headphones turn with the head; the hair around them trails it.
float faceWeight(vec2 p) {
	return 1.0 - smoothstep(0.85, 1.25, length((p - vec2(222.0, 238.0)) / vec2(100.0, 105.0)));
}

// Inverse projection of a plane turned by angle a about centre: the coordinate
// that lands on x once turned.
float unturn(float x, float centre, float a) {
	float u = x - centre;
	return centre + FOCAL * u / (FOCAL * cos(a) - u * sin(a));
}

vec2 rotateAround(vec2 p, vec2 c, float a) {
	vec2 d = p - c;
	float cs = cos(a), sn = sin(a);
	return c + vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y);
}

float gaussian(vec2 p, vec2 c, vec2 sigma) {
	vec2 d = p - c;
	vec2 q = vec2(dot(d, EYE_S), dot(d, EYE_T)) / sigma;
	return exp(-dot(q, q));
}

// The upper lid slides down: its margin (the liner with its lashes) keeps its
// shape, bare lid skin opens above it, the crease above smooths out as the lid
// skin unfolds, and the opening below the margin is covered. z is how much the
// point shows bare lid skin.
vec3 wink(vec2 p) {
	vec2 d = p - EYE;
	float s = dot(d, EYE_S);
	float t = dot(d, EYE_T);
	if (uWink <= 0.0 || s < 0.0 || s > 48.0) return vec3(p, 0.0);
	float top = curve(LID_TOP, s);
	float opening = curve(OPENING, s);
	float lashes = curve(LASHES, s);
	if (t < top) return vec3(p, 0.85 * uWink * smoothstep(top - 6.0, top - 3.5, t));
	if (t > lashes) return vec3(p, 0.0);
	float drop = uWink * max(lashes - opening, 0.0);
	if (t < top + drop) return vec3(p, 1.0);
	if (t < opening + drop) return vec3(p - EYE_T * drop, 0.0);
	return vec3(p, 0.0);
}

void main() {
	vec2 p = uCrop.xy + vUv * uCrop.z;
	float head = headWeight(p);

	vec2 q = rotateAround(p, NECK, -uRoll * head);
	float face = faceWeight(q);
	float yaw = mix(uHairYaw, uYaw, face) * head;
	// The eyes, nose and lips stand slightly in front of the face, so they lead it by a hair.
	vec2 f = (q - FEATURES) / vec2(48.0, 44.0);
	vec2 n = (q - NOSE) / vec2(22.0, 26.0);
	q.x -= yaw * (SWING * (1.0 + 0.06 * exp(-dot(f, f))) + 5.0 * exp(-dot(n, n)));
	q.x = unturn(q.x, FACE.x, yaw);
	float nod = uNod * head;
	q.y = unturn(q.y + LIFT * nod, FACE.y, -nod);

	q -= EYE_T * (2.4 * uSquint * gaussian(q, BROW, vec2(24.0, 8.0)));
	q += EYE_T * (1.6 * uSquint * gaussian(q, CHEEK, vec2(20.0, 6.0)));
	q += vec2(-0.7, 1.6) * uSmile * exp(-dot((q - MOUTH_CORNER) / 7.0, (q - MOUTH_CORNER) / 7.0));
	vec3 lid = wink(q);
	q = lid.xy;

	// The warps are near-identity, but the lid edge is a cut: take the mip level from the
	// unwarped coordinate so the cut does not pick a blurry level.
	vec4 color = textureGrad(uLogo, q / LOGO, dFdx(p) / LOGO, dFdy(p) / LOGO);
	color = mix(color, texture(uLogo, SKIN / LOGO), lid.z);
	// The title's outline touches her hair: the cut follows the top of her head.
	float hairTop = 106.0 + 18.0 * pow((q.x - 255.0) / 95.0, 2.0);
	float surround = smoothstep(hairTop - 4.0, hairTop - 0.5, q.y) * (1.0 - smoothstep(368.0, 394.0, q.y));
	float edge = 0.07 * (1.0 - uSurround);
	vec2 border = min(vUv, 1.0 - vUv);
	float feather = edge > 0.0 ? smoothstep(0.0, edge, min(border.x, border.y)) : 1.0;
	outColor = color * (mix(surround, 1.0, uSurround) * feather * uAlpha);
}`;

/** The full-window WebGL2 canvas that draws the rigged logo. */
class LogoStage {
	#uniforms: Record<string, WebGLUniformLocation | null> = {};
	#texture: WebGLTexture | null = null;
	#ready = false;

	private constructor(
		private readonly canvas: HTMLCanvasElement,
		private readonly gl: WebGL2RenderingContext,
		private readonly program: WebGLProgram,
	) {
		for (const name of [
			"uRect",
			"uLogo",
			"uCrop",
			"uYaw",
			"uHairYaw",
			"uRoll",
			"uNod",
			"uWink",
			"uSquint",
			"uSmile",
			"uSurround",
			"uAlpha",
		]) {
			this.#uniforms[name] = gl.getUniformLocation(program, name);
		}
	}

	static create(canvas: HTMLCanvasElement): LogoStage | undefined {
		const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
		if (!gl) return undefined;
		const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
		const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
		const program = gl.createProgram();
		if (!vertex || !fragment || !program) return undefined;
		gl.attachShader(program, vertex);
		gl.attachShader(program, fragment);
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return undefined;
		return new LogoStage(canvas, gl, program);
	}

	upload(image: HTMLImageElement): void {
		const gl = this.gl;
		this.#texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this.#texture);
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
		gl.generateMipmap(gl.TEXTURE_2D);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		this.#ready = true;
	}

	/** Draws the logo in `rect` (CSS px, viewport), showing its `crop` square. */
	draw(rect: { x: number; y: number; size: number }, crop: Crop, pose: Pose, alpha: number): void {
		if (!this.#ready) return;
		const gl = this.gl;
		const ratio = window.devicePixelRatio || 1;
		const width = Math.round(window.innerWidth * ratio);
		const height = Math.round(window.innerHeight * ratio);
		if (this.canvas.width !== width || this.canvas.height !== height) {
			this.canvas.width = width;
			this.canvas.height = height;
		}
		gl.viewport(0, 0, width, height);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.useProgram(this.program);
		const u = this.#uniforms;
		const clipX = (x: number) => (x / window.innerWidth) * 2 - 1;
		const clipY = (y: number) => 1 - (y / window.innerHeight) * 2;
		gl.uniform4f(u.uRect!, clipX(rect.x), clipY(rect.y), clipX(rect.x + rect.size), clipY(rect.y + rect.size));
		gl.uniform1i(u.uLogo!, 0);
		gl.uniform3f(u.uCrop!, crop.x, crop.y, crop.size);
		gl.uniform1f(u.uYaw!, pose.yaw);
		gl.uniform1f(u.uHairYaw!, pose.hairYaw);
		gl.uniform1f(u.uRoll!, pose.roll);
		gl.uniform1f(u.uNod!, pose.nod);
		gl.uniform1f(u.uWink!, pose.wink);
		gl.uniform1f(u.uSquint!, pose.squint);
		gl.uniform1f(u.uSmile!, pose.smile);
		gl.uniform1f(u.uSurround!, pose.surround);
		gl.uniform1f(u.uAlpha!, Math.max(0, Math.min(1, alpha)));
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.#texture);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	dispose(): void {
		this.gl.deleteTexture(this.#texture);
		this.gl.deleteProgram(this.program);
		this.gl.getExtension("WEBGL_lose_context")?.loseContext();
	}
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
	const shader = gl.createShader(type);
	if (!shader) return null;
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

function square(cx: number, cy: number, size: number): { x: number; y: number; size: number } {
	return { x: cx - size / 2, y: cy - size / 2, size };
}

function range(t: number, from: number, to: number): number {
	return Math.max(0, Math.min(1, (t - from) / (to - from)));
}

/** Minimum-jerk profile: how heads and eyelids move. */
function minimumJerk(x: number): number {
	return x * x * x * (10 - 15 * x + 6 * x * x);
}

function easeInOutCubic(x: number): number {
	return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

function ease(x: number): number {
	return 1 - (1 - x) ** 3;
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function bezier(a: number, b: number, c: number, d: number, t: number): number {
	const s = 1 - t;
	return s * s * s * a + 3 * s * s * t * b + 3 * s * t * t * c + t * t * t * d;
}
