import gsap from "gsap";
import { SplitText } from "gsap/SplitText";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP, SplitText);
// 2D transforms only: force3D's GPU layer, dropped when the tween ends, re-rasterizes text and flashes it.
// Reveals share one fast curve: expo.out lands most of the move in the first third, so 0.5s reads as snappy.
gsap.defaults({ force3D: false, ease: "expo.out", duration: 0.5 });
// Reveals run only when motion is welcome; otherwise everything renders in its final state.
export const MOTION = "(prefers-reduced-motion: no-preference)";
// Reveals tween only translate and opacity, then clear them so CSS hovers own the element.
export const CLEAN = "opacity,transform";

export { gsap, SplitText, useGSAP };
