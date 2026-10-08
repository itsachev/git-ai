import gsap from "gsap";
import { SplitText } from "gsap/SplitText";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP, SplitText);
// 2D transforms only: force3D's GPU layer, dropped when the tween ends, re-rasterizes text and flashes it.
gsap.defaults({ force3D: false });
// Reveals run only when motion is welcome; otherwise everything renders in its final state.
export const MOTION = "(prefers-reduced-motion: no-preference)";
// Reveals tween only translate and opacity, then clear them so CSS hovers own the element.
export const CLEAN = "opacity,transform";

export { gsap, SplitText, useGSAP };
