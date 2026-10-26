import { device } from '../core/stage';

/**
 * GPU capability tiers from the unmasked WebGL renderer string plus device hints. Tier 0 is software rendering or no
 * WebGL, 1 is integrated or older mobile GPUs, 2 is mid-range (recent integrated, current phones), 3 is discrete or
 * Apple silicon. It is a starting point: `AdaptiveQuality` corrects it from real frame times.
 */
export type QualityTier = 0 | 1 | 2 | 3;

export interface GPUInfo {
  renderer: string;
  vendor: string;
  tier: QualityTier;
  /** Which rule decided the tier. */
  reason: string;
  mobile: boolean;
  webgl2: boolean;
}

export interface DeviceHints {
  mobile: boolean;
  /** `navigator.deviceMemory` in GB, where supported. */
  deviceMemory?: number;
  hardwareConcurrency?: number;
}

interface Rule {
  pattern: RegExp;
  tier: QualityTier;
  name: string;
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|microsoft basic render|mesa offscreen/i;

const DESKTOP_RULES: readonly Rule[] = [
  { pattern: /rtx|quadro|radeon (rx )?[5-9]\d{3}|radeon pro|apple m\d|geforce gtx (10[6-8]0|16\d0)|intel.*arc|nvidia.*a\d{3,4}/i, tier: 3, name: 'discrete or Apple silicon' },
  { pattern: /apple gpu/i, tier: 3, name: 'Apple GPU (desktop Safari)' },
  { pattern: /iris.*xe|radeon.*(graphics|vega)|geforce (mx|gtx|gt)/i, tier: 2, name: 'recent integrated or older discrete' },
  { pattern: /intel.*(hd|uhd|iris)/i, tier: 1, name: 'Intel integrated' },
];

const MOBILE_RULES: readonly Rule[] = [
  { pattern: /apple gpu|apple a1[5-9]|adreno.*\b(7[3-9]\d|8\d\d)\b|mali-g(7[1-9]|[6-9]1\d)|immortalis|xclipse/i, tier: 2, name: 'current mobile' },
  { pattern: /adreno|mali|powervr|apple a\d/i, tier: 1, name: 'older mobile' },
];

function lower(tier: QualityTier, by: number): QualityTier {
  return Math.max(0, tier - by) as QualityTier;
}

export function classifyGPU(renderer: string, hints: DeviceHints): { tier: QualityTier; reason: string } {
  if (!renderer) return { tier: 1, reason: 'unknown renderer' };
  if (SOFTWARE.test(renderer)) return { tier: 0, reason: 'software renderer' };
  const rules = hints.mobile ? MOBILE_RULES : DESKTOP_RULES;
  const rule = rules.find((r) => r.pattern.test(renderer));
  let tier: QualityTier = rule ? rule.tier : hints.mobile ? 1 : 2;
  let reason = rule ? rule.name : hints.mobile ? 'unrecognised mobile GPU' : 'unrecognised desktop GPU';
  const constrained = (hints.deviceMemory !== undefined && hints.deviceMemory <= 2) || (hints.hardwareConcurrency !== undefined && hints.hardwareConcurrency <= 2);
  if (constrained && tier > 0) {
    tier = lower(tier, 1);
    reason += ', low memory or few cores';
  }
  return { tier, reason };
}

function deviceHints(): DeviceHints {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return { mobile: device.mobile, deviceMemory: nav.deviceMemory, hardwareConcurrency: nav.hardwareConcurrency };
}

/** Reads the renderer string from `gl`, or from a throwaway context that is released afterwards. */
export function detectGPU(gl?: WebGL2RenderingContext | WebGLRenderingContext): GPUInfo {
  const hints = deviceHints();
  let context: WebGL2RenderingContext | WebGLRenderingContext | null = gl ?? null;
  const owned = !gl;
  if (!context) {
    const canvas = document.createElement('canvas');
    context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  }
  if (!context) return { renderer: '', vendor: '', tier: 0, reason: 'WebGL unavailable', mobile: hints.mobile, webgl2: false };
  const debug = context.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : context.RENDERER) ?? '');
  const vendor = String(context.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : context.VENDOR) ?? '');
  const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && context instanceof WebGL2RenderingContext;
  if (owned) context.getExtension('WEBGL_lose_context')?.loseContext();
  const { tier, reason } = classifyGPU(renderer, hints);
  return { renderer, vendor, tier: webgl2 ? tier : (Math.min(tier, 1) as QualityTier), reason: webgl2 ? reason : `${reason}, WebGL 1 only`, mobile: hints.mobile, webgl2 };
}
