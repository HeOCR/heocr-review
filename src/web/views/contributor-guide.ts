import type { CaptureMode, PrintCapture } from "../../shared/contributor";
import { bdi, h } from "../dom";
import { t, type StringKey } from "../i18n";

type Illustration = CaptureMode | "print" | "form" | "copy" | "check" | "upload";
type Step = { title: StringKey; instruction: StringKey; illustration: Illustration; content?: readonly Node[]; current?: boolean };

function illustrate(kind: Illustration) {
  return h("div", { class: `guide-art guide-art-${kind}`, "aria-hidden": "true" },
    h("div", { class: "guide-paper" }), h("div", { class: "guide-detail" }));
}

const captureInstructions = {
  flat: "cg_flat", angle: "cg_angle", shadow: "cg_shadow", crumpled: "cg_crumpled",
  scribbled: "cg_scribbled", folded: "cg_folded",
} as const satisfies Record<CaptureMode, StringKey>;

const captureTitles = {
  flat: "cg_variant_flat", angle: "cg_variant_angle", folded: "cg_variant_folded",
  crumpled: "cg_variant_crumpled", scribbled: "cg_variant_scribbled", shadow: "cg_variant_shadow",
} as const satisfies Record<CaptureMode, StringKey>;

function guide(steps: Step[]) {
  return h("ol", { class: "contributor-guide", role: "list" }, ...steps.map((step, index) =>
    h("li", { class: "guide-step", "aria-current": step.current ? "step" : undefined }, illustrate(step.illustration),
      h("div", { class: "guide-instructions" },
        h("h3", {}, h("span", { "aria-hidden": "true" }, bdi(String(index + 1), "ltr")), t(step.title)),
        h("p", {}, t(step.instruction)), ...(step.content ?? [])))));
}

export function captureGuide(mode: CaptureMode, preparation: Step[], upload: HTMLElement) {
  return guide([...preparation,
    { title: "cg_photo_h", instruction: captureInstructions[mode], illustration: mode,
      content: [h("p", {}, t("cg_photo_p"))] },
    { title: "cg_check_h", instruction: "cg_check_p", illustration: "check" },
    { title: "cg_upload_h", instruction: "cg_upload_p", illustration: "upload", content: [upload] },
  ]);
}

export function printSequenceGuide(task: PrintCapture, download: HTMLElement, upload: HTMLElement, skip?: HTMLElement) {
  const kids = task.variant === "kids";
  const captures: Step[] = task.captureSteps!.map(({ mode, saved }) => {
    const current = task.mode === mode;
    return { title: captureTitles[mode], instruction: captureInstructions[mode], illustration: mode, current,
      content: current ? [
        ...(kids ? [h("p", {}, t("cg_kids_check_p"))] : []),
        h("p", {}, t("cg_upload_p")), upload, ...(skip ? [skip] : []),
      ]
        : saved ? [h("p", { class: "small" }, t("cg_variant_saved"))] : [] };
  });
  return guide([{ title: "cg_print_h", instruction: "cg_print_p", illustration: "print",
    content: [download, ...(kids ? [h("p", {}, t("cg_kids_print_p"))] : []),
      h("p", {}, t("cg_sequence_intro")), h("p", {}, t("cg_photo_p")), h("p", {}, t("cg_check_p"))] }, ...captures]);
}
