import type { CaptureMode } from "../../shared/contributor";
import { bdi, h } from "../dom";
import { t, type StringKey } from "../i18n";

type Illustration = CaptureMode | "print" | "form" | "copy" | "check" | "upload";
type Step = { title: StringKey; instruction: StringKey; illustration: Illustration; content?: readonly Node[] };

function illustrate(kind: Illustration) {
  return h("div", { class: `guide-art guide-art-${kind}`, "aria-hidden": "true" },
    h("div", { class: "guide-paper" }), h("div", { class: "guide-detail" }));
}

const captureInstructions = {
  flat: "cg_flat", angle: "cg_angle", shadow: "cg_shadow", crumpled: "cg_crumpled",
  scribbled: "cg_scribbled", folded: "cg_folded",
} as const satisfies Record<CaptureMode, StringKey>;

export function captureGuide(mode: CaptureMode, preparation: Step[], upload: HTMLElement) {
  const steps: Step[] = [...preparation,
    { title: "cg_photo_h", instruction: captureInstructions[mode], illustration: mode,
      content: [h("p", {}, t("cg_photo_p"))] },
    { title: "cg_check_h", instruction: "cg_check_p", illustration: "check" },
    { title: "cg_upload_h", instruction: "cg_upload_p", illustration: "upload", content: [upload] },
  ];
  return h("ol", { class: "contributor-guide", role: "list" }, ...steps.map((step, index) =>
    h("li", { class: "guide-step" }, illustrate(step.illustration),
      h("div", { class: "guide-instructions" },
        h("h3", {}, h("span", { "aria-hidden": "true" }, bdi(String(index + 1), "ltr")), t(step.title)),
        h("p", {}, t(step.instruction)), ...(step.content ?? [])))));
}
